import { Appearance, Effort, ZoneTheme } from "./types.js";

// ── Agent templates ─────────────────────────────────────────────────

export interface AgentTemplate {
  id: string;
  title: string;
  description: string;
  role: string;
  webAccess: boolean;
  canHire: boolean;
  effort?: Effort;
  /** Area theme this kind of agent usually lives in. */
  homeTheme: ZoneTheme;
}

export const AGENT_TEMPLATES: AgentTemplate[] = [
  {
    id: "chief-of-staff",
    title: "Chief of Staff",
    description: "Takes your goals, breaks them down, delegates to the team, and reports back.",
    homeTheme: "hq",
    webAccess: false,
    canHire: true,
    effort: "high",
    role: `You run the team on the user's behalf. When the user hands you a goal, work out what "done" looks like, split it into pieces, and delegate each piece to the teammate best suited for it (or do small pieces yourself). If nobody on the team fits a piece of work, hire a specialist or open a new area for a new line of work.

Track what you delegated. When results come back, check them against the goal, ask for revisions where something is weak, and then send the user one consolidated report: what was found or built, what you recommend, and the concrete next steps they need to take. Don't relay raw teammate output; synthesize it.`,
  },
  {
    id: "researcher",
    title: "Researcher",
    description: "Digs into questions on the web, compares sources, and writes up findings.",
    homeTheme: "lab",
    webAccess: true,
    canHire: false,
    effort: "high",
    role: `You are a research analyst. Investigate questions thoroughly: search the web, read primary sources, compare what different sources say, and note where they disagree. Distinguish established facts from claims and from your own inferences. Write findings up as a structured brief with the key takeaways first, then supporting detail and source links. Share findings that would help a teammate's work with them directly.`,
  },
  {
    id: "engineer",
    title: "Engineer",
    description: "Reads and changes code in the area's repository.",
    homeTheme: "workshop",
    webAccess: true,
    canHire: false,
    effort: "high",
    role: `You are a senior software engineer. Before changing code, read enough of the repository to follow its existing conventions. Make focused, minimal changes that solve the task, and explain what you changed and why. If the area allows commands, run the project's tests or build to verify your work and report the result honestly. If the task is ambiguous or risky, ask the teammate or user who assigned it before making sweeping changes.`,
  },
  {
    id: "markets-analyst",
    title: "Markets Analyst",
    description: "Tracks markets, studies tickers and strategies, writes trade ideas for you to decide on.",
    homeTheme: "markets",
    webAccess: true,
    canHire: false,
    effort: "high",
    role: `You are a markets analyst. You research assets, sectors, macro news, and trading strategies, and you turn that research into clearly reasoned ideas: the thesis, the supporting evidence, the main risks, and what would invalidate the idea. Always state the date and source of any price or data point you cite, since market data goes stale quickly. You never place trades or move money; you produce analysis, and the user makes every decision.`,
  },
  {
    id: "writer",
    title: "Writer",
    description: "Turns notes and findings into clear docs, posts, and summaries.",
    homeTheme: "studio",
    webAccess: false,
    canHire: false,
    effort: "medium",
    role: `You are a skilled writer and editor. You turn raw notes, research, and technical detail into clear, well-structured writing for the intended reader. Ask a teammate for missing facts rather than inventing them. Match the tone to the audience and keep things as short as they can be while staying complete.`,
  },
  {
    id: "reviewer",
    title: "Reviewer",
    description: "Critiques plans, code, and drafts; finds the holes before you do.",
    homeTheme: "library",
    webAccess: false,
    canHire: false,
    effort: "high",
    role: `You are a meticulous reviewer. You examine plans, code, research, and drafts for errors, gaps, unstated assumptions, and risks. Be specific: point to the exact claim, line, or step, explain the problem, and propose a fix. Say plainly when something is good enough to ship. Send review feedback directly to the author.`,
  },
  {
    id: "planner",
    title: "Planner",
    description: "Breaks fuzzy goals into concrete, sequenced plans with owners.",
    homeTheme: "hq",
    webAccess: false,
    canHire: false,
    effort: "medium",
    role: `You are a project planner. You turn goals into concrete plans: milestones, tasks, dependencies, owners, and the open questions that block progress. Prefer short plans that can start today over exhaustive ones. Flag risks and the cheapest way to reduce each.`,
  },
  {
    id: "custom",
    title: "Specialist",
    description: "Start from scratch with your own role description.",
    homeTheme: "garden",
    webAccess: false,
    canHire: false,
    role: "",
  },
];

export function getTemplate(id: string | undefined): AgentTemplate | undefined {
  return AGENT_TEMPLATES.find((t) => t.id === id);
}

// ── Area themes ────────────────────────────────────────────────────

export const ZONE_THEMES: { id: ZoneTheme; label: string; blurb: string }[] = [
  { id: "hq", label: "Headquarters", blurb: "Meeting table, sofa, planning boards" },
  { id: "lab", label: "Research Lab", blurb: "Bookshelves, whiteboards, desks" },
  { id: "workshop", label: "Workshop", blurb: "Workbenches, server racks, terminals" },
  { id: "markets", label: "Trading Floor", blurb: "Chart screens and ticker boards" },
  { id: "studio", label: "Studio", blurb: "Easels, a piano, cosy carpet" },
  { id: "library", label: "Library", blurb: "Stacks of books and reading lamps" },
  { id: "garden", label: "Garden Office", blurb: "Plants, open desks, natural light" },
];

// ── Starter world ──────────────────────────────────────────────────

export interface StarterZone {
  key: string;
  name: string;
  description: string;
  theme: ZoneTheme;
}

export interface StarterAgent {
  name: string;
  template: string;
  zone: string;
}

export const STARTER_ZONES: StarterZone[] = [
  {
    key: "hq",
    name: "Headquarters",
    description: "Where goals come in. The Chief of Staff plans the work, hands it out, and reports back to you.",
    theme: "hq",
  },
  {
    key: "lab",
    name: "Research Lab",
    description: "Open-ended research: questions, comparisons, market and literature scans.",
    theme: "lab",
  },
  {
    key: "workshop",
    name: "Workshop",
    description: "Building things. Point this area at a repository (edit the area and set its workspace) to let agents read and change code.",
    theme: "workshop",
  },
  {
    key: "markets",
    name: "Trading Floor",
    description: "Market research and trade ideas. Analysis only: agents here never execute trades.",
    theme: "markets",
  },
];

export const STARTER_AGENTS: StarterAgent[] = [
  { name: "Mira", template: "chief-of-staff", zone: "hq" },
  { name: "Theo", template: "researcher", zone: "lab" },
  { name: "Juno", template: "engineer", zone: "workshop" },
  { name: "Rex", template: "markets-analyst", zone: "markets" },
];

// ── Appearance ─────────────────────────────────────────────────────

const SKINS = ["#f5d0b5", "#e8b896", "#d29a72", "#a86f4c", "#7a4b30", "#f1c7a3"];
const HAIRS = ["#2b1d14", "#5a3a22", "#a0672e", "#d9a441", "#e7d29b", "#8e3b2e", "#3b3b46", "#c9c9d1", "#4a2b5c", "#2f5d8a"];
const SHIRTS = ["#d9534f", "#f0ad4e", "#5cb85c", "#3f8fd2", "#8e6fbf", "#e86fa5", "#2bb3a3", "#f2d14b", "#ef7f45", "#6c7a89"];
const PANTS = ["#2e3a59", "#3b3b46", "#5b4636", "#46586b", "#24303f", "#6b4e3d"];

function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Deterministic look per name so an agent keeps its appearance. */
export function appearanceFor(seed: string): Appearance {
  let h = hashString(seed);
  const pick = <T>(arr: T[]): T => {
    const v = arr[h % arr.length];
    h = Math.imul(h ^ (h >>> 15), 2246822507) >>> 0;
    return v;
  };
  return {
    skin: pick(SKINS),
    hair: pick(HAIRS),
    hairStyle: pick([0, 1, 2, 3, 4]),
    shirt: pick(SHIRTS),
    pants: pick(PANTS),
    accent: pick(SHIRTS),
  };
}
