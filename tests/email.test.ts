import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { World } from "../src/world/world.js";
import { Scheduler } from "../src/world/scheduler.js";
import { callMethod } from "../src/api/methods.js";
import { prepareEmailTask, recordEmailResult } from "../src/agents/email.js";
import { setMailTransport } from "../src/agents/mailer.js";

// These cover the flow with no email account connected.
setMailTransport(null);

const env = { hasCredentials: false, claudeBin: "missing", claudeVersion: null, home: "", bridgeBase: null };
const settle = () => new Promise((resolve) => setTimeout(resolve, 30));
async function fixture(fn: (world: World, home: string) => Promise<void>) {
  const home = await mkdtemp(join(tmpdir(), "harness-email-"));
  const world = await World.load(home, "test");
  try { await fn(world, home); } finally { await new Promise((r) => setTimeout(r, 850)); await world.flush(); await rm(home, { recursive: true, force: true }); }
}

test("external task prepares once without a model and survives restart", () => fixture(async (w, home) => {
  const agent = w.createAgent({ name: "Instinct", role: "External assistant", zoneId: w.data.zones[0].id, email: "assistant@example.com" });
  const scheduler = new Scheduler(w, env);
  const ctx = { world: w, scheduler };
  const task = w.createTask({ title: "Research A & B", description: "Line 1\nLine 2", assigneeId: agent.id, zoneId: agent.zoneId, createdBy: "user" });
  await settle();
  assert.equal(task.status, "in_progress");
  assert.equal(task.emailHandoff?.to, agent.email);
  assert.match(task.emailHandoff!.subject, new RegExp(task.id));
  assert.match(task.emailHandoff!.body, /Line 1\nLine 2/);
  assert.equal(agent.stats.activations, 0);
  const count = w.data.inbox.length;
  scheduler.poke(); await settle();
  assert.equal(w.data.inbox.length, count);
  await w.flush();
  const restored = await World.load(home, "test");
  assert.equal(restored.task(task.id)?.status, "in_progress");
  assert.deepEqual(restored.task(task.id)?.emailHandoff, task.emailHandoff);
  await restored.flush();
  await callMethod(ctx, "record_email_result", { task_id: task.id, result: "Result reviewed by owner" });
  assert.equal(task.status, "done");
  assert.equal(agent.stats.tasksDone, 1);
  assert.ok(w.data.inbox.some((i) => i.kind === "task_result" && i.taskId === task.id));
  await assert.rejects(callMethod(ctx, "record_email_result", { task_id: task.id, result: "duplicate" }), /not awaiting/);
  scheduler.stop();
}));

test("pause, cancellation, validation and explicit assignment boundaries", () => fixture(async (w) => {
  const scheduler = new Scheduler(w, env);
  const ctx = { world: w, scheduler };
  await assert.rejects(callMethod(ctx, "create_agent", { name: "Bad", area: w.data.zones[0].id, email: "bad\naddress" }), /Invalid/);
  const agent = w.createAgent({ name: "External", role: "External assistant", zoneId: w.data.zones[0].id, email: "assistant@example.com" });
  w.setAgentPaused(agent.id, true);
  const t = w.createTask({ title: "Paused", zoneId: agent.zoneId, assigneeId: agent.id, createdBy: "user" });
  await settle(); assert.equal(t.status, "queued"); assert.equal(t.emailHandoff, undefined);
  w.setAgentPaused(agent.id, false); await settle(); assert.ok(t.emailHandoff);
  await callMethod(ctx, "cancel_task", { task_id: t.id });
  assert.throws(() => recordEmailResult(w, t, "late result"), /not awaiting/);
  const unclaimed = w.createTask({ title: "Area task", zoneId: agent.zoneId, createdBy: "user" });
  await settle(); assert.notEqual(unclaimed.assigneeId, agent.id);
  scheduler.stop();
}));

test("delegated results notify their requester; recurring handoffs get new review", () => fixture(async (w) => {
  const agent = w.createAgent({ name: "External", role: "External assistant", zoneId: w.data.zones[0].id, email: "assistant@example.com" });
  const requester = w.data.agents[0];
  const t = w.createTask({ title: "Delegated", zoneId: agent.zoneId, assigneeId: agent.id, createdBy: requester.id, repeatEveryMinutes: 5 });
  prepareEmailTask(w, t); recordEmailResult(w, t, "Reviewed result");
  assert.ok(w.data.messages.some((m) => m.to === requester.id && m.kind === "task_result" && m.taskId === t.id));
  assert.ok(t.nextRunAt);
  // The recurring scheduler clears the prior handoff before preparing the next iteration.
  const scheduler = new Scheduler(w, env);
  w.updateTask(t.id, { nextRunAt: new Date(0).toISOString() });
  (scheduler as any).requeueRecurring(); await settle();
  assert.equal(t.iteration, 2);
  assert.equal(t.status, "in_progress");
  assert.match(t.emailHandoff!.subject, /v2/);
  scheduler.stop();
}));
