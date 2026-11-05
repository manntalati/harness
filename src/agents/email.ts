import { World } from "../world/world.js";
import { Agent, Message, Task } from "../world/types.js";
import { deliverResult } from "./runtime.js";
import { MailAuthError, MailTransport, extractReply, getMailTransport, mailVersion } from "./mailer.js";

// External agents (e.g. Instinct) are reached by email. Once a mail account is
// connected the whole round trip is automatic: the task is emailed, failed sends
// retry, the Sent folder is checked before any re-send so nothing goes out twice,
// and authenticated replies are recorded as the result. Without an account the
// task waits (with a draft you can send yourself) and goes out as soon as one is
// connected.

const REF = /\[Harness (task_[0-9a-f]+) v(\d+)\]/;
const POLL_MS = 30_000;
const TIMEOUT_MS = 3 * 24 * 3600_000;
const DAY_MS = 24 * 3600_000;
/** Minutes to wait before each retry of a send that failed for a non-login reason. */
const RETRY_MINUTES = [1, 5, 15, 60, 180, 360];
/** A send still "in flight" after this long was interrupted; check the Sent folder to learn whether it went out. */
const INTERRUPTED_MS = 120_000;
let lastPoll = 0;
let polling = false;

type Handoff = NonNullable<Task["emailHandoff"]>;

const tagOf = (task: Task) => `[Harness ${task.id} v${task.iteration}]`;

function setHandoff(world: World, task: Task, patch: Partial<Handoff>): Handoff {
  const next = { ...world.task(task.id)!.emailHandoff!, ...patch };
  world.updateTask(task.id, { emailHandoff: next });
  return next;
}

function recentSends(world: World): string[] {
  const cutoff = Date.now() - DAY_MS;
  world.data.emailsSent = (world.data.emailsSent ?? []).filter((t) => new Date(t).getTime() > cutoff);
  return world.data.emailsSent;
}

/** Prepares the task email and, when a mail account is connected, sends it right away. */
export function prepareEmailTask(world: World, task: Task): void {
  const agent = world.agent(task.assigneeId);
  if (!agent?.email || task.status !== "queued") return;
  const subject = `${tagOf(task)} ${task.title}`;
  const body = [
    `Task reference: ${task.id}, iteration ${task.iteration}`,
    `Title: ${task.title}`,
    task.createdBy !== "user" ? `From: ${world.displayName(task.createdBy)} (${world.agent(task.createdBy)?.title ?? "teammate"})` : "",
    task.description,
    task.previousResult ? `Previous result: ${task.previousResult}` : "",
    task.feedback ? `Feedback: ${task.feedback}` : "",
    "Please reply to this email (keep the subject line) with your result or any questions.",
  ].filter(Boolean).join("\n\n");
  world.updateTask(task.id, {
    status: "in_progress",
    startedAt: new Date().toISOString(),
    emailHandoff: { to: agent.email, subject, body, preparedAt: new Date().toISOString() },
  });
  if (getMailTransport()) {
    void dispatchEmail(world, task.id);
    return;
  }
  world.addAction(agent.id, "info", `Email ready for ${agent.email}, waiting for an email account to send from: ${task.title}`);
  const title = `Connect email so ${agent.name} gets tasks automatically`;
  if (!world.data.inbox.some((i) => i.title === title && !i.read && !i.archived)) {
    world.addInbox({
      kind: "question",
      agentId: agent.id,
      taskId: task.id,
      title,
      body: `${agent.name} works over email, but no email account is connected, so its tasks are waiting instead of going out. Open **Settings → Email** and connect the account to send from (for Gmail, an app password). Everything waiting is then sent automatically and replies come back as results on their own.`,
      priority: "high",
    });
  }
}

/** Sends a prepared handoff. `sendingAt` is saved first, so a crash mid-send is caught and checked, not blindly repeated. */
export async function dispatchEmail(world: World, taskId: string): Promise<void> {
  const transport = getMailTransport();
  const task = world.task(taskId);
  const h = task?.emailHandoff;
  if (!transport || !task || !h || h.sentAt || h.sendingAt || task.status !== "in_progress") return;
  const agent = world.agent(task.assigneeId);

  const cap = world.data.settings.maxEmailsPerDay;
  const sends = recentSends(world);
  if (sends.length >= cap) {
    const retryAt = new Date(new Date(sends[0]).getTime() + DAY_MS).toISOString();
    if (h.retryAt !== retryAt) {
      setHandoff(world, task, { sendError: `Daily email limit reached (${cap}).`, retryAt, authFailedVersion: undefined });
      world.log("system", `Email limit reached (${cap} per day); "${task.title}" goes out at ${new Date(retryAt).toLocaleTimeString()}. Raise it in Settings if this is expected.`);
    }
    return;
  }

  setHandoff(world, task, { sendingAt: new Date().toISOString(), sendError: undefined, retryAt: undefined, authFailedVersion: undefined });
  try {
    const { messageId } = await transport.send({ to: h.to, subject: h.subject, body: h.body });
    const sentAt = new Date().toISOString();
    setHandoff(world, task, { sentAt, messageId, sendingAt: undefined });
    recentSends(world).push(sentAt);
    if (agent) {
      world.addAction(agent.id, "info", `Emailed to ${h.to}: ${task.title}`);
      world.log("message", `Emailed ${agent.name}: ${task.title}`, { agentId: task.createdBy === "user" ? undefined : task.createdBy, targetAgentId: agent.id });
    }
  } catch (err) {
    const message = (err instanceof Error ? err.message : String(err)).slice(0, 300);
    const attempts = (h.attempts ?? 0) + 1;
    const loginProblem = err instanceof MailAuthError;
    const giveUp = !loginProblem && attempts > RETRY_MINUTES.length;
    const retryAt = loginProblem || giveUp ? undefined : new Date(Date.now() + RETRY_MINUTES[attempts - 1] * 60_000).toISOString();
    setHandoff(world, task, { sendingAt: undefined, sendError: message, attempts, retryAt, authFailedVersion: loginProblem ? mailVersion() : undefined });
    if (agent) world.addAction(agent.id, "error", `Email didn't send (${message})${retryAt ? `; retrying at ${new Date(retryAt).toLocaleTimeString()}` : ""}`);
    if (agent && (loginProblem || giveUp)) {
      world.addInbox({
        kind: "question",
        agentId: agent.id,
        taskId: task.id,
        title: loginProblem ? "Email login rejected: fix it in Settings → Email" : `Email to ${agent.name} keeps failing: ${task.title}`,
        body: loginProblem
          ? `Sending to ${agent.name} failed because the mail server rejected the login (${message}). Reconnect the account in **Settings → Email** (for Gmail, use an app password). Waiting emails go out automatically once it works.`
          : `Sending failed ${attempts} times (${message}). It won't retry again on its own; check your connection or mail settings, then use **Send now** on the task.`,
        priority: "high",
      });
    }
  }
}

/** Checks the Sent folder for this handoff. "unknown" means the check itself failed. */
async function checkSent(world: World, transport: MailTransport, task: Task): Promise<"sent" | "not-sent" | "unknown"> {
  const h = task.emailHandoff!;
  if (!transport.findSent) return "unknown";
  try {
    const since = new Date(new Date(h.preparedAt).getTime() - 3600_000);
    const found = await transport.findSent(tagOf(task), since);
    if (!found) return "not-sent";
    setHandoff(world, task, { sentAt: h.sendingAt ?? new Date().toISOString(), messageId: found, sendingAt: undefined, sendError: undefined, retryAt: undefined });
    recentSends(world).push(new Date().toISOString());
    const agent = world.agent(task.assigneeId);
    if (agent) world.addAction(agent.id, "info", `Found "${task.title}" in your Sent folder; not sending it again.`);
    return "sent";
  } catch {
    return "unknown";
  }
}

/** Sends a handoff that hasn't gone out yet, if it's due. */
async function sendIfDue(world: World, transport: MailTransport, task: Task): Promise<void> {
  const h = task.emailHandoff!;
  if (h.sendingAt) {
    if (Date.now() - new Date(h.sendingAt).getTime() < INTERRUPTED_MS) return;
    // The harness stopped (or the connection dropped) mid-send. Only resend if it's not in Sent.
    const state = await checkSent(world, transport, task);
    if (state === "sent") return;
    if (state === "unknown" && !transport.findSent) {
      setHandoff(world, task, { sendingAt: undefined, sendError: "Sending was interrupted and may or may not have gone out. Check your Sent folder, then use Send now if it isn't there." });
      return;
    }
    if (state === "unknown") return; // try the check again next poll
    setHandoff(world, task, { sendingAt: undefined });
    await dispatchEmail(world, task.id);
    return;
  }
  if (!h.sendError) {
    await dispatchEmail(world, task.id);
    return;
  }
  const due =
    h.authFailedVersion !== undefined
      ? h.authFailedVersion !== mailVersion() // the account was reconnected
      : Boolean(h.retryAt && Date.now() >= new Date(h.retryAt).getTime());
  if (!due) return;
  // A failed send can still have been delivered (e.g. a timeout after the server took it).
  if ((h.attempts ?? 0) > 0 && !(h.sendError ?? "").startsWith("Daily email limit")) {
    const state = await checkSent(world, transport, task);
    if (state !== "not-sent" && transport.findSent) return;
  }
  setHandoff(world, task, { sendError: undefined, retryAt: undefined, authFailedVersion: undefined });
  await dispatchEmail(world, task.id);
}

/** Manual "Send now": clears a stopped retry and sends (after a Sent-folder check). */
export async function retryEmailNow(world: World, task: Task): Promise<void> {
  const transport = getMailTransport();
  if (!transport) throw new Error("No email account is connected. Connect one in Settings → Email.");
  if (!task.emailHandoff || task.status !== "in_progress") throw new Error("This task isn't waiting to be emailed");
  if (task.emailHandoff.sentAt) throw new Error("This email was already sent");
  if ((await checkSent(world, transport, task)) === "sent") return;
  setHandoff(world, task, { sendError: undefined, retryAt: undefined, authFailedVersion: undefined, sendingAt: undefined, attempts: 0 });
  await dispatchEmail(world, task.id);
}

/**
 * Sends handoffs that are due and reads the mailbox for replies. A reply counts
 * only if it is from the agent's configured address, carries the task reference
 * and iteration, and passes sender authentication. Reply text is stored as the
 * result and never treated as an instruction.
 */
export async function pollEmailReplies(world: World, force = false): Promise<void> {
  const transport = getMailTransport();
  if (!transport || polling || (!force && Date.now() - lastPoll < POLL_MS)) return;
  polling = true;
  lastPoll = Date.now();
  try {
    const waiting = world.data.tasks.filter((t) => t.status === "in_progress" && t.emailHandoff);
    // Outgoing: nothing new leaves while the world is paused.
    if (!world.data.paused) {
      for (const task of waiting.filter((t) => !t.emailHandoff!.sentAt)) await sendIfDue(world, transport, task);
    }

    // Incoming: one mailbox search per external agent, matched to tasks here.
    const sent = waiting.filter((t) => t.emailHandoff?.sentAt && t.status === "in_progress");
    const byAddress = new Map<string, { agent: Agent; tasks: Task[] }>();
    for (const task of sent) {
      const agent = world.agent(task.assigneeId);
      if (!agent?.email) continue;
      const key = agent.email.toLowerCase();
      const group = byAddress.get(key) ?? { agent, tasks: [] };
      group.tasks.push(task);
      byAddress.set(key, group);
    }
    for (const [address, { agent, tasks }] of byAddress) {
      const since = new Date(Math.min(...tasks.map((t) => new Date(t.emailHandoff!.sentAt!).getTime())) - 3600_000);
      let mails;
      try {
        mails = await transport.fetchReplies(address, "[Harness ", since);
      } catch (err) {
        world.addAction(agent.id, "error", `Mailbox check failed: ${(err instanceof Error ? err.message : String(err)).slice(0, 160)}`);
        continue;
      }
      for (const task of tasks) {
        const h = task.emailHandoff!;
        const reply = mails.find((m) => {
          const ref = REF.exec(m.subject);
          return m.from === address && m.authenticated && ref?.[1] === task.id && Number(ref[2]) === task.iteration
            && new Date(m.date).getTime() >= new Date(h.sentAt!).getTime() && m.messageId !== h.messageId;
        });
        const text = reply ? extractReply(reply.text) : "";
        if (reply && text) {
          setHandoff(world, task, { replyMessageId: reply.messageId });
          recordEmailResult(world, world.task(task.id)!, text, true);
          continue;
        }
        if (Date.now() - new Date(h.sentAt!).getTime() > TIMEOUT_MS && !h.timeoutNotified) {
          setHandoff(world, task, { timeoutNotified: true });
          world.addInbox({
            kind: "question",
            agentId: agent.id,
            taskId: task.id,
            title: `No reply yet: ${task.title}`,
            body: "No authenticated reply has arrived after 3 days. The task is still waiting; you can record a result manually or cancel it.",
          });
        }
      }
    }
  } finally {
    polling = false;
  }
}

/** Runs a send/receive pass now, e.g. right after an account is connected. */
export function kickEmail(world: World): void {
  void pollEmailReplies(world, true).catch(() => {});
}

/**
 * Messages addressed to an external agent. With email connected, each direct
 * message becomes an emailed task whose reply comes back to the sender as a
 * message (bounded by the usual conversation-depth limit). Broadcasts aren't
 * emailed. Without email, they wait in the inbox for the user.
 */
export function routeMessagesToEmailAgent(world: World, agent: Agent, messages: Message[]): void {
  const connected = Boolean(getMailTransport());
  for (const m of messages) {
    if (m.to !== agent.id || m.kind === "task_result") continue;
    if (connected) {
      world.createTask({
        title: `Message from ${world.displayName(m.from)}`,
        description: m.content,
        zoneId: agent.zoneId,
        assigneeId: agent.id,
        createdBy: m.from,
        replyAsMessage: { hops: m.hops },
      });
    } else {
      world.addInbox({ kind: "message", agentId: agent.id, title: `Message for ${agent.name} is waiting: connect email to send it`, body: m.content });
    }
  }
  world.markProcessed(agent.id, messages.map((m) => m.id));
}

export function recordEmailResult(world: World, task: Task, result: string, auto = false): void {
  const agent = world.agent(task.assigneeId);
  if (!agent || !task.emailHandoff || task.status !== "in_progress") throw new Error("Task is not awaiting an email result");
  const summary = result.split("\n").find((line) => line.trim())?.slice(0, 200) ?? "Result recorded";
  world.updateTask(task.id, {
    status: "done",
    result,
    summary,
    completedAt: new Date().toISOString(),
    nextRunAt: task.repeatEveryMinutes ? new Date(Date.now() + task.repeatEveryMinutes * 60_000).toISOString() : undefined,
  });
  agent.stats.tasksDone++;
  world.setAgentState(agent.id, { status: agent.status, activity: "done" });
  if (task.replyAsMessage) {
    // A reply to a message goes back as a message, so conversation-depth limits still apply.
    if (task.createdBy === "user") {
      world.addInbox({ kind: "message", agentId: agent.id, taskId: task.id, title: summary.slice(0, 90), body: result });
    } else if (world.agent(task.createdBy)) {
      world.sendMessage({ from: agent.id, to: task.createdBy, content: result, kind: "chat", hops: task.replyAsMessage.hops + 1, taskId: task.id });
    }
    return;
  }
  deliverResult(world, agent, task, `${auto ? "Reply received by email" : "Result recorded by user"} for "${task.title}":\n\n${result}`, { summary, result }, false);
}
