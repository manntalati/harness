import { World } from "../world/world.js";
import { Task } from "../world/types.js";
import { deliverResult } from "./runtime.js";

/** Prepare only. No SMTP, credentials, webhook, or claim of delivery. */
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
  world.addInbox({ kind: "question", agentId: agent.id, taskId: task.id,
    title: `Review email handoff: ${task.title}`,
    body: "Open this task in the task board to review and send its email. Nothing has been sent. Email is not an authenticated command channel; the recipient may need confirmation in your trusted conversation. Record the returned result on the task when ready.",
  });
  world.addAction(agent.id, "info", `Email prepared for review: ${task.title} (not sent)`);
}

export function recordEmailResult(world: World, task: Task, result: string): void {
  const agent = world.agent(task.assigneeId);
  if (!agent || !task.emailHandoff || task.status !== "in_progress") throw new Error("Task is not awaiting an email result");
  const summary = result.split("\n").find((line) => line.trim())?.slice(0, 200) ?? "Result recorded";
  world.updateTask(task.id, { status: "done", result, summary, completedAt: new Date().toISOString(),
    nextRunAt: task.repeatEveryMinutes ? new Date(Date.now() + task.repeatEveryMinutes * 60_000).toISOString() : undefined });
  agent.stats.tasksDone++;
  world.setAgentState(agent.id, { status: agent.status, activity: "done" });
  deliverResult(world, agent, task, `Result recorded by user for "${task.title}":\n\n${result}`, { summary, result }, false);
}
