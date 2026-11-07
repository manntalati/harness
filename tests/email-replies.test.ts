import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { World } from "../src/world/world.js";
import { acceptPendingReply, dismissPendingReply, pollEmailReplies, prepareEmailTask, syncEmailAgents } from "../src/agents/email.js";
import { IncomingMail, MailTransport, setMailTransport } from "../src/agents/mailer.js";

const settle = () => new Promise((r) => setTimeout(r, 30));
async function fixture(fn: (w: World, f: ReturnType<typeof fake>) => Promise<void>) {
  const home = await mkdtemp(join(tmpdir(), "harness-replies-"));
  const w = await World.load(home, "test");
  const f = fake();
  setMailTransport(f.t);
  try { await fn(w, f); } finally { setMailTransport(undefined); await new Promise((r) => setTimeout(r, 850)); await w.flush(); await rm(home, { recursive: true, force: true }); }
}
function fake() {
  const inbox: IncomingMail[] = [];
  let n = 0;
  const t: MailTransport = {
    async send() { n++; return { messageId: `<out-${n}@me>` }; },
    async fetchReplies() { return inbox; },
    async findSent() { return null; },
  };
  return { t, inbox };
}
let seq = 0;
const mail = (extra: Partial<IncomingMail>): IncomingMail => ({
  messageId: `<in-${++seq}@x>`, from: "bot@example.com", subject: "", text: "Here you go.", date: new Date(Date.now() + 1000).toISOString(), authenticated: true, ...extra,
});
async function sentTask(w: World, title = "Find companies") {
  const agent = w.data.agents.find((a) => a.email) ?? w.createAgent({ name: "Instinct", role: "ext", zoneId: w.data.zones[0].id, email: "bot@example.com" });
  const task = w.createTask({ title, assigneeId: agent.id, zoneId: agent.zoneId, createdBy: "user" });
  prepareEmailTask(w, task); await settle();
  assert.ok(task.emailHandoff?.sentAt);
  return { agent, task };
}

test("an external agent shows as working while its emails are out, and goes idle when done", () => fixture(async (w, f) => {
  const { agent, task } = await sentTask(w);
  syncEmailAgents(w);
  assert.equal(agent.status, "working");
  assert.equal(agent.activity, "thinking");
  assert.equal(agent.focus?.taskId, task.id);
  assert.match(agent.activityDetail!, /Find companies/);
  f.inbox.push(mail({ subject: `Re: ${task.emailHandoff!.subject}` }));
  await pollEmailReplies(w, true);
  assert.equal(task.status, "done");
  syncEmailAgents(w);
  assert.equal(agent.status, "idle");
  assert.equal(agent.activity, "done");
  assert.ok(w.data.inbox.some((i) => i.kind === "task_result" && i.taskId === task.id), "the result reaches the inbox");
}));

test("a reply in the same thread counts even without the subject tag", () => fixture(async (w, f) => {
  const { task } = await sentTask(w);
  f.inbox.push(mail({ subject: "Your list", inReplyTo: [task.emailHandoff!.messageId!] }));
  await pollEmailReplies(w, true);
  assert.equal(task.status, "done");
  assert.equal(task.result, "Here you go.");
}));

test("a reply from another address is held for one click, and can be trusted from then on", () => fixture(async (w, f) => {
  const { agent, task } = await sentTask(w);
  f.inbox.push(mail({ from: "noreply@example.com", subject: `Re: ${task.emailHandoff!.subject}` }));
  await pollEmailReplies(w, true);
  assert.equal(task.status, "in_progress");
  assert.match(task.emailHandoff!.replyIssue!, /noreply@example.com/);
  const item = w.data.inbox.find((i) => i.reply);
  assert.ok(item, "the user is alerted");
  assert.deepEqual(item!.reply!.taskIds, [task.id]);
  syncEmailAgents(w);
  assert.equal(agent.activity, "reporting");
  await pollEmailReplies(w, true);
  assert.equal(w.data.inbox.filter((i) => i.reply).length, 1, "each email is handled once");
  acceptPendingReply(w, item!.reply!.id, task.id, true);
  assert.equal(task.status, "done");
  assert.deepEqual(agent.replyFrom, ["noreply@example.com"]);
  assert.ok(w.data.inbox.find((i) => i.id === item!.id)!.reply!.resolved);
  assert.throws(() => acceptPendingReply(w, item!.reply!.id, task.id, false), /already handled/);
  const next = (await sentTask(w, "Second")).task;
  f.inbox.push(mail({ from: "noreply@example.com", subject: `Re: ${next.emailHandoff!.subject}` }));
  await pollEmailReplies(w, true);
  assert.equal(next.status, "done", "trusted sender is accepted automatically");
}));

test("an unverified sender is never accepted on its own", () => fixture(async (w, f) => {
  const { task } = await sentTask(w);
  f.inbox.push(mail({ subject: `Re: ${task.emailHandoff!.subject}`, authenticated: false }));
  await pollEmailReplies(w, true);
  assert.equal(task.status, "in_progress");
  assert.match(task.emailHandoff!.replyIssue!, /verified/);
}));

test("other email from the agent still reaches the inbox", () => fixture(async (w, f) => {
  const { task } = await sentTask(w);
  f.inbox.push(mail({ subject: "Quick update", text: "Started on it, results tomorrow." }));
  await pollEmailReplies(w, true);
  assert.equal(task.status, "in_progress");
  const item = w.data.inbox.find((i) => i.reply);
  assert.ok(item);
  assert.match(item!.body, /results tomorrow/);
  assert.deepEqual(item!.reply!.taskIds, [task.id], "offered as a possible result for its open task");
  dismissPendingReply(w, item!.reply!.id);
  assert.equal(w.data.pendingReplies!.length, 0);
}));

test("work done for a teammate also shows up in the user's inbox", () => fixture(async (w, f) => {
  const agent = w.createAgent({ name: "Instinct", role: "ext", zoneId: w.data.zones[0].id, email: "bot@example.com" });
  const mira = w.data.agents[0];
  const task = w.createTask({ title: "Research leads", assigneeId: agent.id, zoneId: agent.zoneId, createdBy: mira.id });
  prepareEmailTask(w, task); await settle();
  f.inbox.push(mail({ subject: `Re: ${task.emailHandoff!.subject}`, text: "12 leads attached." }));
  await pollEmailReplies(w, true);
  assert.ok(w.data.messages.some((m) => m.to === mira.id && m.kind === "task_result"));
  const note = w.data.inbox.find((i) => i.taskId === task.id && i.kind === "task_result");
  assert.ok(note);
  assert.match(note!.title, /Instinct finished/);
}));
