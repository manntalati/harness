import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { World } from "../src/world/world.js";
import { Scheduler } from "../src/world/scheduler.js";
import { prepareEmailTask, dispatchEmail, pollEmailReplies, retryEmailNow } from "../src/agents/email.js";
import { setMailTransport, extractReply, MailTransport, IncomingMail, MailAuthError } from "../src/agents/mailer.js";

const env = { hasCredentials: false, claudeBin: "missing", claudeVersion: null, home: "", bridgeBase: null };
const settle = () => new Promise((r) => setTimeout(r, 30));
async function fixture(fn: (w: World) => Promise<void>) {
  const home = await mkdtemp(join(tmpdir(), "harness-auto-"));
  const w = await World.load(home, "test");
  try { await fn(w); } finally { setMailTransport(undefined); await new Promise((r) => setTimeout(r, 850)); await w.flush(); await rm(home, { recursive: true, force: true }); }
}
function fake() {
  const sent: { to: string; subject: string; body: string }[] = [];
  const inbox: IncomingMail[] = [];
  const sentFolder: string[] = [];
  const t: MailTransport = {
    async send(m) { sent.push(m); sentFolder.push(m.subject); return { messageId: `<out-${sent.length}@x>` }; },
    async fetchReplies() { return inbox; },
    async findSent(tag) { return sentFolder.some((s) => s.includes(tag)) ? "<found@x>" : null; },
  };
  return { t, sent, inbox, sentFolder };
}
const mk = (w: World) => {
  const agent = w.createAgent({ name: "Instinct", role: "ext", zoneId: w.data.zones[0].id, email: "bot@example.com" });
  return { agent, task: w.createTask({ title: "Do X", description: "details", assigneeId: agent.id, zoneId: agent.zoneId, createdBy: "user" }) };
};
const reply = (subject: string, text: string, extra: Partial<IncomingMail> = {}): IncomingMail => ({
  messageId: `<r-${Math.random()}@x>`, subject, text, date: new Date(Date.now() + 1000).toISOString(), from: "bot@example.com", authenticated: true, ...extra,
});

test("auto-sends once, then completes from an authenticated reply", () => fixture(async (w) => {
  const f = fake(); setMailTransport(f.t);
  const { task } = mk(w); prepareEmailTask(w, task); await settle();
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].to, "bot@example.com");
  assert.ok(task.emailHandoff?.sentAt);
  await dispatchEmail(w, task.id); assert.equal(f.sent.length, 1);
  const ref = `Re: [Harness ${task.id} v1] Do X`;
  const text = "Done: answer 42\n\nOn Mon, Bot wrote:\n> old";
  f.inbox.push(reply(ref, text, { from: "evil@example.com" }));
  f.inbox.push(reply(ref, text, { authenticated: false }));
  f.inbox.push(reply("Re: [Harness task_deadbeef00 v1] Do X", text));
  await pollEmailReplies(w, true); assert.equal(task.status, "in_progress");
  f.inbox.push(reply(ref, text));
  await pollEmailReplies(w, true);
  assert.equal(task.status, "done");
  assert.equal(task.result, "Done: answer 42");
  assert.ok(w.data.inbox.some((i) => i.kind === "task_result" && i.taskId === task.id));
}));

test("tasks prepared before an account is connected go out once it is", () => fixture(async (w) => {
  setMailTransport(null);
  const { task } = mk(w); prepareEmailTask(w, task); await settle();
  assert.equal(task.emailHandoff?.sentAt, undefined);
  assert.ok(w.data.inbox.some((i) => /Connect email/.test(i.title)));
  const f = fake(); setMailTransport(f.t);
  await pollEmailReplies(w, true);
  assert.equal(f.sent.length, 1);
  assert.ok(task.emailHandoff?.sentAt);
}));

test("a temporary send failure retries on its own after a backoff", () => fixture(async (w) => {
  const f = fake(); let fail = true;
  const send = f.t.send; f.t.send = async (m) => { if (fail) throw new Error("connection reset"); return send(m); };
  setMailTransport(f.t);
  const { task } = mk(w); prepareEmailTask(w, task); await settle();
  assert.equal(task.emailHandoff?.sendError, "connection reset");
  assert.ok(task.emailHandoff?.retryAt);
  assert.equal(task.emailHandoff?.attempts, 1);
  await pollEmailReplies(w, true); assert.equal(f.sent.length, 0, "not before the retry time");
  fail = false;
  w.updateTask(task.id, { emailHandoff: { ...task.emailHandoff!, retryAt: new Date(Date.now() - 1000).toISOString() } });
  await pollEmailReplies(w, true);
  assert.equal(f.sent.length, 1);
  assert.ok(task.emailHandoff?.sentAt);
  assert.equal(task.emailHandoff?.sendError, undefined);
}));

test("a rejected login waits for the account to change, then sends", () => fixture(async (w) => {
  const bad = fake(); bad.t.send = async () => { throw new MailAuthError("login rejected"); };
  setMailTransport(bad.t);
  const { task } = mk(w); prepareEmailTask(w, task); await settle();
  assert.equal(task.emailHandoff?.retryAt, undefined);
  assert.notEqual(task.emailHandoff?.authFailedVersion, undefined);
  assert.ok(w.data.inbox.some((i) => /login rejected/i.test(i.title)));
  await pollEmailReplies(w, true); assert.equal(task.emailHandoff?.sentAt, undefined);
  const good = fake(); setMailTransport(good.t); // reconnecting bumps the account version
  await pollEmailReplies(w, true);
  assert.equal(good.sent.length, 1);
  assert.ok(task.emailHandoff?.sentAt);
}));

test("an interrupted send is checked against the Sent folder instead of being repeated", () => fixture(async (w) => {
  const f = fake(); setMailTransport(f.t);
  const { agent } = mk(w);
  const a = w.createTask({ title: "Went out", assigneeId: agent.id, zoneId: agent.zoneId, createdBy: "user" });
  const b = w.createTask({ title: "Did not", assigneeId: agent.id, zoneId: agent.zoneId, createdBy: "user" });
  setMailTransport(null); prepareEmailTask(w, a); prepareEmailTask(w, b); setMailTransport(f.t);
  const longAgo = new Date(Date.now() - 10 * 60_000).toISOString();
  w.updateTask(a.id, { emailHandoff: { ...a.emailHandoff!, sendingAt: longAgo } });
  w.updateTask(b.id, { emailHandoff: { ...b.emailHandoff!, sendingAt: longAgo } });
  f.sentFolder.push(a.emailHandoff!.subject);
  await pollEmailReplies(w, true);
  assert.ok(a.emailHandoff?.sentAt);
  assert.ok(b.emailHandoff?.sentAt);
  assert.deepEqual(f.sent.map((m) => m.subject), [b.emailHandoff!.subject], "only the one missing from Sent is sent");
}));

test("Send now and the daily limit", () => fixture(async (w) => {
  const f = fake(); setMailTransport(f.t);
  w.updateSettings({ maxEmailsPerDay: 1 });
  const { agent, task } = mk(w); prepareEmailTask(w, task); await settle();
  const second = w.createTask({ title: "Second", assigneeId: agent.id, zoneId: agent.zoneId, createdBy: "user" });
  prepareEmailTask(w, second); await settle();
  assert.equal(f.sent.length, 1);
  assert.match(second.emailHandoff!.sendError!, /Daily email limit/);
  assert.ok(second.emailHandoff!.retryAt);
  w.updateSettings({ maxEmailsPerDay: 5 });
  await retryEmailNow(w, second);
  assert.equal(f.sent.length, 2);
  await assert.rejects(retryEmailNow(w, second), /already sent/);
}));

test("messages to an email agent are emailed, and the reply comes back to the sender", () => fixture(async (w) => {
  const f = fake(); setMailTransport(f.t);
  const agent = w.createAgent({ name: "Instinct", role: "ext", zoneId: w.data.zones[0].id, email: "bot@example.com" });
  const mira = w.data.agents[0];
  const scheduler = new Scheduler(w, env);
  w.sendMessage({ from: mira.id, to: agent.id, content: "Can you check the Q3 numbers?", hops: 1 });
  scheduler.poke(); await settle(); scheduler.poke(); await settle();
  const task = w.data.tasks.find((t) => t.assigneeId === agent.id && t.replyAsMessage);
  assert.ok(task, "message became an emailed task");
  assert.equal(f.sent.length, 1);
  assert.match(f.sent[0].body, /Q3 numbers/);
  f.inbox.push(reply(`Re: ${task!.emailHandoff!.subject}`, "Numbers look fine."));
  await pollEmailReplies(w, true);
  const back = w.data.messages.find((m) => m.from === agent.id && m.to === mira.id);
  assert.ok(back);
  assert.equal(back!.kind, "chat");
  assert.equal(back!.hops, 2, "the reply counts toward the conversation-depth limit");
  w.sendMessage({ from: mira.id, to: "all", content: "Team standup", hops: 0 });
  scheduler.poke(); await settle();
  assert.equal(f.sent.length, 1, "broadcasts aren't emailed");
  scheduler.stop();
}));

test("extractReply strips quoted history", () => {
  assert.equal(extractReply("Hi\nresult\n> quoted\nOn Tue, X wrote:\n> more"), "Hi\nresult");
});
