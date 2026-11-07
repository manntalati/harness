import { Town } from "./town.js";
import { esc, markdown } from "./markdown.js";
import * as P from "./pixel.js";

// ── State ───────────────────────────────────────────────────────────

const S = {
  data: null,
  selection: null, // { type: "agent" | "zone" | "inbox" | "tasks", id? }
  agentTab: "activity",
  inboxFilter: "all",
  taskFilter: "open",
  taskZone: "",
  expanded: new Set(),
  regionCache: new Map(),
  connected: false,
  feedOpen: true,
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

async function rpc(name, args = {}) {
  const res = await fetch(`/api/rpc/${name}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(args),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
  return body.result;
}

async function act(fn, success) {
  try {
    const result = await fn();
    if (success) toast(success);
    return result;
  } catch (err) {
    toast(err.message, "error");
    throw err;
  }
}

// ── Helpers ─────────────────────────────────────────────────────────

const agentById = (id) => S.data.agents.find((a) => a.id === id);
const zoneById = (id) => S.data.zones.find((z) => z.id === id);
const taskById = (id) => S.data.tasks.find((t) => t.id === id);

function nameOf(id) {
  if (!id) return "—";
  if (id === "user") return "You";
  if (id === "all") return "everyone";
  if (id.startsWith("zone:")) return zoneById(id.slice(5))?.name ?? "an area";
  return agentById(id)?.name ?? "former teammate";
}

function ago(iso) {
  if (!iso) return "";
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function clock(iso) {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function money(n) {
  return n < 0.01 && n > 0 ? "<$0.01" : `$${n.toFixed(2)}`;
}

function tokens(n) {
  return n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n);
}

const avatarCache = new Map();
function avatar(agent, size = 40) {
  if (!agent) return `<span class="avatar avatar-empty" style="width:${size}px;height:${size}px"></span>`;
  const key = `${agent.id}:${JSON.stringify(agent.appearance)}`;
  let url = avatarCache.get(key);
  if (!url) {
    const c = document.createElement("canvas");
    c.width = 16;
    c.height = 18;
    const ctx = c.getContext("2d");
    P.drawCharacter(ctx, 8, 21, agent.appearance, 0, 0, { seated: true });
    url = c.toDataURL();
    avatarCache.set(key, url);
  }
  return `<img class="avatar" src="${url}" width="${size}" height="${Math.round(size * 1.125)}" alt="">`;
}

function statusChip(agent) {
  const label = agent.status === "working" ? activityLabel(agent.activity) : agent.status;
  return `<span class="chip chip-${agent.status}">${esc(label)}</span>`;
}

function activityLabel(activity) {
  return (
    {
      thinking: "thinking",
      writing: "writing",
      searching: "searching the web",
      reading: "reading",
      editing: "editing files",
      running: "running a command",
      messaging: "messaging",
      delegating: "delegating",
      reporting: "reporting to you",
      noting: "taking notes",
      hiring: "hiring",
      done: "wrapping up",
      idle: "working",
      error: "error",
    }[activity] ?? activity
  );
}

function taskChip(status) {
  const label = { queued: "queued", in_progress: "in progress", done: "done", failed: "failed", cancelled: "cancelled" }[status] ?? status;
  return `<span class="chip chip-task-${status}">${label}</span>`;
}

function titleFrom(text) {
  const first = text.trim().split(/\n|(?<=[.!?])\s/)[0];
  return first.length > 80 ? `${first.slice(0, 77)}…` : first;
}

function lead() {
  return S.data.agents.find((a) => a.canHire && a.status !== "paused") ?? S.data.agents[0];
}

// ── Town ────────────────────────────────────────────────────────────

const town = new Town($("#town"), {
  onPick(hit) {
    if (!hit) {
      if (S.selection?.type === "agent" || S.selection?.type === "zone") select(null);
      return;
    }
    if (hit.type === "inbox") select({ type: "inbox" });
    else select(hit);
  },
});

function select(sel) {
  S.selection = sel;
  town.select(sel && (sel.type === "agent" || sel.type === "zone") ? sel : null);
  renderPanel();
}

// ── Data sync ───────────────────────────────────────────────────────

function upsert(list, item) {
  const i = list.findIndex((x) => x.id === item.id);
  if (i === -1) list.push(item);
  else list[i] = item;
}

let renderQueued = false;
const dirty = new Set();
function invalidate(...parts) {
  for (const p of parts) dirty.add(p);
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    const parts = new Set(dirty);
    dirty.clear();
    if (parts.has("town")) town.setState(S.data);
    if (parts.has("top")) renderTop();
    if (parts.has("feed")) renderFeed();
    if (parts.has("panel")) refreshPanel();
  });
}

function apply(evt) {
  const d = S.data;
  town.onEvent(evt);
  switch (evt.type) {
    case "world":
      d.paused = evt.paused;
      d.settings = evt.settings;
      d.name = evt.name;
      invalidate("top", "panel");
      break;
    case "zone":
      upsert(d.zones, evt.zone);
      invalidate("town", "panel", "top");
      break;
    case "zone:removed":
      d.zones = d.zones.filter((z) => z.id !== evt.id);
      if (S.selection?.type === "zone" && S.selection.id === evt.id) select(null);
      invalidate("town", "panel", "top");
      break;
    case "agent": {
      // Live text arrives on its own (batched) stream; keep ours so fragments aren't counted twice.
      const prev = agentById(evt.agent.id);
      if (prev) {
        evt.agent.liveText = prev.liveText;
        evt.agent.liveThought = prev.liveThought;
      }
      upsert(d.agents, evt.agent);
      invalidate("town", "panel", "top");
      break;
    }
    case "agent:removed":
      d.agents = d.agents.filter((a) => a.id !== evt.id);
      if (S.selection?.type === "agent" && S.selection.id === evt.id) select(null);
      invalidate("town", "panel", "top");
      break;
    case "agent:stream": {
      const a = agentById(evt.id);
      if (!a) break;
      if (evt.reset) {
        a.liveText = "";
        a.liveThought = "";
      }
      if (evt.text) a.liveText = (a.liveText + evt.text).slice(-6000);
      if (evt.thought) a.liveThought = (a.liveThought + evt.thought).slice(-3000);
      if (S.selection?.type === "agent" && S.selection.id === evt.id) invalidate("panel");
      break;
    }
    case "task":
      upsert(d.tasks, evt.task);
      invalidate("panel", "top");
      break;
    case "message":
      d.messages.push(evt.message);
      if (d.messages.length > 400) d.messages.splice(0, d.messages.length - 400);
      invalidate("panel");
      break;
    case "inbox": {
      const isNew = !d.inbox.some((i) => i.id === evt.item.id);
      upsert(d.inbox, evt.item);
      if (isNew && !evt.item.read) notifyInbox(evt.item);
      invalidate("top", "panel", "town");
      break;
    }
    case "note":
      upsert(d.notes, evt.note);
      invalidate("panel");
      break;
    case "note:removed":
      d.notes = d.notes.filter((n) => n.id !== evt.id);
      invalidate("panel");
      break;
    case "log":
      d.log.push(evt.entry);
      if (d.log.length > 300) d.log.splice(0, d.log.length - 300);
      invalidate("feed");
      break;
    case "stats":
      d.stats = evt.stats;
      invalidate("top");
      break;
  }
}

async function loadState() {
  const res = await fetch("/api/state");
  S.data = await res.json();
  S.regionCache.clear();
  town.setState(S.data);
  town.markSeen(S.data);
  renderTop();
  renderFeed();
  renderPanel();
  renderBanner();
}

function connect() {
  const es = new EventSource("/events");
  es.onopen = () => {
    const wasDown = S.connected === false && S.everConnected;
    S.connected = true;
    S.everConnected = true;
    renderBanner();
    if (wasDown) loadState();
  };
  es.onmessage = (e) => {
    try {
      apply(JSON.parse(e.data));
    } catch (err) {
      console.error(err);
    }
  };
  es.onerror = () => {
    S.connected = false;
    renderBanner();
  };
}

// ── Top bar ─────────────────────────────────────────────────────────

function renderTop() {
  const d = S.data;
  $("#world-name").textContent = d.name;
  const unreadCount = d.inbox.filter((i) => !i.read && !i.archived).length;
  document.title = `${unreadCount ? `(${unreadCount}) ` : ""}${d.name} · Harness`;
  const working = d.agents.filter((a) => a.status === "working").length;
  const st = d.stats;
  $("#stats").innerHTML = `
    <span title="Agents working right now"><b>${working}</b>/${d.agents.length} working</span>
    <span title="Tasks waiting for an agent"><b>${st.queuedTasks}</b> queued</span>
    <span title="Tokens used (input + output)"><b>${tokens(st.inputTokens + st.outputTokens)}</b> tok</span>
    ${
      st.costUsd > 0
        ? `<span title="Estimated API spend at list prices"><b>${money(st.costUsd)}</b></span>`
        : d.health.engine === "claude-code"
          ? `<span title="Agents run through Claude Code on your Claude plan">on your plan</span>`
          : ""
    }`;
  const run = $("#run-toggle");
  run.classList.toggle("paused", d.paused);
  run.innerHTML = d.paused ? `<span class="dot"></span>Paused` : `<span class="dot"></span>Running`;
  run.title = d.paused ? "Resume: let agents pick up work again" : "Pause: agents finish what they're doing but start nothing new";
  const unread = d.inbox.filter((i) => !i.read && !i.archived).length;
  $("#inbox-count").textContent = unread ? String(unread) : "";
  $("#inbox-count").hidden = !unread;
  $("#btn-inbox").classList.toggle("active", S.selection?.type === "inbox");
  $("#btn-tasks").classList.toggle("active", S.selection?.type === "tasks");

  // Ask bar recipients
  const sel = $("#ask-to");
  const current = sel.value;
  const l = lead();
  sel.innerHTML =
    `<option value="">${l ? `Team lead (${esc(l.name)})` : "Team lead"}</option>` +
    `<optgroup label="Agents">${d.agents.map((a) => `<option value="agent:${a.id}">${esc(a.name)} · ${esc(a.title)}</option>`).join("")}</optgroup>` +
    `<optgroup label="Areas">${d.zones.map((z) => `<option value="zone:${z.id}">${esc(z.name)}</option>`).join("")}</optgroup>`;
  if ([...sel.options].some((o) => o.value === current)) sel.value = current;
  renderBanner();
}

function renderBanner() {
  const el = $("#banner");
  if (!S.data) return;
  if (!S.connected && S.everConnected) {
    el.innerHTML = `Lost connection to the harness. Reconnecting…`;
    el.hidden = false;
  } else if (!S.data.health.email?.configured && S.data.agents.some((a) => a.email)) {
    const names = S.data.agents.filter((a) => a.email).map((a) => a.name).join(", ");
    el.innerHTML = `${esc(names)} ${names.includes(",") ? "work" : "works"} over email, but no email account is connected, so nothing is being sent. <button class="link" data-connect-email>Connect email</button>`;
    $("[data-connect-email]", el).addEventListener("click", openEmailModal);
    el.hidden = false;
  } else if (S.data.health.engineProblem) {
    el.innerHTML = `${esc(S.data.health.engineProblem)} <button class="link" data-open-settings>Settings</button>`;
    $("[data-open-settings]", el).addEventListener("click", openSettings);
    el.hidden = false;
  } else {
    el.hidden = true;
  }
}

// ── Activity feed ───────────────────────────────────────────────────

function renderFeed() {
  const list = $("#feed-list");
  const entries = S.data.log.slice(-60);
  list.innerHTML = entries
    .map((e) => {
      const agent = agentById(e.agentId);
      const color = agent?.appearance.shirt ?? "#8a7f75";
      return `<li class="feed-${e.kind}" ${agent ? `data-action="select-agent" data-id="${agent.id}"` : ""}>
        <time>${clock(e.ts)}</time><i style="background:${color}"></i><span>${esc(e.text)}</span></li>`;
    })
    .join("");
  list.scrollTop = list.scrollHeight;
  $("#feed").classList.toggle("collapsed", !S.feedOpen);
}

// ── Panel ───────────────────────────────────────────────────────────

const REGIONS = {
  "agent-head": () => {
    const a = agentById(S.selection.id);
    const z = zoneById(a.zoneId);
    return `${avatar(a, 48)}
      <div class="head-text">
        <h2>${esc(a.name)}</h2>
        <div class="sub">${esc(a.title)} · <a href="#" data-action="select-zone" data-id="${z?.id ?? ""}">${esc(z?.name ?? "no area")}</a></div>
        <div class="chips">${statusChip(a)}${a.webAccess ? `<span class="chip">web</span>` : ""}${a.canHire ? `<span class="chip">lead</span>` : ""}${z?.workspace ? `<span class="chip" title="${esc(z.workspace)}">repo</span>` : ""}</div>
      </div>`;
  },
  "agent-now": () => {
    const a = agentById(S.selection.id);
    if (a.email) return externalAgentNow(a);
    const task = a.focus?.taskId ? taskById(a.focus.taskId) : null;
    const partner = a.focus?.withAgentId ? agentById(a.focus.withAgentId) : null;
    const queued = S.data.tasks.filter((t) => t.assigneeId === a.id && t.status === "queued");
    const waiting = S.data.tasks.filter((t) => t.assigneeId === a.id && t.status === "in_progress" && t.id !== task?.id);
    let html = "";
    if (a.status === "error" && a.lastError) {
      html += `<div class="callout error"><b>Last run failed.</b> ${esc(a.lastError)} <button class="link" data-action="clear-error">Dismiss</button></div>`;
    }
    if (a.status === "working") {
      html += `<div class="now-line">${task ? `Working on <b>${esc(task.title)}</b>${task.continuations ? ` <span class="muted small">(run ${task.continuations + 1})</span>` : ""}` : partner ? `Talking with <b>${esc(partner.name)}</b>` : "Reading messages"}${a.activityDetail ? `<div class="muted small">${esc(a.activityDetail)}</div>` : ""}</div>`;
    } else if (a.status === "paused") {
      html += `<div class="now-line muted">Paused. It won't pick up work until resumed.</div>`;
    } else if (a.status !== "error") {
      html += `<div class="now-line muted">${a.activityDetail ? esc(a.activityDetail) : "Idle. Give it a task or send it a message."}</div>`;
    }
    if (waiting.length) html += `<div class="muted small">Waiting for results for: ${waiting.map((t) => `<b>${esc(t.title)}</b>`).join(", ")}</div>`;
    if (queued.length) html += `<div class="muted small">${queued.length} task${queued.length > 1 ? "s" : ""} queued: ${queued.slice(0, 3).map((t) => esc(t.title)).join(" · ")}</div>`;
    if (a.liveThought?.trim()) {
      html += `<div class="label">Thinking</div><div class="thought">${esc(a.liveThought.slice(-500))}</div>`;
    }
    if (a.liveText?.trim()) {
      html += `<div class="label">${a.status === "working" ? "Writing" : "Last output"}</div><pre class="live" data-autoscroll>${esc(a.liveText.slice(-3500).trim())}</pre>`;
    }
    return html;
  },
  "agent-tab": () => {
    const a = agentById(S.selection.id);
    if (S.agentTab === "activity") {
      if (!a.actions.length) return `<p class="empty">Nothing yet. Actions (tool calls, messages, results) show up here.</p>`;
      return `<ul class="actions-log">${[...a.actions]
        .reverse()
        .map((x) => `<li class="act-${x.kind}"><time>${clock(x.ts)}</time><span>${esc(x.text)}</span></li>`)
        .join("")}</ul>`;
    }
    if (S.agentTab === "tasks") {
      const tasks = S.data.tasks.filter((t) => t.assigneeId === a.id).slice().reverse();
      return tasks.length ? tasks.map((t) => taskCard(t, { showAssignee: false })).join("") : `<p class="empty">No tasks yet.</p>`;
    }
    if (S.agentTab === "chat") {
      const msgs = S.data.messages.filter((m) => m.from === a.id || m.to === a.id || m.pendingFor.includes(a.id) || (m.to.startsWith("zone:") && m.to.slice(5) === a.zoneId));
      const fromInbox = S.data.inbox.filter((i) => i.agentId === a.id && (i.kind === "message" || i.kind === "question"));
      const items = [
        ...msgs.map((m) => ({ ts: m.createdAt, from: m.from, to: m.to, text: m.content, kind: m.kind })),
        ...fromInbox.map((i) => ({ ts: i.createdAt, from: a.id, to: "user", text: i.body, kind: "chat" })),
      ].sort((x, y) => (x.ts < y.ts ? -1 : 1));
      if (!items.length) return `<p class="empty">No messages yet.</p>`;
      return `<ul class="chat">${items
        .slice(-60)
        .map(
          (m) => `<li class="${m.from === a.id ? "out" : "in"}"><div class="meta">${esc(nameOf(m.from))} → ${esc(nameOf(m.to))} · ${ago(m.ts)}${m.kind === "task_result" ? " · task result" : ""}</div><div class="md">${markdown(m.text.length > 3000 ? m.text.slice(0, 3000) + "…" : m.text)}</div></li>`,
        )
        .join("")}</ul>`;
    }
    if (S.agentTab === "memory") {
      if (!a.memory.length) return `<p class="empty">No memories yet. Agents save durable facts here with their <code>remember</code> tool.</p>`;
      return `<ul class="memory">${a.memory.map((m, i) => `<li><span>${esc(m)}</span><button class="icon-btn" title="Forget" data-action="forget" data-index="${i}">×</button></li>`).join("")}</ul>`;
    }
    // profile
    const st = a.stats;
    return `<dl class="profile">
      <dt>Transport</dt><dd>${a.email ? `Email handoff (${esc(a.email)})` : "Local model"}</dd>
      <dt>Model</dt><dd>${a.email ? "Not used (external email)" : esc(a.model || `${S.data.settings.defaultModel} (default)`)}</dd>
      <dt>Effort</dt><dd>${esc(a.effort ?? "model default")}</dd>
      <dt>Web access</dt><dd>${a.webAccess ? "yes" : "no"}</dd>
      <dt>Can hire</dt><dd>${a.canHire ? "yes" : "no"}</dd>
      <dt>Activations</dt><dd>${st.activations}</dd>
      <dt>Tasks done</dt><dd>${st.tasksDone}</dd>
      <dt>Tokens</dt><dd>${tokens(st.inputTokens)} in · ${tokens(st.outputTokens)} out</dd>
      <dt>Spend</dt><dd>${money(st.costUsd)}</dd>
    </dl>
    <div class="label">Role</div><div class="role">${esc(a.role)}</div>`;
  },
  "zone-head": () => {
    const z = zoneById(S.selection.id);
    const style = P.THEME_STYLE[z.theme] ?? P.THEME_STYLE.garden;
    return `<span class="swatch" style="background:${style.floor};border-color:${style.accent}"></span>
      <div class="head-text">
        <h2>${esc(z.name)}</h2>
        <div class="sub">${esc(S.data.themes.find((t) => t.id === z.theme)?.label ?? z.theme)}</div>
        <div class="chips">${z.workspace ? `<span class="chip" title="${esc(z.workspace)}">repo</span>` : ""}${z.allowCommands ? `<span class="chip chip-warn">commands on</span>` : ""}</div>
      </div>`;
  },
  "zone-about": () => {
    const z = zoneById(S.selection.id);
    return `${z.description ? `<p>${esc(z.description)}</p>` : `<p class="muted">No purpose written yet. <a href="#" data-action="edit-zone">Add one</a>; every agent here reads it.</p>`}
      <div class="workspace">${
        z.workspace
          ? `<span class="label">Workspace</span><code>${esc(z.workspace)}</code>`
          : `<span class="muted small">No folder attached. <a href="#" data-action="edit-zone">Attach a repo or folder</a> to give agents here file tools.</span>`
      }</div>`;
  },
  "zone-team": () => {
    const z = zoneById(S.selection.id);
    const agents = S.data.agents.filter((a) => a.zoneId === z.id);
    if (!agents.length) return `<p class="empty">Nobody works here yet.</p>`;
    return `<ul class="team">${agents
      .map(
        (a) => `<li data-action="select-agent" data-id="${a.id}">${avatar(a, 28)}<div><b>${esc(a.name)}</b> <span class="muted">${esc(a.title)}</span><div class="small muted">${esc(a.status === "working" ? a.activityDetail ?? activityLabel(a.activity) : a.status)}</div></div>${statusChip(a)}</li>`,
      )
      .join("")}</ul>`;
  },
  "zone-tasks": () => {
    const z = zoneById(S.selection.id);
    const tasks = S.data.tasks.filter((t) => t.zoneId === z.id);
    const open = tasks.filter((t) => t.status === "queued" || t.status === "in_progress");
    const done = tasks.filter((t) => !open.includes(t)).slice(-5).reverse();
    if (!tasks.length) return `<p class="empty">No tasks in this area yet.</p>`;
    return `${open.map((t) => taskCard(t)).join("")}${done.length ? `<div class="label">Recently finished</div>${done.map((t) => taskCard(t)).join("")}` : ""}`;
  },
  "zone-notes": () => {
    const z = zoneById(S.selection.id);
    const notes = S.data.notes.filter((n) => n.zoneId === z.id).slice(-20).reverse();
    if (!notes.length) return `<p class="empty">The board is empty. Pin standing instructions or context here; agents read the latest notes every time they start work.</p>`;
    return `<ul class="notes">${notes
      .map((n) => `<li><div class="meta">${esc(nameOf(n.author))} · ${ago(n.createdAt)}<button class="icon-btn" title="Remove" data-action="remove-note" data-id="${n.id}">×</button></div>${esc(n.content)}</li>`)
      .join("")}</ul>`;
  },
  "inbox-head": () => {
    const unread = S.data.inbox.filter((i) => !i.read && !i.archived).length;
    const canAsk = "Notification" in window && Notification.permission === "default";
    return `<div class="head-text"><h2>Inbox</h2><div class="sub">${unread ? `${unread} unread` : "All caught up"}${
      canAsk ? ` · <button class="link" data-action="enable-alerts">Get desktop alerts when something arrives</button>` : ""
    }</div></div>`;
  },
  "inbox-list": () => {
    const f = S.inboxFilter;
    const items = S.data.inbox
      .filter((i) => (f === "archived" ? i.archived : !i.archived))
      .filter((i) => f !== "unread" || !i.read)
      .filter((i) => f !== "reports" || i.kind === "report")
      .filter((i) => f !== "messages" || i.kind === "message" || i.kind === "question")
      .filter((i) => f !== "results" || i.kind === "task_result")
      .slice()
      .reverse();
    if (!items.length) {
      return `<p class="empty">${f === "all" ? "Nothing yet. Finished work, reports, and questions from your agents land here." : "Nothing here."}</p>`;
    }
    return items.map(inboxCard).join("");
  },
  "tasks-list": () => {
    const f = S.taskFilter;
    const tasks = S.data.tasks
      .filter((t) => (f === "open" ? t.status === "queued" || t.status === "in_progress" : f === "all" ? true : t.status === f))
      .filter((t) => !S.taskZone || t.zoneId === S.taskZone)
      .slice()
      .reverse();
    if (!tasks.length) return `<p class="empty">${f === "open" ? "No open tasks. Use the bar at the top to give the team a goal." : "No tasks."}</p>`;
    return tasks.map((t) => taskCard(t, { showZone: true })).join("");
  },
};

function taskCard(t, opts = {}) {
  const { showAssignee = true, showZone = false } = opts;
  const open = S.expanded.has(t.id);
  const z = zoneById(t.zoneId);
  const meta = [
    showAssignee ? (t.assigneeId ? nameOf(t.assigneeId) : "unassigned") : null,
    showZone && z ? z.name : null,
    t.createdBy !== "user" ? `from ${nameOf(t.createdBy)}` : null,
    t.iteration > 1 ? `v${t.iteration}` : null,
    t.continuations ? `run ${t.continuations + 1}` : null,
    t.repeatEveryMinutes ? `every ${t.repeatEveryMinutes}m` : null,
    ago(t.completedAt ?? t.startedAt ?? t.createdAt),
  ].filter(Boolean);
  let body = "";
  if (open) {
    body += `<div class="card-body">`;
    if (t.description) body += `<div class="label">Instructions</div><div class="md">${markdown(t.description)}</div>`;
    if (t.feedback) body += `<div class="label">Your feedback</div><div class="md">${markdown(t.feedback)}</div>`;
    if (t.error) body += `<div class="callout error">${esc(t.error)}</div>`;
    if (t.result) body += `<div class="label">Result</div><div class="md">${markdown(t.result)}</div>`;
    if (t.progress && t.status !== "done") body += `<div class="label">Progress so far</div><pre class="progress">${esc(t.progress)}</pre>`;
    if (t.emailHandoff && t.status === "in_progress") body += emailHandoffBlock(t);
    body += `<div class="row-actions">`;
    if (t.status === "queued" || t.status === "in_progress" || t.repeatEveryMinutes) {
      body += `<button class="btn small" data-action="cancel-task" data-id="${t.id}">${t.repeatEveryMinutes && t.status !== "in_progress" ? "Stop repeating" : "Cancel"}</button>`;
    }
    if (t.status === "done" || t.status === "failed" || t.status === "cancelled") {
      body += `<button class="btn small" data-action="iterate-open" data-id="${t.id}">Iterate…</button>`;
    }
    body += `</div><form class="inline-form" data-form="iterate" data-id="${t.id}" hidden>
        <textarea name="feedback" rows="3" placeholder="What should change in the next version?" data-keep="iter-${t.id}" required></textarea>
        <button class="btn primary small">Send back for another pass</button>
      </form></div>`;
  }
  return `<article class="card task ${open ? "open" : ""}">
    <header data-action="toggle" data-id="${t.id}">${taskChip(t.status)}<b>${esc(t.title)}</b><span class="muted small">${esc(meta.join(" · "))}</span></header>
    ${!open && t.summary ? `<div class="summary small">${esc(t.summary)}</div>` : ""}${body}</article>`;
}

/** "Now" section for an agent that works outside the harness, reached by email. */
function externalAgentNow(a) {
  const tasks = S.data.tasks
    .filter((t) => t.assigneeId === a.id && t.status === "in_progress" && t.emailHandoff)
    .sort((x, y) => (x.emailHandoff.preparedAt < y.emailHandoff.preparedAt ? 1 : -1));
  const queued = S.data.tasks.filter((t) => t.assigneeId === a.id && t.status === "queued");
  const pending = S.data.inbox.filter((i) => i.agentId === a.id && i.reply && !i.reply.resolved && !i.archived);
  let html = `<div class="now-line">${
    a.status === "paused" ? "Paused. New tasks wait until it's resumed." : tasks.length ? `Working on <b>${tasks.length}</b> task${tasks.length > 1 ? "s" : ""} over email` : "Idle. Give it a task or send it a message."
  }<div class="muted small">Works outside the harness; reached at ${esc(a.email)}${a.replyFrom?.length ? `, replies also accepted from ${esc(a.replyFrom.join(", "))}` : ""}.</div></div>`;
  if (pending.length) {
    html += `<div class="callout"><b>${esc(a.name)} emailed back</b> and it needs your OK before it's recorded. <a href="#" data-action="open-inbox-item" data-id="${pending[0].id}">Review in inbox</a></div>`;
  }
  if (tasks.length) {
    html += `<ul class="email-tasks">${tasks
      .map((t) => {
        const h = t.emailHandoff;
        const state = h.replyIssue
          ? `<span class="chip chip-warn">replied: needs your OK</span>`
          : h.sentAt
            ? `<span class="chip chip-working">emailed ${esc(ago(h.sentAt))}, waiting for reply</span>`
            : h.sendingAt && !h.sendError
              ? `<span class="chip chip-working">sending</span>`
              : !S.data.health.email?.configured
                ? `<span class="chip chip-error">not sent: no email account</span>`
                : h.retryAt
                  ? `<span class="chip chip-warn">retrying</span>`
                  : `<span class="chip chip-error">not sent</span>`;
        return `<li data-action="open-task" data-id="${t.id}"><b>${esc(t.title)}</b>${state}</li>`;
      })
      .join("")}</ul>`;
  }
  if (queued.length) html += `<div class="muted small">${queued.length} more queued.</div>`;
  return html;
}

/** What happened to a task's email to an external agent, and what happens next. */
function emailHandoffBlock(t) {
  const h = t.emailHandoff;
  const connected = S.data.health.email?.configured;
  const time = (iso) => new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  const details = `<div class="label">To: ${esc(h.to)}</div><b>${esc(h.subject)}</b><pre class="progress">${esc(h.body)}</pre>`;
  const record = `<button class="btn small ghost" data-action="email-result" data-id="${t.id}">Record a result by hand</button>`;
  if (h.sentAt && h.replyIssue) {
    const item = S.data.inbox.find((i) => i.reply && !i.reply.resolved && i.reply.taskIds.includes(t.id));
    return `<div class="callout"><b>A reply came back</b> but wasn't recorded automatically because ${esc(h.replyIssue)}. ${item ? `<a href="#" data-action="open-inbox-item" data-id="${item.id}">Review it in the inbox</a>` : ""}</div>${details}<div class="row-actions">${record}</div>`;
  }
  if (h.sentAt) {
    return `<div class="callout">Emailed ${esc(time(h.sentAt))}. The reply is picked up from your mailbox automatically (checked every 30 seconds) and recorded here.</div>${details}<div class="row-actions">${record}</div>`;
  }
  if (h.sendingAt && !h.sendError) return `<div class="callout">Sending…</div>${details}`;
  if (!connected) {
    const mailto = `mailto:${encodeURIComponent(h.to)}?subject=${encodeURIComponent(h.subject)}&body=${encodeURIComponent(h.body)}`;
    return `<div class="callout error"><b>Not sent yet: no email account is connected.</b> Connect one and this goes out automatically, along with anything else waiting. Replies then come back on their own.</div>
      <div class="row-actions"><button class="btn primary small" data-action="connect-email">Connect email</button></div>${details}
      <div class="row-actions"><a class="btn small ghost" href="${esc(mailto)}">Send it yourself instead</a>${record}</div>`;
  }
  let status;
  if (h.authFailedVersion !== undefined) status = `<b>The mail server rejected the login.</b> ${esc(h.sendError)} Reconnect the account and it goes out automatically.`;
  else if (h.retryAt) status = `${esc(h.sendError)} Trying again automatically at ${esc(time(h.retryAt))}.`;
  else if (h.sendError) status = `<b>Couldn't send:</b> ${esc(h.sendError)}`;
  else status = "Waiting to send.";
  return `<div class="callout ${h.authFailedVersion !== undefined || (h.sendError && !h.retryAt) ? "error" : ""}">${status}</div>
    <div class="row-actions">${h.authFailedVersion !== undefined ? `<button class="btn primary small" data-action="connect-email">Fix email account</button>` : ""}<button class="btn small" data-action="email-retry" data-id="${t.id}">Send now</button>${record}</div>${details}`;
}

/** Buttons for an email from an external agent that is waiting for the user's decision. */
function replyActions(i) {
  const agent = agentById(i.agentId);
  const tasks = i.reply.taskIds.map(taskById).filter((t) => t && t.status === "in_progress");
  const trusted = agent && (agent.email?.toLowerCase() === i.reply.from || agent.replyFrom?.includes(i.reply.from));
  return `<div class="reply-actions">
    ${tasks.length ? `<div class="label">Use this email as the result of</div>${tasks.map((t) => `<button class="btn primary small" data-action="accept-reply" data-reply="${i.reply.id}" data-task="${t.id}">${esc(t.title)}</button>`).join("")}` : `<p class="muted small">None of ${esc(agent?.name ?? "its")} tasks are waiting for a reply right now.</p>`}
    ${tasks.length && !trusted ? `<label class="check small"><input type="checkbox" data-trust="${i.reply.id}"> Always accept replies from ${esc(i.reply.from)}</label>` : ""}
    <div class="row-actions"><button class="btn small ghost" data-action="dismiss-reply" data-reply="${i.reply.id}">Ignore this email</button></div>
  </div>`;
}

function inboxCard(i) {
  const a = agentById(i.agentId);
  const open = S.expanded.has(i.id);
  const kindLabel = { report: "report", message: "message", task_result: "result", question: "question" }[i.kind];
  const done = i.actionItems.filter((x) => x.done).length;
  let body = "";
  if (open) {
    body = `<div class="card-body">
      <div class="md">${markdown(i.body)}</div>
      ${
        i.actionItems.length
          ? `<div class="label">Action items</div><ul class="todo">${i.actionItems
              .map((x, n) => `<li><label><input type="checkbox" data-action="toggle-item" data-id="${i.id}" data-index="${n}" ${x.done ? "checked" : ""}> <span>${esc(x.text)}</span></label></li>`)
              .join("")}</ul>`
          : ""
      }
      ${
        a
          ? `<form class="inline-form" data-form="reply" data-agent="${a.id}">
        <textarea name="message" rows="2" placeholder="Reply to ${esc(a.name)}: answer a question, steer, or ask for more" data-keep="reply-${i.id}" required></textarea>
        <div class="row-actions"><button class="btn primary small">Reply</button>${
          i.taskId ? `<button type="button" class="btn small" data-action="iterate-from-inbox" data-id="${i.taskId}" data-item="${i.id}" title="Create a new version of the task with this as feedback">Send as task feedback</button>` : ""
        }</div>
      </form>`
          : ""
      }
      ${i.reply && !i.reply.resolved ? replyActions(i) : ""}
      ${/connect email|email login rejected/i.test(i.title) && !S.data.health.email?.configured ? `<div class="row-actions"><button class="btn primary small" data-action="connect-email">Connect email</button></div>` : ""}
      <div class="row-actions end">
        <button class="btn small ghost" data-action="mark-unread" data-id="${i.id}">Mark unread</button>
        <button class="btn small ghost" data-action="archive" data-id="${i.id}" data-archived="${i.archived ? "false" : "true"}">${i.archived ? "Move to inbox" : "Archive"}</button>
      </div>
    </div>`;
  }
  return `<article class="card inbox ${i.read ? "" : "unread"} ${open ? "open" : ""} prio-${i.priority}">
    <header data-action="toggle-inbox" data-id="${i.id}">
      ${avatar(a, 26)}
      <div class="grow"><div class="meta">${esc(a?.name ?? "Former teammate")} · <span class="kind kind-${i.kind}">${kindLabel}</span> · ${ago(i.createdAt)}${i.actionItems.length ? ` · ${done}/${i.actionItems.length} done` : ""}</div><b>${esc(i.title)}</b></div>
      ${i.priority === "high" ? `<span class="chip chip-error">high</span>` : ""}
    </header>${body}</article>`;
}

function panelTemplate() {
  const sel = S.selection;
  if (sel.type === "agent") {
    const a = agentById(sel.id);
    const tabs = [
      ["activity", "Activity"],
      ["tasks", "Tasks"],
      ["chat", "Messages"],
      ["memory", "Memory"],
      ["profile", "Profile"],
    ];
    return `
      <div class="panel-head" data-region="agent-head"></div>
      <div class="panel-body">
        <section class="now" data-region="agent-now"></section>
        <div class="button-row">
          <button class="btn primary" data-action="show-form" data-form-id="assign">Give a task</button>
          <button class="btn" data-action="show-form" data-form-id="message">Message</button>
          <button class="btn" data-action="toggle-pause">${a.status === "paused" ? "Resume" : "Pause"}</button>
          <button class="btn" data-action="edit-agent">Edit</button>
          <button class="btn ghost danger" data-action="remove-agent" title="Remove agent">Remove</button>
        </div>
        <form class="inline-form" data-form="assign" hidden>
          <textarea name="text" rows="3" placeholder="What should ${esc(a.name)} do? Include context and what a good result looks like." data-keep="assign-${a.id}" required></textarea>
          <div class="row-actions">
            <label class="small">Repeat <select name="repeat"><option value="">once</option><option value="30">every 30 min</option><option value="60">hourly</option><option value="360">every 6 hours</option><option value="1440">daily</option></select></label>
            <button class="btn primary small">Assign</button>
          </div>
        </form>
        <form class="inline-form" data-form="message" hidden>
          <textarea name="message" rows="2" placeholder="Message ${esc(a.name)}…" data-keep="msg-${a.id}" required></textarea>
          <div class="row-actions"><button class="btn primary small">Send</button></div>
        </form>
        <nav class="tabs">${tabs.map(([id, label]) => `<button data-action="agent-tab" data-tab="${id}" class="${S.agentTab === id ? "active" : ""}">${label}</button>`).join("")}</nav>
        <section data-region="agent-tab"></section>
      </div>`;
  }
  if (sel.type === "zone") {
    const z = zoneById(sel.id);
    return `
      <div class="panel-head" data-region="zone-head"></div>
      <div class="panel-body">
        <section data-region="zone-about"></section>
        <div class="button-row">
          <button class="btn primary" data-action="show-form" data-form-id="zone-task">Give this area a task</button>
          <button class="btn" data-action="show-form" data-form-id="zone-message">Message everyone</button>
          <button class="btn" data-action="new-agent" data-zone="${z.id}">Hire here</button>
          <button class="btn" data-action="edit-zone">Edit</button>
          <button class="btn ghost danger" data-action="delete-zone">Close</button>
        </div>
        <form class="inline-form" data-form="zone-task" hidden>
          <textarea name="text" rows="3" placeholder="Work for the ${esc(z.name)} team. It goes to whoever is free." data-keep="ztask-${z.id}" required></textarea>
          <div class="row-actions">
            <label class="small">Repeat <select name="repeat"><option value="">once</option><option value="30">every 30 min</option><option value="60">hourly</option><option value="360">every 6 hours</option><option value="1440">daily</option></select></label>
            <button class="btn primary small">Assign</button>
          </div>
        </form>
        <form class="inline-form" data-form="zone-message" hidden>
          <textarea name="message" rows="2" placeholder="Message everyone in ${esc(z.name)}…" data-keep="zmsg-${z.id}" required></textarea>
          <div class="row-actions"><button class="btn primary small">Send</button></div>
        </form>
        <h3>Team</h3>
        <section data-region="zone-team"></section>
        <h3>Tasks</h3>
        <section data-region="zone-tasks"></section>
        <h3>Notes board</h3>
        <form class="inline-form note-form" data-form="note">
          <input name="note" placeholder="Pin a note for everyone in this area…" data-keep="note-${z.id}" required>
          <button class="btn small">Pin</button>
        </form>
        <section data-region="zone-notes"></section>
      </div>`;
  }
  if (sel.type === "inbox") {
    const filters = [
      ["all", "All"],
      ["unread", "Unread"],
      ["reports", "Reports"],
      ["results", "Results"],
      ["messages", "Messages"],
      ["archived", "Archived"],
    ];
    return `
      <div class="panel-head" data-region="inbox-head"></div>
      <div class="panel-body">
        <div class="button-row">
          ${filters.map(([id, label]) => `<button class="pill ${S.inboxFilter === id ? "active" : ""}" data-action="inbox-filter" data-filter="${id}">${label}</button>`).join("")}
          <button class="btn small ghost push" data-action="mark-all-read">Mark all read</button>
        </div>
        <section data-region="inbox-list"></section>
      </div>`;
  }
  if (sel.type === "tasks") {
    const filters = [
      ["open", "Open"],
      ["done", "Done"],
      ["failed", "Failed"],
      ["all", "All"],
    ];
    return `
      <div class="panel-head"><div class="head-text"><h2>Task board</h2><div class="sub">Everything the team is working on</div></div></div>
      <div class="panel-body">
        <div class="button-row">
          ${filters.map(([id, label]) => `<button class="pill ${S.taskFilter === id ? "active" : ""}" data-action="task-filter" data-filter="${id}">${label}</button>`).join("")}
          <select class="push" data-action-change="task-zone"><option value="">All areas</option>${S.data.zones.map((z) => `<option value="${z.id}" ${S.taskZone === z.id ? "selected" : ""}>${esc(z.name)}</option>`).join("")}</select>
        </div>
        <section data-region="tasks-list"></section>
      </div>`;
  }
  return "";
}

function renderPanel() {
  const panel = $("#panel");
  S.regionCache.clear();
  const sel = S.selection;
  const valid =
    sel &&
    ((sel.type === "agent" && agentById(sel.id)) || (sel.type === "zone" && zoneById(sel.id)) || sel.type === "inbox" || sel.type === "tasks");
  if (!valid) {
    S.selection = null;
    panel.hidden = true;
    document.body.classList.remove("panel-open");
    renderTop();
    return;
  }
  panel.hidden = false;
  document.body.classList.add("panel-open");
  $("#panel-content").innerHTML = panelTemplate();
  $("#panel-content").scrollTop = 0;
  refreshPanel();
  renderTop();
}

const kept = new Map();
function refreshPanel() {
  if (!S.selection) return;
  if (S.selection.type === "agent" && !agentById(S.selection.id)) return;
  if (S.selection.type === "zone" && !zoneById(S.selection.id)) return;
  for (const el of $$("[data-keep]")) kept.set(el.dataset.keep, el.value);
  for (const el of $$("[data-region]", $("#panel-content"))) {
    const name = el.dataset.region;
    // Don't redraw under someone who's typing; a clicked button losing focus is fine.
    const active = document.activeElement;
    const typing = active && (active.tagName === "TEXTAREA" || active.tagName === "SELECT" || (active.tagName === "INPUT" && !["checkbox", "radio", "button", "submit"].includes(active.type)));
    if (typing && el.contains(active)) continue;
    const html = REGIONS[name]();
    if (S.regionCache.get(name) === html) continue;
    S.regionCache.set(name, html);
    const live = $("pre.live", el);
    const atBottom = !live || live.scrollTop + live.clientHeight >= live.scrollHeight - 30;
    const openForms = $$("form.inline-form:not([hidden])", el).map((f) => `${f.dataset.form}:${f.dataset.id ?? ""}`);
    el.innerHTML = html;
    for (const key of openForms) {
      const [form, id] = key.split(":");
      const f = $(`form[data-form="${form}"]${id ? `[data-id="${id}"]` : ""}`, el);
      if (f) f.hidden = false;
    }
    const newLive = $("pre.live", el);
    if (newLive && atBottom) newLive.scrollTop = newLive.scrollHeight;
  }
  for (const el of $$("[data-keep]")) if (kept.has(el.dataset.keep) && !el.value) el.value = kept.get(el.dataset.keep);
}

// ── Modals ──────────────────────────────────────────────────────────

function openModal(title, bodyHtml, { submitLabel = "Save", onSubmit, onMount, wide = false, danger = false } = {}) {
  const root = $("#modal-root");
  root.innerHTML = `<div class="modal-backdrop"><form class="modal ${wide ? "wide" : ""}" novalidate>
      <header><h2>${esc(title)}</h2><button type="button" class="icon-btn" data-close aria-label="Close">×</button></header>
      <div class="modal-body">${bodyHtml}</div>
      <footer><span class="form-error" role="alert"></span><button type="button" class="btn ghost" data-close>Cancel</button><button class="btn ${danger ? "danger-solid" : "primary"}">${esc(submitLabel)}</button></footer>
    </form></div>`;
  const form = $(".modal", root);
  const close = () => (root.innerHTML = "");
  $$("[data-close]", root).forEach((b) => b.addEventListener("click", close));
  $(".modal-backdrop", root).addEventListener("mousedown", (e) => {
    if (e.target === e.currentTarget) close();
  });
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!form.checkValidity()) {
      form.reportValidity();
      return;
    }
    const btn = $("footer .btn:last-child", form);
    btn.disabled = true;
    try {
      await onSubmit(new FormData(form), form);
      close();
    } catch (err) {
      $(".form-error", form).textContent = err.message;
      btn.disabled = false;
    }
  });
  onMount?.(form);
  setTimeout(() => $("input:not([type=hidden]):not([type=radio]):not([type=checkbox]), textarea", form)?.focus(), 30);
}

function confirmModal(title, text, label, fn) {
  openModal(title, `<p>${text}</p>`, { submitLabel: label, danger: true, onSubmit: fn });
}

const NAME_IDEAS = ["Ada", "Bo", "Cleo", "Dex", "Echo", "Faye", "Gus", "Hana", "Iris", "Jax", "Kit", "Lou", "Max", "Nova", "Oz", "Pia", "Quin", "Rae", "Sol", "Tess", "Uma", "Vik", "Wren", "Yara", "Zed"];

function suggestName() {
  const taken = new Set(S.data.agents.map((a) => a.name.toLowerCase()));
  const free = NAME_IDEAS.filter((n) => !taken.has(n.toLowerCase()));
  return free[Math.floor(Math.random() * free.length)] ?? `Agent${S.data.agents.length + 1}`;
}

function agentForm(agent, presetZone) {
  const d = S.data;
  const isNew = !agent;
  const zoneId = agent?.zoneId ?? presetZone ?? (S.selection?.type === "zone" ? S.selection.id : d.zones[0]?.id);
  const templates = d.templates;
  return `
    ${
      isNew
        ? `<div class="label">Template</div><div class="template-grid">${templates
            .map(
              (t, i) => `<label class="template-card"><input type="radio" name="template" value="${t.id}" ${i === 1 ? "checked" : ""}>
              <span><b>${esc(t.title)}</b><small>${esc(t.description)}</small></span></label>`,
            )
            .join("")}</div>`
        : ""
    }
    <div class="grid2">
      <label>Name<div class="with-btn"><input name="name" required maxlength="24" value="${esc(agent?.name ?? suggestName())}">${isNew ? `<button type="button" class="icon-btn" data-reroll title="Another name">↻</button>` : ""}</div></label>
      <label>Area<select name="area">${d.zones.map((z) => `<option value="${z.id}" ${z.id === zoneId ? "selected" : ""}>${esc(z.name)}</option>`).join("")}</select></label>
      <label>Job title<input name="title" maxlength="40" value="${esc(agent?.title ?? "")}"></label>
      <label>Model<select name="model"><option value="">Default (${esc(d.settings.defaultModel)})</option>${d.models.map((m) => `<option value="${m}" ${agent?.model === m ? "selected" : ""}>${m}</option>`).join("")}</select></label>
    </div>
    ${!isNew && agent.email ? `<div class="grid2">
      <label>Email address<input type="email" name="email" required value="${esc(agent.email)}"></label>
      <label>Replies may also come from <span class="muted">(optional)</span><input name="reply_from" value="${esc((agent.replyFrom ?? []).join(", "))}" placeholder="e.g. noreply@instinct.example"></label>
    </div>` : ""}
    ${isNew ? `<label>External email agent <span class="muted">(optional)</span><input type="email" name="email" placeholder="Your Instinct email address"></label><p class="muted small">For an agent that lives outside the harness, like Instinct. Its tasks and messages are emailed to this address and its replies come back as results automatically, once an email account is connected in Settings → Email. The address stays in your local world file, not in the repository.</p>` : ""}
    <label>Role & instructions<textarea name="role" rows="6" placeholder="What this agent does, how it works, what it should care about.">${esc(agent?.role ?? "")}</textarea></label>
    <div class="grid2">
      <label>Effort<select name="effort">${["", "low", "medium", "high", "xhigh", "max"].map((e) => `<option value="${e}" ${(agent?.effort ?? "") === e ? "selected" : ""}>${e || "model default"}</option>`).join("")}</select></label>
      <div class="checks">
        <label class="check"><input type="checkbox" name="web" ${agent?.webAccess ? "checked" : ""}> Web search &amp; fetch</label>
        <label class="check"><input type="checkbox" name="hire" ${agent?.canHire ? "checked" : ""}> Lead: can hire agents &amp; open areas</label>
      </div>
    </div>`;
}

function openAgentModal(agent, presetZone) {
  const isNew = !agent;
  openModal(isNew ? "Hire an agent" : `Edit ${agent.name}`, agentForm(agent, presetZone), {
    submitLabel: isNew ? "Hire" : "Save",
    wide: true,
    onMount(form) {
      if (!isNew) return;
      const dirty = new Set();
      ["title", "role"].forEach((n) => form.elements[n].addEventListener("input", () => dirty.add(n)));
      const applyTemplate = () => {
        const t = S.data.templates.find((x) => x.id === form.elements.template.value);
        if (!t) return;
        if (!dirty.has("title")) form.elements.title.value = t.id === "custom" ? "" : t.title;
        if (!dirty.has("role")) form.elements.role.value = t.role;
        form.elements.web.checked = t.webAccess;
        form.elements.hire.checked = t.canHire;
        form.elements.effort.value = t.effort ?? "";
        if (!presetZone && S.selection?.type !== "zone") {
          const home = S.data.zones.find((z) => z.theme === t.homeTheme);
          if (home) form.elements.area.value = home.id;
        }
      };
      $$("input[name=template]", form).forEach((r) => r.addEventListener("change", applyTemplate));
      $("[data-reroll]", form)?.addEventListener("click", () => (form.elements.name.value = suggestName()));
      applyTemplate();
    },
    async onSubmit(fd) {
      const args = {
        name: fd.get("name"),
        area: fd.get("area"),
        title: fd.get("title") || undefined,
        role: fd.get("role") || undefined,
        model: fd.get("model") ?? "",
        effort: fd.get("effort") || undefined,
        web_access: fd.get("web") === "on",
        can_hire: fd.get("hire") === "on",
      };
      if (!isNew && agent.email) {
        args.email = fd.get("email");
        args.reply_from = fd.get("reply_from") ?? "";
      }
      if (isNew) {
        const created = await rpc("create_agent", { ...args, template: fd.get("template"), email: fd.get("email") || undefined, model: args.model || undefined });
        toast(`${created.name} joined the team`);
        setTimeout(() => select({ type: "agent", id: created.id }), 50);
      } else {
        await rpc("update_agent", { agent: agent.id, ...args });
      }
    },
  });
}

function zoneForm(zone) {
  const themes = S.data.themes;
  return `
    <div class="grid2">
      <label>Name<input name="name" required maxlength="40" value="${esc(zone?.name ?? "")}" placeholder="e.g. Trading Bot, Thesis, Side Project"></label>
      <label>Workspace folder <span class="muted">(optional)</span><input name="workspace" value="${esc(zone?.workspace ?? "")}" placeholder="/absolute/path/to/repo"></label>
    </div>
    <label>Purpose<textarea name="purpose" rows="3" placeholder="What this area is for. Every agent working here reads this.">${esc(zone?.description ?? "")}</textarea></label>
    <div class="label">Look</div>
    <div class="theme-grid">${themes
      .map((t, i) => {
        const s = P.THEME_STYLE[t.id];
        const checked = zone ? zone.theme === t.id : i === 0;
        return `<label class="theme-card"><input type="radio" name="theme" value="${t.id}" ${checked ? "checked" : ""}>
          <span><i style="background:${s.floor};border-color:${s.accent}"></i><b>${esc(t.label)}</b><small>${esc(t.blurb)}</small></span></label>`;
      })
      .join("")}</div>
    <label class="check"><input type="checkbox" name="commands" ${zone?.allowCommands ? "checked" : ""}> Let agents here run shell commands in the workspace</label>
    <p class="muted small">Commands run on your machine with your permissions (tests, builds, git). Only enable this for folders you're comfortable letting agents change.</p>`;
}

function openZoneModal(zone) {
  openModal(zone ? `Edit ${zone.name}` : "Open a new area", zoneForm(zone), {
    submitLabel: zone ? "Save" : "Open area",
    wide: true,
    async onSubmit(fd) {
      const args = {
        name: fd.get("name"),
        purpose: fd.get("purpose"),
        theme: fd.get("theme"),
        workspace: fd.get("workspace") ?? "",
        allow_commands: fd.get("commands") === "on",
      };
      if (zone) {
        await rpc("update_area", { area: zone.id, ...args });
      } else {
        const created = await rpc("create_area", { ...args, workspace: args.workspace || undefined });
        toast(`${created.name} is open. Hire someone to work there.`);
        setTimeout(() => {
          select({ type: "zone", id: created.id });
          town.focusZone(created.id);
        }, 80);
      }
    },
  });
}

function openSettings() {
  const s = S.data.settings;
  const num = (name, label, value, min, max, help) =>
    `<label>${label}<input type="number" name="${name}" value="${value}" min="${min}" max="${max}" required><small class="muted">${help}</small></label>`;
  openModal(
    "Settings",
    `<label>How agents run
      <select name="engine">
        <option value="auto" ${s.engine === "auto" ? "selected" : ""}>Automatic: API key if set, otherwise Claude Code</option>
        <option value="claude-code" ${s.engine === "claude-code" ? "selected" : ""}>Claude Code: use my Claude plan (Pro/Max), no API key</option>
        <option value="api" ${s.engine === "api" ? "selected" : ""}>Anthropic API: pay per token with an API key</option>
      </select>
      <small class="muted">Now: ${
        S.data.health.engine === "claude-code"
          ? `Claude Code ${esc(S.data.health.claudeCode ?? "")} on your Claude plan. Agents share your plan's usage limits; the world pauses itself if you hit one.`
          : S.data.health.engine === "api"
            ? "Anthropic API (billed per token)."
            : esc(S.data.health.engineProblem ?? "no engine available")
      }</small>
    </label>
    <div class="grid2">
      <label>World name<input name="name" value="${esc(S.data.name)}" maxlength="40"></label>
      <label>Default model (API engine)<select name="default_model">${S.data.models.map((m) => `<option ${m === s.defaultModel ? "selected" : ""}>${m}</option>`).join("")}${
        S.data.models.includes(s.defaultModel) ? "" : `<option selected>${esc(s.defaultModel)}</option>`
      }</select><small class="muted">For agents without their own model. Claude Code uses its own default.</small></label>
      ${num("max_concurrent", "Agents working at once", s.maxConcurrent, 1, 16, "More = faster and pricier.")}
      ${num("max_steps_per_activation", "Steps per run", s.maxStepsPerActivation, 2, 300, "Tool-use steps before an agent pauses and continues in a fresh run.")}
      ${num("max_continuations", "Fresh runs per task", s.maxContinuations ?? 5, 0, 50, "How many times an unfinished task continues before it comes back to you.")}
      ${num("max_hops", "Conversation depth", s.maxHops, 0, 10, "Agent-to-agent replies that still wake the recipient.")}
      ${num("max_delegation_depth", "Delegation depth", s.maxDelegationDepth, 0, 8, "How many hand-offs deep a task can go.")}
      ${num("max_activations_per_hour", "Activations per agent per hour", s.maxActivationsPerHour, 1, 500, "Circuit breaker against runaway loops.")}
      ${num("max_emails_per_day", "Emails to external agents per day", s.maxEmailsPerDay ?? 40, 1, 1000, "Brake on automatic email.")}
    </div>
    <div class="callout email-status"><b>Email</b> (for external agents like Instinct): ${
      S.data.health.email?.configured
        ? `connected as <code>${esc(S.data.health.email.user)}</code>${S.data.health.email.source === "env" ? " (from environment variables)" : ""}. Tasks and messages to them are sent automatically.`
        : "not connected, so their tasks wait instead of being emailed."
    } <button type="button" class="link" data-email-settings>${S.data.health.email?.configured ? "Change" : "Connect email"}</button></div>
    <div class="callout"><b>Saved in</b> <code>${esc(S.data.health.home)}</code> · v${esc(S.data.health.version)}</div>
    <button type="button" class="btn danger" data-stop-all>Stop all agents now</button>`,
    {
      wide: true,
      onMount(form) {
        $("[data-email-settings]", form).addEventListener("click", () => openEmailModal());
        $("[data-stop-all]", form).addEventListener("click", async () => {
          await act(() => rpc("set_paused", { paused: true, stop_running: true }), "Stopped all agents and paused the world");
          $("#modal-root").innerHTML = "";
        });
      },
      async onSubmit(fd) {
        const args = { name: fd.get("name"), engine: fd.get("engine"), default_model: fd.get("default_model") };
        for (const k of ["max_concurrent", "max_steps_per_activation", "max_continuations", "max_hops", "max_delegation_depth", "max_activations_per_hour", "max_emails_per_day"]) args[k] = Number(fd.get(k));
        await rpc("update_settings", args);
        await loadState();
        toast("Settings saved");
      },
    },
  );
}

function openEmailModal() {
  const st = S.data.health.email ?? { configured: false };
  const fromEnv = st.configured && st.source === "env";
  openModal(
    "Connect email",
    `<p>External agents like Instinct are reached by email. Connect the account to send from, and the harness emails their tasks and messages, watches for replies, and records them as results automatically.</p>
    ${fromEnv ? `<div class="callout">Currently set by environment variables (<code>HARNESS_MAIL_USER</code>), which take priority over anything saved here.</div>` : ""}
    <div class="grid2">
      <label>Email address<input name="address" type="email" required value="${esc(st.user ?? "")}" placeholder="you@gmail.com"></label>
      <label>App password<input name="app_password" type="password" required autocomplete="new-password" placeholder="xxxx xxxx xxxx xxxx"></label>
    </div>
    <p class="muted small"><b>Gmail:</b> turn on 2-step verification, create an app password at myaccount.google.com/apppasswords, and make sure IMAP is on in Gmail settings. Your normal password won't work. School and work Microsoft accounts usually block app passwords; a personal Gmail works best.</p>
    <details><summary class="small">Other provider (custom servers)</summary>
      <div class="grid2">
        <label>SMTP server<input name="smtp_host" placeholder="smtp.gmail.com"></label>
        <label>SMTP port<input name="smtp_port" type="number" placeholder="465"></label>
        <label>IMAP server<input name="imap_host" placeholder="imap.gmail.com"></label>
        <label>IMAP port<input name="imap_port" type="number" placeholder="993"></label>
      </div>
    </details>
    <p class="muted small">The harness signs in once to check sending and reading work, then saves the account in <code>${esc(S.data.health.home)}/mail.json</code> (readable only by you), never in the repository.</p>
    ${st.configured && !fromEnv ? `<button type="button" class="btn ghost danger" data-disconnect>Disconnect ${esc(st.user)}</button>` : ""}`,
    {
      submitLabel: "Test & connect",
      wide: true,
      onMount(form) {
        $("[data-disconnect]", form)?.addEventListener("click", async () => {
          await act(() => rpc("disconnect_email"), "Email disconnected");
          $("#modal-root").innerHTML = "";
          await loadState();
        });
      },
      async onSubmit(fd) {
        const num = (k) => (fd.get(k) ? Number(fd.get(k)) : undefined);
        const status = await rpc("connect_email", {
          address: fd.get("address"),
          app_password: fd.get("app_password"),
          smtp_host: fd.get("smtp_host") || undefined,
          smtp_port: num("smtp_port"),
          imap_host: fd.get("imap_host") || undefined,
          imap_port: num("imap_port"),
        });
        await loadState();
        toast(`Connected ${status.user}. Waiting emails are going out now.`);
      },
    },
  );
}

// ── Toasts & notifications ─────────────────────────────────────────

function toast(text, kind = "info", onClick) {
  const el = document.createElement("div");
  el.className = `toast toast-${kind}`;
  el.innerHTML = typeof text === "string" ? esc(text) : text.html;
  if (onClick) {
    el.classList.add("clickable");
    el.addEventListener("click", () => {
      onClick();
      el.remove();
    });
  }
  $("#toasts").appendChild(el);
  setTimeout(() => el.classList.add("out"), kind === "error" ? 6000 : 4200);
  setTimeout(() => el.remove(), kind === "error" ? 6500 : 4700);
}

function notifyInbox(item) {
  const a = agentById(item.agentId);
  // A system notification when the tab is in the background, if the user allowed it.
  if (document.hidden && "Notification" in window && Notification.permission === "granted") {
    try {
      const n = new Notification(`${a?.name ?? "An agent"}: ${item.title}`, { body: item.body.replace(/[#*_`>]/g, "").slice(0, 180), tag: item.id });
      n.onclick = () => {
        window.focus();
        S.expanded.add(item.id);
        rpc("update_inbox_item", { item_id: item.id, read: true }).catch(() => {});
        select({ type: "inbox" });
      };
    } catch {
      // Some browsers only allow notifications from a service worker; the toast still shows.
    }
  }
  toast({ html: `${avatar(a, 22)}<span><b>${esc(a?.name ?? "An agent")}</b> ${esc(item.title)}</span>` }, "inbox", () => {
    S.expanded.add(item.id);
    rpc("update_inbox_item", { item_id: item.id, read: true }).catch(() => {});
    select({ type: "inbox" });
  });
}

// ── Event wiring ───────────────────────────────────────────────────

document.addEventListener("click", async (e) => {
  const el = e.target.closest("[data-action]");
  if (!el) return;
  const action = el.dataset.action;
  const id = el.dataset.id;
  if (el.tagName === "A") e.preventDefault();
  const sel = S.selection;
  switch (action) {
    case "select-agent":
      select({ type: "agent", id });
      town.focusAgent(id);
      break;
    case "select-zone":
      if (id) {
        select({ type: "zone", id });
        town.focusZone(id);
      }
      break;
    case "show-form": {
      const form = $(`form[data-form="${el.dataset.formId}"]`);
      const show = form.hidden;
      $$("#panel-content form.inline-form[data-form]:not(.note-form)").forEach((f) => {
        if (!f.dataset.id) f.hidden = true;
      });
      form.hidden = !show;
      if (show) $("textarea, input", form)?.focus();
      break;
    }
    case "agent-tab":
      S.agentTab = el.dataset.tab;
      $$(".tabs button").forEach((b) => b.classList.toggle("active", b === el));
      S.regionCache.delete("agent-tab");
      refreshPanel();
      break;
    case "toggle-pause": {
      const a = agentById(sel.id);
      await act(() => rpc("pause_agent", { agent: a.id, paused: a.status !== "paused" }));
      renderPanel();
      break;
    }
    case "clear-error":
      await act(() => rpc("pause_agent", { agent: sel.id, paused: false }));
      break;
    case "edit-agent":
      openAgentModal(agentById(sel.id));
      break;
    case "remove-agent": {
      const a = agentById(sel.id);
      confirmModal(`Remove ${a.name}?`, `${esc(a.name)} will stop what they're doing and leave the team. Their open tasks go back to the area's queue.`, "Remove", async () => {
        await rpc("remove_agent", { agent: a.id });
        select(null);
      });
      break;
    }
    case "new-agent":
      openAgentModal(null, el.dataset.zone);
      break;
    case "edit-zone":
      openZoneModal(zoneById(sel.id));
      break;
    case "delete-zone": {
      const z = zoneById(sel.id);
      confirmModal(`Close ${z.name}?`, `The area's agents and tasks move to another area, and its notes board is cleared.`, "Close area", async () => {
        await rpc("delete_area", { area: z.id });
        select(null);
      });
      break;
    }
    case "toggle":
      S.expanded.has(id) ? S.expanded.delete(id) : S.expanded.add(id);
      S.regionCache.clear();
      refreshPanel();
      break;
    case "toggle-inbox": {
      const item = S.data.inbox.find((i) => i.id === id);
      if (S.expanded.has(id)) S.expanded.delete(id);
      else {
        S.expanded.add(id);
        if (item && !item.read) rpc("update_inbox_item", { item_id: id, read: true }).catch(() => {});
      }
      S.regionCache.clear();
      refreshPanel();
      break;
    }
    case "toggle-item":
      await act(() => rpc("update_inbox_item", { item_id: id, toggle_action: Number(el.dataset.index) }));
      break;
    case "archive":
      await act(() => rpc("update_inbox_item", { item_id: id, archived: el.dataset.archived === "true" }));
      S.expanded.delete(id);
      break;
    case "mark-unread":
      await act(() => rpc("update_inbox_item", { item_id: id, read: false }));
      S.expanded.delete(id);
      break;
    case "mark-all-read":
      await act(() => rpc("mark_all_read"));
      break;
    case "inbox-filter":
      S.inboxFilter = el.dataset.filter;
      renderPanel();
      break;
    case "task-filter":
      S.taskFilter = el.dataset.filter;
      renderPanel();
      break;
    case "accept-reply": {
      const trust = $(`input[data-trust="${el.dataset.reply}"]`)?.checked ?? false;
      await act(() => rpc("accept_email_reply", { reply_id: el.dataset.reply, task_id: el.dataset.task, trust_sender: trust }), "Recorded as the result");
      break;
    }
    case "dismiss-reply":
      await act(() => rpc("dismiss_email_reply", { reply_id: el.dataset.reply }));
      break;
    case "open-inbox-item":
      S.expanded.add(id);
      rpc("update_inbox_item", { item_id: id, read: true }).catch(() => {});
      select({ type: "inbox" });
      break;
    case "open-task":
      S.expanded.add(id);
      S.taskFilter = "open";
      select({ type: "tasks" });
      break;
    case "enable-alerts":
      Notification.requestPermission().then((p) => {
        toast(p === "granted" ? "Desktop alerts on" : "Desktop alerts weren't allowed; you can change that in your browser's site settings");
        S.regionCache.clear();
        refreshPanel();
      });
      break;
    case "connect-email":
      openEmailModal();
      break;
    case "email-retry":
      await act(() => rpc("retry_email", { task_id: id }), "Sending…");
      break;
    case "email-result":
      openModal("Record email result", `<p>Review the reply in your email or trusted conversation first. This records your review, not an authenticated automatic callback.</p><textarea name="result" rows="10" required placeholder="Paste the returned result"></textarea>`, {
        submitLabel: "Record result", onSubmit: async (fd) => { await rpc("record_email_result", { task_id: id, result: fd.get("result") }); },
      });
      break;
    case "cancel-task":
      await act(() => rpc("cancel_task", { task_id: id }), "Task cancelled");
      break;
    case "iterate-open": {
      const form = $(`form[data-form="iterate"][data-id="${id}"]`);
      form.hidden = !form.hidden;
      if (!form.hidden) $("textarea", form).focus();
      break;
    }
    case "iterate-from-inbox": {
      const form = el.closest("form");
      const text = form.elements.message.value.trim();
      if (!text) {
        form.elements.message.focus();
        toast("Write the feedback first", "error");
        break;
      }
      await act(() => rpc("iterate_task", { task_id: id, feedback: text }), "Sent back for another pass");
      form.elements.message.value = "";
      kept.delete(form.elements.message.dataset.keep);
      break;
    }
    case "forget":
      await act(() => rpc("forget_memory", { agent: sel.id, index: Number(el.dataset.index) }));
      break;
    case "remove-note":
      await act(() => rpc("remove_note", { note_id: id }));
      break;
  }
});

document.addEventListener("change", (e) => {
  const el = e.target.closest("[data-action-change]");
  if (el?.dataset.actionChange === "task-zone") {
    S.taskZone = el.value;
    S.regionCache.clear();
    refreshPanel();
  }
});

document.addEventListener("submit", async (e) => {
  const form = e.target.closest("form[data-form]");
  if (!form) return;
  e.preventDefault();
  const fd = new FormData(form);
  const sel = S.selection;
  const clear = () => {
    for (const el of $$("[data-keep]", form)) {
      kept.delete(el.dataset.keep);
      el.value = "";
    }
  };
  const btn = $("button:not([type=button])", form);
  if (btn) btn.disabled = true;
  try {
    switch (form.dataset.form) {
      case "assign": {
        const text = fd.get("text").trim();
        const a = agentById(sel.id);
        await act(() => rpc("assign_task", { title: titleFrom(text), details: text, agent: a.id, repeat_every_minutes: Number(fd.get("repeat")) || undefined }), `Task sent to ${a.name}`);
        clear();
        form.hidden = true;
        break;
      }
      case "message": {
        const a = agentById(sel.id);
        await act(() => rpc("send_message", { to: a.id, message: fd.get("message").trim() }), `Sent to ${a.name}`);
        clear();
        form.hidden = true;
        break;
      }
      case "zone-task": {
        const text = fd.get("text").trim();
        await act(() => rpc("assign_task", { title: titleFrom(text), details: text, area: sel.id, repeat_every_minutes: Number(fd.get("repeat")) || undefined }), "Task queued for the area");
        clear();
        form.hidden = true;
        break;
      }
      case "zone-message":
        await act(() => rpc("send_message", { to: sel.id, message: fd.get("message").trim() }), "Message sent");
        clear();
        form.hidden = true;
        break;
      case "note":
        await act(() => rpc("post_note", { area: sel.id, note: fd.get("note").trim() }));
        clear();
        break;
      case "reply": {
        const a = agentById(form.dataset.agent);
        await act(() => rpc("send_message", { to: form.dataset.agent, message: fd.get("message").trim() }), `Sent to ${a?.name ?? "agent"}`);
        clear();
        break;
      }
      case "iterate":
        await act(() => rpc("iterate_task", { task_id: form.dataset.id, feedback: fd.get("feedback").trim() }), "Sent back for another pass");
        clear();
        form.hidden = true;
        break;
    }
  } catch {
    // toast already shown
  } finally {
    if (btn) btn.disabled = false;
  }
});

// Ask bar: the quickest way to hand the team a goal.
$("#ask").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = $("#ask-input");
  const text = input.value.trim();
  if (!text) return;
  const to = $("#ask-to").value;
  const args = { title: titleFrom(text), details: text };
  if (to.startsWith("agent:")) args.agent = to.slice(6);
  else if (to.startsWith("zone:")) args.area = to.slice(5);
  const btn = $("#ask button");
  btn.disabled = true;
  try {
    const task = await act(() => rpc("assign_task", args));
    toast(`Sent to ${task.assignee ?? task.area}${S.data.paused ? " (the world is paused)" : ""}`);
    input.value = "";
    input.style.height = "";
  } catch {
    // toast shown
  } finally {
    btn.disabled = false;
  }
});

$("#ask-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    $("#ask").requestSubmit();
  }
});

$("#run-toggle").addEventListener("click", () => act(() => rpc("set_paused", { paused: !S.data.paused })));
$("#btn-inbox").addEventListener("click", () => select(S.selection?.type === "inbox" ? null : { type: "inbox" }));
$("#btn-tasks").addEventListener("click", () => select(S.selection?.type === "tasks" ? null : { type: "tasks" }));
$("#btn-agent").addEventListener("click", () => openAgentModal(null));
$("#btn-zone").addEventListener("click", () => openZoneModal(null));
$("#btn-settings").addEventListener("click", openSettings);
$("#panel-close").addEventListener("click", () => select(null));
$("#zoom-in").addEventListener("click", () => town.zoomBy(1.25));
$("#zoom-out").addEventListener("click", () => town.zoomBy(0.8));
$("#zoom-fit").addEventListener("click", () => town.fit(true));
$("#feed-toggle").addEventListener("click", () => {
  S.feedOpen = !S.feedOpen;
  renderFeed();
});

document.addEventListener("keydown", (e) => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName ?? "");
  if (e.key === "Escape") {
    if ($("#modal-root").innerHTML) $("#modal-root").innerHTML = "";
    else if (typing) document.activeElement.blur();
    else select(null);
    return;
  }
  if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === "/") {
    e.preventDefault();
    $("#ask-input").focus();
  } else if (e.key === "i") select({ type: "inbox" });
  else if (e.key === "t") select({ type: "tasks" });
  else if (e.key === "f") town.fit(true);
  else if (e.key === "+" || e.key === "=") town.zoomBy(1.25);
  else if (e.key === "-") town.zoomBy(0.8);
});

// Keep relative timestamps fresh.
setInterval(() => {
  if (!S.data) return;
  S.regionCache.clear();
  refreshPanel();
}, 30000);

loadState()
  .then(connect)
  .catch((err) => {
    $("#banner").hidden = false;
    $("#banner").textContent = `Couldn't load the harness: ${err.message}`;
  });
