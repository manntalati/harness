import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { World } from "../src/world/world.js";
import { prepareEmailTask, dispatchEmail, pollEmailReplies } from "../src/agents/email.js";
import { setMailTransport, extractReply, MailTransport, IncomingMail } from "../src/agents/mailer.js";

const settle = () => new Promise((r) => setTimeout(r, 30));
async function fixture(fn: (w: World) => Promise<void>) {
  const home = await mkdtemp(join(tmpdir(), "harness-auto-"));
  const w = await World.load(home, "test");
  try { await fn(w); } finally { setMailTransport(undefined); await new Promise((r) => setTimeout(r, 850)); await w.flush(); await rm(home, { recursive: true, force: true }); }
}
function fake() {
  const sent: { to: string; subject: string; body: string }[] = [];
  const inbox: IncomingMail[] = [];
  const t: MailTransport = {
    async send(m) { sent.push(m); return { messageId: `<out-${sent.length}@x>` }; },
    async fetchReplies() { return inbox; },
  };
  return { t, sent, inbox };
}
const mk = (w: World) => {
  const agent = w.createAgent({ name: "Instinct", role: "ext", zoneId: w.data.zones[0].id, email: "bot@example.com" });
  return { agent, task: w.createTask({ title: "Do X", description: "details", assigneeId: agent.id, zoneId: agent.zoneId, createdBy: "user" }) };
};

test("auto-sends once, then completes from an authenticated reply", () => fixture(async (w) => {
  const f = fake(); setMailTransport(f.t);
  const { task } = mk(w); prepareEmailTask(w, task); await settle();
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].to, "bot@example.com");
  assert.ok(task.emailHandoff?.sentAt);
  await dispatchEmail(w, task.id); assert.equal(f.sent.length, 1);
  const ref = `Re: [Harness ${task.id} v1] Do X`;
  const base = { messageId: "<r1@x>", subject: ref, text: "Done: answer 42\n\nOn Mon, Bot wrote:\n> old", date: new Date(Date.now() + 1000).toISOString() };
  f.inbox.push({ ...base, from: "evil@example.com", authenticated: true });
  f.inbox.push({ ...base, from: "bot@example.com", authenticated: false });
  f.inbox.push({ ...base, from: "bot@example.com", authenticated: true, subject: "Re: [Harness task_deadbeef00 v1] Do X" });
  await pollEmailReplies(w, true); assert.equal(task.status, "in_progress");
  f.inbox.push({ ...base, from: "Bot@Example.com".toLowerCase(), authenticated: true });
  await pollEmailReplies(w, true);
  assert.equal(task.status, "done");
  assert.equal(task.result, "Done: answer 42");
  assert.ok(w.data.inbox.some((i) => i.kind === "task_result" && i.taskId === task.id));
}));

test("send failure falls back to manual and does not retry", () => fixture(async (w) => {
  const f = fake(); f.t.send = async () => { throw new Error("auth failed"); }; setMailTransport(f.t);
  const { task } = mk(w); prepareEmailTask(w, task); await settle();
  assert.equal(task.emailHandoff?.sendError, "auth failed");
  assert.equal(task.status, "in_progress");
  await pollEmailReplies(w, true); assert.equal(task.emailHandoff?.sendError, "auth failed");
}));

test("extractReply strips quoted history", () => {
  assert.equal(extractReply("Hi\nresult\n> quoted\nOn Tue, X wrote:\n> more"), "Hi\nresult");
});
