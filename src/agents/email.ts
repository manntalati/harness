import { World } from "../world/world.js";
import { Task } from "../world/types.js";
import { deliverResult } from "./runtime.js";
import { getMailTransport, extractReply } from "./mailer.js";

const REF = /\[Harness (task_[0-9a-f]+) v(\d+)\]/;
const POLL_MS = 30_000;
const TIMEOUT_MS = 3 * 24 * 3600_000;
let lastPoll = 0;
let polling = false;

/**
 * Prepares the task email. When a mail transport is configured (see mailer.ts)
 * it is sent automatically and the reply is picked up by pollEmailReplies.
 * Without credentials it falls back to the manual review/send flow.
 */
export function prepareEmailTask(world: World, task: Task): void {
  const agent = world.agent(task.assigneeId);
  if (!agent?.email || task.status !== "queued") return;
  const subject = `[Harness ${task.id} v${task.iteration}] ${task.title}`;
  const body = [
    `Task reference: ${task.id}, iteration ${task.iteration}`,
    `Title: ${task.title}`,
    task.description,
    task.previousResult ? `Previous result: ${task.previousResult}` : "",
    task.feedback ? `Feedback: ${task.feedback}` : "",
    "Please return the task reference and your result or any questions in your reply.",
  ].filter(Boolean).join("\n\n");
  world.updateTask(task.id, {
    status: "in_progress", startedAt: new Date().toISOString(),
    emailHandoff: { to: agent.email, subject, body, preparedAt: new Date().toISOString() },
  });
  if (getMailTransport()) { void dispatchEmail(world, task.id); return; }
  world.addInbox({ kind: "question", agentId: agent.id, taskId: task.id,
    title: `Review email handoff: ${task.title}`,
    body: "Open this task in the task board to review and send its email. Nothing has been sent. Email is not an authenticated command channel; the recipient may need confirmation in your trusted conversation. Record the returned result on the task when ready.",
  });
  world.addAction(agent.id, "info", `Email prepared for review: ${task.title} (not sent)`);
}

/** Sends a prepared handoff once. sendingAt is saved first so a crash never causes a second send. */
export async function dispatchEmail(world: World, taskId: string): Promise<void> {
  const transport = getMailTransport();
  const task = world.task(taskId);
  const h = task?.emailHandoff;
  if (!transport || !task || !h || h.sentAt || h.sendingAt) return;
  const agent = world.agent(task.assigneeId);
  world.updateTask(task.id, { emailHandoff: { ...h, sendingAt: new Date().toISOString() } });
  try {
    const { messageId } = await transport.send({ to: h.to, subject: h.subject, body: h.body });
    world.updateTask(task.id, { emailHandoff: { ...world.task(task.id)!.emailHandoff!, sentAt: new Date().toISOString(), messageId, sendError: undefined } });
    if (agent) world.addAction(agent.id, "info", `Email sent automatically: ${task.title}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    world.updateTask(task.id, { emailHandoff: { ...world.task(task.id)!.emailHandoff!, sendingAt: undefined, sendError: msg.slice(0, 300) } });
    if (agent) world.addInbox({ kind: "question", agentId: agent.id, taskId: task.id, title: `Email send failed: ${task.title}`,
      body: `The email could not be sent (${msg.slice(0, 300)}). Check HARNESS_MAIL_USER / HARNESS_MAIL_APP_PASSWORD. It will not retry on its own; send it manually from the task board.` });
  }
}

/**
 * Reads the mailbox for replies to sent handoffs and completes matching tasks.
 * A reply counts only if it is from the agent's configured address, carries the
 * task reference and iteration, and passes sender authentication. Reply text is
 * stored as the task result and is never treated as an instruction.
 */
export async function pollEmailReplies(world: World, force = false): Promise<void> {
  const transport = getMailTransport();
  if (!transport || polling || (!force && Date.now() - lastPoll < POLL_MS)) return;
  polling = true; lastPoll = Date.now();
  try {
    const waiting = world.data.tasks.filter((t) => t.status === "in_progress" && t.emailHandoff);
    for (const task of waiting) {
      const h = task.emailHandoff!;
      if (!h.sentAt) {
        if (!h.sendingAt && !h.sendError) await dispatchEmail(world, task.id);
        else if (h.sendingAt && !h.sendError && Date.now() - new Date(h.sendingAt).getTime() > 120_000) {
          world.updateTask(task.id, { emailHandoff: { ...h, sendError: "Sending was interrupted and may or may not have gone out. Check your Sent folder before sending manually." } });
        }
        continue;
      }
      const agent = world.agent(task.assigneeId);
      if (!agent?.email) continue;
      const since = new Date(new Date(h.sentAt).getTime() - 3600_000);
      let mails;
      try { mails = await transport.fetchReplies(agent.email, `[Harness ${task.id} v${task.iteration}]`, since); }
      catch (err) { world.addAction(agent.id, "info", `Mailbox check failed: ${(err instanceof Error ? err.message : String(err)).slice(0, 120)}`); break; }
      const reply = mails.find((m) => {
        const ref = REF.exec(m.subject);
        return m.from === agent.email!.toLowerCase() && m.authenticated && ref?.[1] === task.id && Number(ref[2]) === task.iteration
          && new Date(m.date).getTime() >= new Date(h.sentAt!).getTime() && m.messageId !== h.messageId;
      });
      if (reply) {
        const text = extractReply(reply.text);
        if (text) { world.updateTask(task.id, { emailHandoff: { ...h, replyMessageId: reply.messageId } }); recordEmailResult(world, world.task(task.id)!, text, true); continue; }
      }
      if (Date.now() - new Date(h.sentAt).getTime() > TIMEOUT_MS && !h.timeoutNotified) {
        world.updateTask(task.id, { emailHandoff: { ...h, timeoutNotified: true } });
        world.addInbox({ kind: "question", agentId: agent.id, taskId: task.id, title: `No reply yet: ${task.title}`,
          body: "No authenticated reply has arrived after 3 days. The task is still waiting; you can record a result manually or cancel it." });
      }
    }
  } finally { polling = false; }
}

export function recordEmailResult(world: World, task: Task, result: string, auto = false): void {
  const agent = world.agent(task.assigneeId);
  if (!agent || !task.emailHandoff || task.status !== "in_progress") throw new Error("Task is not awaiting an email result");
  const summary = result.split("\n").find((line) => line.trim())?.slice(0, 200) ?? "Result recorded";
  world.updateTask(task.id, { status: "done", result, summary, completedAt: new Date().toISOString(),
    nextRunAt: task.repeatEveryMinutes ? new Date(Date.now() + task.repeatEveryMinutes * 60_000).toISOString() : undefined });
  agent.stats.tasksDone++;
  world.setAgentState(agent.id, { status: agent.status, activity: "done" });
  deliverResult(world, agent, task, `${auto ? "Reply received by email" : "Result recorded by user"} for "${task.title}":\n\n${result}`, { summary, result }, false);
}
