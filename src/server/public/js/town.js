// The town: lays out one room per area, walks agent sprites between desks,
// doors and streets, and draws bubbles, envelopes and labels on top.

import * as P from "./pixel.js";

const T = P.TILE;
const ROOM_INNER_H = 11; // tiles
const WALL = 8; // px
const STREET_H = 3; // tiles
const ROW_GAP = 3; // tiles of grass between a street and the next row of rooms
const AVENUE_X = 1; // tiles
const ROOMS_X = 6; // tiles
const MAX_ROW_W = 64; // tiles
const WALK_SPEED = 46; // px / s

const LANE_A = 3.15;
const LANE_B = 6.55;
const LANE_C = 10.2;
const DESK_Y = [3.9, 7.35];
const SEAT_Y = [5.95, 9.4];

export class Town {
  constructor(canvas, handlers) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.handlers = handlers;
    this.state = null;
    this.rooms = [];
    this.roomByZone = new Map();
    this.sprites = new Map();
    this.envelopes = [];
    this.selection = null;
    this.hover = null;
    this.layoutKey = "";
    this.staticLayer = document.createElement("canvas");
    this.world = { w: 800, h: 600 };
    this.cam = { x: 0, y: 0, z: 2 };
    this.camTarget = null;
    this.userMovedCamera = false;
    this.dpr = window.devicePixelRatio || 1;
    this.last = performance.now();
    this.unread = 0;
    this.mailbox = { x: 0, y: 0 };
    this.bindInput();
    this.resize();
    new ResizeObserver(() => this.resize()).observe(canvas.parentElement);
    requestAnimationFrame((t) => this.frame(t));
  }

  // ── State ─────────────────────────────────────────────────────────

  setState(state) {
    this.state = state;
    this.unread = state.inbox.filter((i) => !i.read && !i.archived).length;
    const counts = state.zones.map((z) => `${z.id}:${z.theme}:${z.name}:${z.workspace ? 1 : 0}:${state.agents.filter((a) => a.zoneId === z.id).length}`);
    const key = counts.join("|");
    if (key !== this.layoutKey) {
      const firstLayout = this.layoutKey === "";
      this.layoutKey = key;
      this.layout();
      if (firstLayout || !this.userMovedCamera) this.fit(!firstLayout);
    }
    for (const agent of state.agents) {
      if (!this.sprites.has(agent.id)) {
        const home = this.homeSpot(agent) ?? this.mailboxSpot();
        this.sprites.set(agent.id, new Sprite(agent.id, home.x, home.y, home.seated));
      }
    }
    for (const id of [...this.sprites.keys()]) {
      if (!state.agents.some((a) => a.id === id)) this.sprites.delete(id);
    }
  }

  select(sel) {
    this.selection = sel;
  }

  /** Reacts to live events with envelopes and speech bubbles. */
  onEvent(evt) {
    if (!this.state) return;
    const now = performance.now();
    if (evt.type === "message") {
      const m = evt.message;
      const from = m.from === "user" ? this.mailboxSpot() : this.sprites.get(m.from);
      if (m.from !== "user") this.say(m.from, m.kind === "task_result" ? `Done → ${this.nameOf(m.to)}` : m.content, now);
      for (const to of m.pendingFor) {
        const target = this.sprites.get(to);
        if (from && target) this.launchEnvelope(from, () => target, m.kind === "task_result" ? "task" : "mail");
      }
    } else if (evt.type === "inbox") {
      const item = evt.item;
      if (this.seenInbox?.has(item.id)) return;
      (this.seenInbox ??= new Set()).add(item.id);
      const sprite = this.sprites.get(item.agentId);
      if (sprite) {
        this.say(item.agentId, `For you: ${item.title}`, now);
        this.launchEnvelope(sprite, () => this.mailboxSpot(), "report");
      }
    } else if (evt.type === "task") {
      const t = evt.task;
      if (this.seenTasks?.has(t.id)) return;
      (this.seenTasks ??= new Set()).add(t.id);
      if (t.status !== "queued") return;
      const from = t.createdBy === "user" ? this.mailboxSpot() : this.sprites.get(t.createdBy);
      const room = this.roomByZone.get(t.zoneId);
      const to = t.assigneeId ? this.sprites.get(t.assigneeId) : room ? { x: room.door.x, y: room.door.inY } : null;
      if (t.createdBy !== "user") this.say(t.createdBy, `Task for ${t.assigneeId ? this.nameOf(t.assigneeId) : room?.zone.name ?? "the team"}: ${t.title}`, now);
      if (from && to) this.launchEnvelope(from, () => to, "task");
    }
  }

  markSeen(state) {
    this.seenInbox = new Set(state.inbox.map((i) => i.id));
    this.seenTasks = new Set(state.tasks.map((t) => t.id));
  }

  nameOf(id) {
    if (id === "user") return "you";
    if (id === "all") return "everyone";
    if (id?.startsWith("zone:")) return this.state.zones.find((z) => z.id === id.slice(5))?.name ?? "an area";
    return this.state.agents.find((a) => a.id === id)?.name ?? "someone";
  }

  say(agentId, text, now) {
    const sprite = this.sprites.get(agentId);
    if (!sprite) return;
    sprite.speech = text.replace(/\s+/g, " ").trim();
    sprite.speechUntil = now + 5500;
  }

  launchEnvelope(from, toFn, kind) {
    const start = { x: from.x, y: from.y - 14 };
    const end = toFn();
    const dist = Math.hypot(end.x - start.x, end.y - start.y);
    this.envelopes.push({ start, toFn, kind, t0: performance.now(), dur: 700 + Math.min(1600, dist * 2.2) });
  }

  // ── Layout ────────────────────────────────────────────────────────

  layout() {
    const { zones, agents } = this.state;
    const cells = zones.map((zone) => {
      const n = agents.filter((a) => a.zoneId === zone.id).length;
      const D = Math.max(3, Math.ceil(n / 2));
      return { zone, D, outerW: 4 * D + 2 + 1 };
    });
    // Spread rooms evenly over as few rows as the width allows (3 + 1 looks lopsided; 2 + 2 doesn't).
    const totalW = cells.reduce((sum, c) => sum + c.outerW + 2, 0);
    const rowCount = Math.max(1, Math.ceil(totalW / MAX_ROW_W), Math.round(Math.sqrt(cells.length / 2.2)));
    const perRow = Math.ceil(cells.length / rowCount);
    const rows = [];
    let row = [];
    let rowW = 0;
    for (const cell of cells) {
      if (row.length && (row.length >= perRow || rowW + cell.outerW > MAX_ROW_W)) {
        rows.push(row);
        row = [];
        rowW = 0;
      }
      row.push(cell);
      rowW += cell.outerW + 2;
    }
    if (row.length) rows.push(row);

    this.rooms = [];
    this.roomByZone = new Map();
    let y = 3;
    let maxRight = ROOMS_X + 20;
    this.streets = [];
    rows.forEach((r, rowIndex) => {
      let x = ROOMS_X;
      const outerH = ROOM_INNER_H + 1;
      const streetTop = y + outerH + 1;
      for (const { zone, D, outerW } of r) {
        const room = this.makeRoom(zone, D, x * T, y * T, outerW * T, outerH * T, rowIndex, (streetTop + STREET_H / 2) * T);
        this.rooms.push(room);
        this.roomByZone.set(zone.id, room);
        x += outerW + 2;
      }
      maxRight = Math.max(maxRight, x);
      this.streets.push({ y: streetTop * T, h: STREET_H * T, right: x * T, centerY: (streetTop + STREET_H / 2) * T });
      y = streetTop + STREET_H + ROW_GAP;
    });
    if (!rows.length) this.streets.push({ y: 6 * T, h: STREET_H * T, right: 30 * T, centerY: 7.5 * T });

    this.world = { w: (maxRight + 4) * T, h: (Math.max(y, 14) + 2) * T };
    const firstStreet = this.streets[0];
    this.avenue = { x: AVENUE_X * T, w: 3 * T, top: 2 * T, bottom: this.streets[this.streets.length - 1].y + this.streets[this.streets.length - 1].h, centerX: (AVENUE_X + 1.5) * T };
    this.mailbox = { x: (AVENUE_X + 3.2) * T, y: firstStreet.y - 30 };
    this.renderStatic();
  }

  makeRoom(zone, D, x, y, w, h, row, streetY) {
    const ix = x + WALL;
    const iy = y + WALL;
    const iw = w - 2 * WALL;
    const ih = h - 2 * WALL;
    const desks = [];
    for (let k = 0; k < 2 * D; k++) {
      const r = k < D ? 0 : 1;
      const c = k % D;
      const dx = ix + (2 + 4 * c) * T;
      desks.push({ x: dx, y: iy + DESK_Y[r] * T, seatX: dx + T, seatY: iy + SEAT_Y[r] * T });
    }
    const doorX = ix + Math.floor(iw / 2 / T) * T;
    const gaps = [];
    for (let k = 0; k <= D; k++) gaps.push(ix + (1 + 4 * k) * T);
    const seed = P.hash(zone.id);
    const items = [];
    const options = P.WALL_ITEMS[zone.theme] ?? P.WALL_ITEMS.garden;
    let cx = ix + 6;
    let i = seed % options.length;
    while (true) {
      const [kind, iwid, ihgt] = options[i % options.length];
      if (cx + iwid > ix + iw - 6) break;
      items.push({ kind, x: cx, y: iy + 2.65 * T - ihgt, w: iwid, h: ihgt });
      cx += iwid + 8 + ((seed >> (i % 16)) & 7);
      i++;
    }
    return {
      zone,
      x, y, w, h, ix, iy, iw, ih, D, row, desks, gaps, items,
      lanes: [iy + LANE_A * T, iy + LANE_B * T, iy + LANE_C * T],
      door: { x: doorX, inY: iy + 10.65 * T, outY: y + h + 6 },
      streetY,
    };
  }

  renderStatic() {
    const { w, h } = this.world;
    const c = this.staticLayer;
    c.width = w;
    c.height = h;
    const ctx = c.getContext("2d");
    ctx.imageSmoothingEnabled = false;
    P.drawGrass(ctx, w, h, 7);

    // paths
    P.drawPath(ctx, this.avenue.x, this.avenue.top, this.avenue.w, this.avenue.bottom - this.avenue.top, 11);
    this.streets.forEach((s, i) => P.drawPath(ctx, this.avenue.x, s.y, s.right - this.avenue.x, s.h, 20 + i));
    for (const room of this.rooms) {
      P.drawPath(ctx, room.door.x - T, room.y + room.h - 2, 2 * T, room.streetY - T * 1.5 - (room.y + room.h) + 4, P.hash(room.zone.id));
    }

    // scenery on free grass
    this.drawScenery(ctx);

    for (const room of this.rooms) this.drawRoom(ctx, room);
    // lamp posts along streets
    for (const s of this.streets) {
      for (let x = this.avenue.x + 8 * T; x < s.right - 2 * T; x += 14 * T) {
        if (this.rooms.some((r) => Math.abs(r.door.x - x) < 3 * T && Math.abs(r.streetY - (s.y + s.h / 2)) < T)) continue;
        P.drawLampPost(ctx, x, s.y - 26);
      }
    }
    P.drawSignpost(ctx, this.avenue.x + 2, this.avenue.top - 6);
  }

  drawScenery(ctx) {
    const { w, h } = this.world;
    const r = P.rng(99 + this.rooms.length);
    const blocked = (x, y, bw, bh) => {
      const pad = 6;
      const hit = (a) => x < a.x + a.w + pad && x + bw > a.x - pad && y < a.y + a.h + pad && y + bh > a.y - pad;
      if (this.rooms.some((room) => hit({ x: room.x, y: room.y, w: room.w, h: room.h + 2 * T }))) return true;
      if (this.streets.some((s) => hit({ x: this.avenue.x, y: s.y - 30, w: s.right - this.avenue.x, h: s.h + 30 }))) return true;
      if (hit({ x: this.avenue.x - 4, y: this.avenue.top - 10, w: this.avenue.w + 50, h: this.avenue.bottom - this.avenue.top + 10 })) return true;
      return false;
    };
    const placed = [];
    const free = (x, y, bw, bh) => !blocked(x, y, bw, bh) && !placed.some((p) => x < p.x + p.w && x + bw > p.x && y < p.y + p.h && y + bh > p.y);
    const attempts = Math.floor((w * h) / 900);
    const things = [];
    for (let i = 0; i < attempts; i++) {
      const kind = r();
      const x = Math.floor(r() * (w - 28));
      const y = Math.floor(r() * (h - 30));
      if (kind < 0.35 && free(x, y, 28, 30)) {
        placed.push({ x, y, w: 28, h: 30 });
        things.push(["tree", x, y]);
      } else if (kind < 0.6 && free(x, y, 16, 13)) {
        placed.push({ x, y, w: 16, h: 13 });
        things.push(["bush", x, y]);
      } else if (kind < 0.9 && free(x, y, 14, 10)) {
        placed.push({ x, y, w: 14, h: 10 });
        things.push(["flowers", x, y]);
      }
    }
    things.sort((a, b) => a[2] - b[2]);
    for (const [kind, x, y] of things) {
      if (kind === "tree") P.drawTree(ctx, x, y, x * 31 + y);
      else if (kind === "bush") P.drawBush(ctx, x, y, x * 17 + y);
      else P.drawFlowers(ctx, x, y, x * 7 + y);
    }
  }

  drawRoom(ctx, room) {
    const { x, y, w, h, ix, iy, iw, ih, zone } = room;
    const style = P.THEME_STYLE[zone.theme] ?? P.THEME_STYLE.garden;
    const seed = P.hash(zone.id);

    // drop shadow + wall mass
    ctx.fillStyle = "rgba(30,50,20,0.18)";
    ctx.fillRect(x + 4, y + 6, w, h);
    P.rect(ctx, x, y, w, h, P.OUTLINE);
    P.rect(ctx, x + 1, y + 1, w - 2, h - 2, "#d8d3c8");
    P.rect(ctx, x + 1, y + 1, w - 2, 3, "#f1ede5");

    P.drawFloor(ctx, ix, iy, iw, ih, zone.theme, seed);
    // back wall face
    const wallH = 2.6 * T;
    P.rect(ctx, ix, iy, iw, wallH, style.wall);
    for (let xx = ix + 12; xx < ix + iw; xx += 16) P.rect(ctx, xx, iy, 1, wallH - 4, P.shade(style.wall, -0.05));
    P.rect(ctx, ix, iy + wallH - 4, iw, 4, style.trim);
    P.rect(ctx, ix, iy + wallH, iw, 2, "rgba(0,0,0,0.12)");
    // inner wall outline
    P.rect(ctx, ix - 1, iy - 1, iw + 2, 1, P.OUTLINE);
    P.rect(ctx, ix - 1, iy - 1, 1, ih + 2, P.OUTLINE);
    P.rect(ctx, ix + iw, iy - 1, 1, ih + 2, P.OUTLINE);

    for (const item of room.items) P.drawWallItem(ctx, item.kind, item.x, item.y, seed + item.x);

    // rug in front of the door
    P.drawRug(ctx, room.door.x - 2.5 * T, iy + 9.95 * T, 5 * T, 0.9 * T, style.accent);

    for (const desk of room.desks) P.drawDesk(ctx, desk.x, desk.y, seed + desk.x * 3 + desk.y);

    // bottom wall with a door gap
    const doorL = room.door.x - T;
    const doorR = room.door.x + T;
    P.rect(ctx, ix - 1, iy + ih, doorL - ix + 1, 1, P.OUTLINE);
    P.rect(ctx, doorR, iy + ih, ix + iw - doorR + 1, 1, P.OUTLINE);
    P.rect(ctx, doorL, iy + ih, doorR - doorL, WALL, "#c9a36b");
    for (let xx = doorL + 3; xx < doorR; xx += 5) P.rect(ctx, xx, iy + ih + 1, 1, WALL - 2, "#b38c56");
    P.rect(ctx, doorL - 2, iy + ih - 2, 2, WALL + 2, P.OUTLINE);
    P.rect(ctx, doorR, iy + ih - 2, 2, WALL + 2, P.OUTLINE);
    P.rect(ctx, x, y + h - 1, doorL - x - 2, 1, P.OUTLINE);
    P.rect(ctx, doorR + 2, y + h - 1, x + w - doorR - 2, 1, P.OUTLINE);
    // accent stripe on the outer top wall
    P.rect(ctx, x + 1, y + 1, w - 2, 2, style.accent);
  }

  // ── Positions & routing ───────────────────────────────────────────

  mailboxSpot() {
    return { x: this.mailbox.x + 9, y: this.mailbox.y + 34 };
  }

  agentsInZone(zoneId) {
    return this.state.agents
      .filter((a) => a.zoneId === zoneId)
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  }

  deskFor(agent) {
    const room = this.roomByZone.get(agent.zoneId);
    if (!room) return null;
    const index = this.agentsInZone(agent.zoneId).findIndex((a) => a.id === agent.id);
    const desk = room.desks[index];
    return desk ? { room, desk } : null;
  }

  homeSpot(agent) {
    const d = this.deskFor(agent);
    if (d) return { x: d.desk.seatX, y: d.desk.seatY, seated: true };
    const room = this.roomByZone.get(agent.zoneId);
    if (room) return { x: room.door.x + 20, y: room.lanes[2], seated: false };
    return null;
  }

  roomAt(p) {
    return this.rooms.find((r) => p.x >= r.ix - 2 && p.x <= r.ix + r.iw + 2 && p.y >= r.iy - 2 && p.y <= r.iy + r.ih + 3);
  }

  nearestLane(room, y) {
    let best = room.lanes[0];
    for (const l of room.lanes) if (Math.abs(l - y) < Math.abs(best - y)) best = l;
    return best;
  }

  inRoomRoute(room, from, to) {
    const la = this.nearestLane(room, from.y);
    const lb = this.nearestLane(room, to.y);
    const pts = [{ x: from.x, y: la }];
    if (la !== lb) {
      const mid = (from.x + to.x) / 2;
      let gx = room.gaps[0];
      for (const g of room.gaps) if (Math.abs(g - mid) < Math.abs(gx - mid)) gx = g;
      pts.push({ x: gx, y: la }, { x: gx, y: lb });
    }
    pts.push({ x: to.x, y: lb }, { x: to.x, y: to.y });
    return pts;
  }

  streetFor(room) {
    return room ? room.streetY : this.streets[0].centerY;
  }

  route(from, to) {
    const ra = this.roomAt(from);
    const rb = this.roomAt(to);
    if (ra && ra === rb) return this.inRoomRoute(ra, from, to);
    const pts = [];
    let sy;
    if (ra) {
      pts.push(...this.inRoomRoute(ra, from, { x: ra.door.x, y: ra.door.inY }));
      pts.push({ x: ra.door.x, y: ra.door.outY }, { x: ra.door.x, y: ra.streetY });
      sy = ra.streetY;
    } else {
      // Outside: step onto the nearest street first.
      sy = this.streets.reduce((best, s) => (Math.abs(s.centerY - from.y) < Math.abs(best - from.y) ? s.centerY : best), this.streets[0].centerY);
      if (from.x < this.avenue.x + this.avenue.w && Math.abs(from.y - sy) > T) {
        pts.push({ x: this.avenue.centerX, y: from.y });
      }
      pts.push({ x: pts.length ? this.avenue.centerX : from.x, y: sy });
    }
    const targetStreet = rb ? rb.streetY : to.y;
    if (Math.abs(targetStreet - sy) > 2) {
      pts.push({ x: this.avenue.centerX, y: sy }, { x: this.avenue.centerX, y: targetStreet });
    }
    if (rb) {
      pts.push({ x: rb.door.x, y: rb.streetY }, { x: rb.door.x, y: rb.door.outY }, { x: rb.door.x, y: rb.door.inY });
      pts.push(...this.inRoomRoute(rb, { x: rb.door.x, y: rb.door.inY }, to));
    } else {
      pts.push({ x: to.x, y: targetStreet }, { x: to.x, y: to.y });
    }
    return pts;
  }

  /** Where an agent wants to be right now, given what it is doing. */
  desiredSpot(agent, sprite, now) {
    const room = this.roomByZone.get(agent.zoneId);
    if (!room) return { key: "lost", ...this.mailboxSpot(), seated: false, face: 0 };
    if (agent.status === "paused") {
      if (!sprite.pauseSpot || sprite.pauseZone !== agent.zoneId) {
        sprite.pauseZone = agent.zoneId;
        sprite.pauseSpot = this.roomAt(sprite) === room ? { x: sprite.x, y: sprite.y } : this.homeSpot(agent);
      }
      return { key: `pause:${agent.zoneId}`, x: sprite.pauseSpot.x, y: sprite.pauseSpot.y, seated: sprite.seated, face: sprite.dir };
    }
    sprite.pauseSpot = null;

    if (agent.status === "working" && agent.focus?.kind === "conversation" && agent.focus.withAgentId) {
      const other = this.sprites.get(agent.focus.withAgentId);
      const otherRoom = other && this.roomAt(other);
      if (other && otherRoom && !other.path.length) {
        const side = other.x + 15 < otherRoom.ix + otherRoom.iw - 8 ? 1 : -1;
        const x = other.x + side * 15;
        const y = other.seated ? other.y : this.nearestLane(otherRoom, other.y);
        return { key: `talk:${other.id}:${Math.round(x / 8)}:${Math.round(y / 8)}`, x, y, seated: false, face: side > 0 ? 3 : 2 };
      }
    }

    const home = this.deskFor(agent);
    if (agent.status === "working") {
      if (home) return { key: `desk:${agent.zoneId}:${home.desk.seatX}:${home.desk.seatY}`, x: home.desk.seatX, y: home.desk.seatY, seated: true, face: 1 };
      return { key: `work:${agent.zoneId}`, x: room.door.x + 18, y: room.lanes[2], seated: false, face: 1 };
    }

    // Idle: potter about the room, sometimes back at the desk.
    if (sprite.wanderZone !== agent.zoneId || (!sprite.path.length && now > sprite.idleUntil && sprite.arrived)) {
      sprite.wanderZone = agent.zoneId;
      sprite.wanderN++;
      const r = P.rng(P.hash(agent.id) + sprite.wanderN * 977);
      const roll = r();
      if (home && roll < 0.3) {
        sprite.wanderSpot = { x: home.desk.seatX, y: home.desk.seatY, seated: true, face: 1 };
      } else if (roll < 0.6 && room.items.length) {
        const item = room.items[Math.floor(r() * room.items.length)];
        sprite.wanderSpot = { x: item.x + item.w / 2, y: room.lanes[0], seated: false, face: 1 };
      } else {
        const lane = room.lanes[1 + Math.floor(r() * 2)];
        sprite.wanderSpot = { x: room.ix + T * 1.5 + r() * (room.iw - T * 3), y: lane, seated: false, face: r() > 0.5 ? 0 : 2 + Math.floor(r() * 2) };
      }
      sprite.idleUntil = now + 5000 + r() * 9000;
    }
    const s = sprite.wanderSpot;
    return { key: `wander:${agent.zoneId}:${sprite.wanderN}`, ...s };
  }

  // ── Camera & input ────────────────────────────────────────────────

  resize() {
    const parent = this.canvas.parentElement;
    const w = parent.clientWidth;
    const h = parent.clientHeight;
    this.dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.max(1, Math.floor(w * this.dpr));
    this.canvas.height = Math.max(1, Math.floor(h * this.dpr));
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.view = { w, h };
    if (!this.userMovedCamera && this.state) this.fit(false);
  }

  fit(animate = true) {
    const { w, h } = this.view;
    const z = Math.max(0.75, Math.min(4, Math.min(w / (this.world.w + 32), h / (this.world.h + 32))));
    const zz = z >= 1 ? Math.floor(z * 4) / 4 : z;
    const target = { z: zz, x: this.world.w / 2 - w / (2 * zz), y: this.world.h / 2 - h / (2 * zz) };
    if (animate) this.camTarget = target;
    else Object.assign(this.cam, target);
    this.userMovedCamera = false;
  }

  focusOn(wx, wy, z) {
    const zz = Math.max(this.cam.z, z ?? 2.5);
    this.camTarget = { z: zz, x: wx - this.view.w / (2 * zz), y: wy - this.view.h / (2 * zz) };
    this.userMovedCamera = true;
  }

  focusAgent(id) {
    const s = this.sprites.get(id);
    if (s) this.focusOn(s.x, s.y - 20, 3);
  }

  focusZone(id) {
    const room = this.roomByZone.get(id);
    if (!room) return;
    const z = Math.min(4, Math.max(1.5, Math.min(this.view.w / (room.w + 64), this.view.h / (room.h + 96))));
    this.camTarget = { z, x: room.x + room.w / 2 - this.view.w / (2 * z), y: room.y + room.h / 2 - this.view.h / (2 * z) };
    this.userMovedCamera = true;
  }

  zoomBy(factor, sx = this.view.w / 2, sy = this.view.h / 2) {
    const z0 = this.cam.z;
    const z1 = Math.max(0.5, Math.min(6, z0 * factor));
    const wx = this.cam.x + sx / z0;
    const wy = this.cam.y + sy / z0;
    this.cam.z = z1;
    this.cam.x = wx - sx / z1;
    this.cam.y = wy - sy / z1;
    this.camTarget = null;
    this.userMovedCamera = true;
  }

  toWorld(sx, sy) {
    return { x: this.cam.x + sx / this.cam.z, y: this.cam.y + sy / this.cam.z };
  }

  bindInput() {
    const c = this.canvas;
    let drag = null;
    c.addEventListener("pointerdown", (e) => {
      c.setPointerCapture(e.pointerId);
      drag = { x: e.clientX, y: e.clientY, camX: this.cam.x, camY: this.cam.y, moved: false };
    });
    c.addEventListener("pointermove", (e) => {
      const rect = c.getBoundingClientRect();
      if (drag) {
        const dx = e.clientX - drag.x;
        const dy = e.clientY - drag.y;
        if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
        if (drag.moved) {
          this.cam.x = drag.camX - dx / this.cam.z;
          this.cam.y = drag.camY - dy / this.cam.z;
          this.camTarget = null;
          this.userMovedCamera = true;
          c.style.cursor = "grabbing";
          return;
        }
      }
      this.hover = this.hitTest(e.clientX - rect.left, e.clientY - rect.top);
      c.style.cursor = this.hover ? "pointer" : "grab";
    });
    c.addEventListener("pointerup", (e) => {
      const rect = c.getBoundingClientRect();
      if (drag && !drag.moved) {
        const hit = this.hitTest(e.clientX - rect.left, e.clientY - rect.top);
        this.handlers.onPick(hit);
      }
      drag = null;
      c.style.cursor = this.hover ? "pointer" : "grab";
    });
    c.addEventListener("pointerleave", () => {
      this.hover = null;
    });
    c.addEventListener("dblclick", (e) => {
      const rect = c.getBoundingClientRect();
      const hit = this.hitTest(e.clientX - rect.left, e.clientY - rect.top);
      if (hit?.type === "zone") this.focusZone(hit.id);
      else if (hit?.type === "agent") this.focusAgent(hit.id);
    });
    c.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        const rect = c.getBoundingClientRect();
        this.zoomBy(Math.exp(-e.deltaY * 0.0015), e.clientX - rect.left, e.clientY - rect.top);
      },
      { passive: false },
    );
  }

  hitTest(sx, sy) {
    if (!this.state) return null;
    const p = this.toWorld(sx, sy);
    const sprites = [...this.sprites.values()].sort((a, b) => b.y - a.y);
    for (const s of sprites) {
      if (p.x >= s.x - 7 && p.x <= s.x + 7 && p.y >= s.y - 24 && p.y <= s.y + 2) return { type: "agent", id: s.id };
    }
    // bubbles (screen space)
    for (const b of this.bubbleRects ?? []) {
      if (sx >= b.x && sx <= b.x + b.w && sy >= b.y && sy <= b.y + b.h) return { type: "agent", id: b.id };
    }
    const m = this.mailbox;
    if (p.x >= m.x - 2 && p.x <= m.x + 28 && p.y >= m.y - 10 && p.y <= m.y + 30) return { type: "inbox" };
    for (const l of this.labelRects ?? []) {
      if (sx >= l.x && sx <= l.x + l.w && sy >= l.y && sy <= l.y + l.h) return { type: "zone", id: l.id };
    }
    const room = this.rooms.find((r) => p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h);
    if (room) return { type: "zone", id: room.zone.id };
    return null;
  }

  // ── Frame loop ────────────────────────────────────────────────────

  frame(t) {
    const dt = Math.min(0.1, (t - this.last) / 1000);
    this.last = t;
    if (this.state) {
      this.update(dt, t);
      this.draw(t);
    }
    requestAnimationFrame((tt) => this.frame(tt));
  }

  update(dt, now) {
    if (this.camTarget) {
      const k = 1 - Math.pow(0.001, dt);
      this.cam.x += (this.camTarget.x - this.cam.x) * k;
      this.cam.y += (this.camTarget.y - this.cam.y) * k;
      this.cam.z += (this.camTarget.z - this.cam.z) * k;
      if (Math.abs(this.camTarget.x - this.cam.x) < 0.5 && Math.abs(this.camTarget.z - this.cam.z) < 0.01) {
        Object.assign(this.cam, this.camTarget);
        this.camTarget = null;
      }
    }
    for (const agent of this.state.agents) {
      const sprite = this.sprites.get(agent.id);
      if (!sprite) continue;
      if (agent.activity !== sprite.lastActivity) {
        sprite.lastActivity = agent.activity;
        sprite.activitySince = now;
      }
      const want = this.desiredSpot(agent, sprite, now);
      if (want.key !== sprite.targetKey) {
        sprite.targetKey = want.key;
        sprite.path = this.route({ x: sprite.x, y: sprite.y }, { x: want.x, y: want.y });
        sprite.seated = false;
        sprite.arrived = false;
      }
      sprite.step(dt, want);
    }
    this.envelopes = this.envelopes.filter((e) => now - e.t0 < e.dur);
  }

  draw(now) {
    const ctx = this.ctx;
    const { z } = this.cam;
    const dpr = this.dpr;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = P.GRASS;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.imageSmoothingEnabled = false;
    ctx.setTransform(dpr * z, 0, 0, dpr * z, -this.cam.x * dpr * z, -this.cam.y * dpr * z);
    ctx.drawImage(this.staticLayer, 0, 0);

    // selected room glow
    if (this.selection?.type === "zone" || this.hover?.type === "zone") {
      for (const sel of [this.selection, this.hover]) {
        if (sel?.type !== "zone") continue;
        const room = this.roomByZone.get(sel.id);
        if (!room) continue;
        const pulse = sel === this.selection ? 0.55 + 0.35 * Math.sin(now / 300) : 0.35;
        ctx.strokeStyle = `rgba(255, 214, 90, ${pulse})`;
        ctx.lineWidth = 3;
        ctx.strokeRect(room.x - 2, room.y - 2, room.w + 4, room.h + 4);
      }
    }

    // monitors of people working at their desks
    for (const agent of this.state.agents) {
      const sprite = this.sprites.get(agent.id);
      if (!sprite?.seated || agent.status !== "working") continue;
      const d = this.deskFor(agent);
      if (d) P.drawScreenActivity(ctx, d.desk.x, d.desk.y, now + sprite.phase, agent.activity === "error" ? "#ff9a9a" : "#9fd0ff");
    }

    // y-sorted: chairs, agents, mailbox
    const drawables = [];
    const seatedAt = new Set();
    for (const sprite of this.sprites.values()) {
      if (sprite.seated) seatedAt.add(`${Math.round(sprite.x)}:${Math.round(sprite.y)}`);
    }
    for (const room of this.rooms) {
      for (const desk of room.desks) {
        if (!seatedAt.has(`${Math.round(desk.seatX)}:${Math.round(desk.seatY)}`)) {
          drawables.push({ y: desk.seatY - 1, draw: () => P.drawChairBack(ctx, desk.seatX, desk.seatY) });
        }
      }
    }
    for (const sprite of this.sprites.values()) {
      const agent = this.state.agents.find((a) => a.id === sprite.id);
      if (!agent) continue;
      drawables.push({
        y: sprite.y,
        draw: () => {
          const selected = this.selection?.type === "agent" && this.selection.id === sprite.id;
          if (selected) {
            const pulse = 0.5 + 0.4 * Math.sin(now / 250);
            ctx.fillStyle = `rgba(255, 214, 90, ${pulse})`;
            ctx.fillRect(Math.round(sprite.x) - 8, Math.round(sprite.y) - 2, 16, 4);
            ctx.fillRect(Math.round(sprite.x) - 6, Math.round(sprite.y) - 3, 12, 6);
          }
          P.drawCharacter(ctx, sprite.x, sprite.y, agent.appearance, sprite.dir, sprite.frame, {
            seated: sprite.seated,
            alpha: agent.status === "paused" ? 0.6 : 1,
          });
          if (sprite.seated) P.drawChairBack(ctx, sprite.x, sprite.y);
        },
      });
    }
    drawables.push({ y: this.mailbox.y + 26, draw: () => P.drawMailbox(ctx, this.mailbox.x, this.mailbox.y, this.unread > 0) });
    drawables.sort((a, b) => a.y - b.y);
    for (const d of drawables) d.draw();

    // envelopes in flight
    for (const e of this.envelopes) {
      const p = Math.min(1, (now - e.t0) / e.dur);
      const end = e.toFn();
      const ex = end.x;
      const ey = end.y - 14;
      const ease = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
      const x = e.start.x + (ex - e.start.x) * ease;
      const arc = Math.min(60, 18 + Math.hypot(ex - e.start.x, ey - e.start.y) * 0.18);
      const y = e.start.y + (ey - e.start.y) * ease - Math.sin(Math.PI * p) * arc;
      if (e.kind === "task") P.drawClipboard(ctx, Math.round(x) - 4, Math.round(y) - 5);
      else P.drawEnvelope(ctx, Math.round(x) - 5, Math.round(y) - 3);
      if (e.kind === "report") {
        ctx.fillStyle = "#f2c94c";
        ctx.fillRect(Math.round(x) + 4, Math.round(y) - 5, 2, 2);
      }
    }

    // ── screen-space overlay ──
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.drawBubbles(ctx, now);
    this.drawLabels(ctx);
    this.drawMailboxBadge(ctx);
    this.drawHoverTag(ctx);
  }

  screen(wx, wy) {
    return { x: (wx - this.cam.x) * this.cam.z, y: (wy - this.cam.y) * this.cam.z };
  }

  drawLabels(ctx) {
    this.labelRects = [];
    ctx.font = "700 12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
    ctx.textBaseline = "middle";
    for (const room of this.rooms) {
      const style = P.THEME_STYLE[room.zone.theme] ?? P.THEME_STYLE.garden;
      const p = this.screen(room.x + room.w / 2, room.y);
      const count = this.state.agents.filter((a) => a.zoneId === room.zone.id).length;
      const working = this.state.agents.filter((a) => a.zoneId === room.zone.id && a.status === "working").length;
      const text = room.zone.name;
      const meta = working ? `${working}/${count} busy` : `${count}`;
      const tw = ctx.measureText(text).width;
      ctx.font = "500 11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
      const mw = ctx.measureText(meta).width;
      ctx.font = "700 12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
      const repo = room.zone.workspace ? 20 : 0;
      const w = 22 + tw + 10 + mw + 10 + repo;
      const h = 22;
      const x = Math.round(p.x - w / 2);
      const y = Math.round(p.y - h - 6);
      const selected = this.selection?.type === "zone" && this.selection.id === room.zone.id;
      ctx.fillStyle = "rgba(42,35,32,0.25)";
      ctx.fillRect(x + 2, y + 3, w, h);
      ctx.fillStyle = selected ? "#fff3c4" : "#fffaf0";
      ctx.fillRect(x, y, w, h);
      ctx.strokeStyle = P.OUTLINE;
      ctx.lineWidth = 2;
      ctx.strokeRect(x + 1, y + 1, w - 2, h - 2);
      ctx.fillStyle = style.accent;
      ctx.fillRect(x + 7, y + 7, 8, 8);
      ctx.fillStyle = P.OUTLINE;
      ctx.fillText(text, x + 21, y + h / 2 + 1);
      ctx.font = "500 11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
      ctx.fillStyle = working ? "#2f7d4f" : "#7a6f66";
      ctx.fillText(meta, x + 21 + tw + 10, y + h / 2 + 1);
      if (repo) ctx.drawImage(P.icon("repo", 2), x + w - 24, y + 2);
      this.labelRects.push({ x, y, w, h, id: room.zone.id });
    }
  }

  drawBubbles(ctx, now) {
    const z = this.cam.z;
    const compact = z < 0.9;
    const bubbles = [];
    ctx.font = "700 11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
    for (const agent of this.state.agents) {
      const sprite = this.sprites.get(agent.id);
      if (!sprite) continue;
      const head = this.screen(sprite.x, sprite.y - 24);
      let iconName = P.ACTIVITY_ICON[agent.activity] ?? "think";
      if (agent.status === "paused") iconName = "pause";
      else if (agent.status === "error") iconName = "error";
      else if (agent.activity === "done" && now - (sprite.activitySince ?? 0) > 7000) iconName = "idle";
      if (agent.status === "idle" && iconName === "idle" && now - (sprite.activitySince ?? 0) > 120000) iconName = "sleep";
      const speaking = sprite.speech && now < sprite.speechUntil;
      const selected = this.selection?.type === "agent" && this.selection.id === agent.id;
      const label = compact ? "" : `${agent.name.length > 8 ? agent.name.slice(0, 7) + "…" : agent.name}:`;
      let lines = [];
      if (speaking && !compact) lines = wrap(ctx, sprite.speech, 190, 2);
      const labelW = label ? ctx.measureText(label).width + 6 : 0;
      const iconW = 18;
      const textW = lines.length ? Math.max(...lines.map((l) => ctx.measureText(l).width)) : 0;
      const w = Math.ceil(Math.max(labelW + iconW, textW) + 12);
      const h = 24 + lines.length * 14;
      bubbles.push({ agent, sprite, x: Math.round(head.x - 10), y: Math.round(head.y - h - 4), w, h, label, labelW, iconName, lines, selected, ax: head.x, ay: head.y });
    }
    // Nudge overlapping bubbles upward so names stay readable.
    bubbles.sort((a, b) => b.ay - a.ay);
    const placed = [];
    for (const b of bubbles) {
      let guard = 0;
      while (placed.some((p) => b.x < p.x + p.w + 2 && b.x + b.w + 2 > p.x && b.y < p.y + p.h + 2 && b.y + b.h + 2 > p.y) && guard++ < 12) {
        const hit = placed.find((p) => b.x < p.x + p.w + 2 && b.x + b.w + 2 > p.x && b.y < p.y + p.h + 2 && b.y + b.h + 2 > p.y);
        b.y = hit.y - b.h - 3;
      }
      placed.push(b);
    }
    this.bubbleRects = [];
    for (const b of placed.reverse()) {
      ctx.fillStyle = "rgba(42,35,32,0.22)";
      ctx.fillRect(b.x + 2, b.y + 3, b.w, b.h);
      ctx.fillStyle = b.selected ? "#fff3c4" : "#ffffff";
      ctx.fillRect(b.x, b.y, b.w, b.h);
      ctx.strokeStyle = b.selected ? "#c47f00" : P.OUTLINE;
      ctx.lineWidth = 2;
      ctx.strokeRect(b.x + 1, b.y + 1, b.w - 2, b.h - 2);
      // tail toward the head (only when the bubble sits right above it)
      if (b.ay - (b.y + b.h) < 12) {
        ctx.fillStyle = b.selected ? "#fff3c4" : "#ffffff";
        ctx.fillRect(b.x + 6, b.y + b.h - 2, 6, 4);
        ctx.fillStyle = b.selected ? "#c47f00" : P.OUTLINE;
        ctx.fillRect(b.x + 4, b.y + b.h - 1, 2, 4);
        ctx.fillRect(b.x + 12, b.y + b.h - 1, 2, 3);
        ctx.fillRect(b.x + 6, b.y + b.h + 2, 6, 2);
      } else {
        ctx.strokeStyle = "rgba(42,35,32,0.35)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(b.x + 9, b.y + b.h);
        ctx.lineTo(b.ax, b.ay - 2);
        ctx.stroke();
      }
      ctx.fillStyle = P.OUTLINE;
      ctx.textBaseline = "middle";
      if (b.label) ctx.fillText(b.label, b.x + 7, b.y + 12);
      ctx.drawImage(P.icon(b.iconName, 2), b.x + 6 + b.labelW, b.y + 3);
      ctx.fillStyle = "#3d3530";
      ctx.font = "500 11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
      b.lines.forEach((line, i) => ctx.fillText(line, b.x + 7, b.y + 30 + i * 14));
      ctx.font = "700 11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
      this.bubbleRects.push({ x: b.x, y: b.y, w: b.w, h: b.h, id: b.agent.id });
    }
  }

  drawMailboxBadge(ctx) {
    const p = this.screen(this.mailbox.x + 9, this.mailbox.y);
    const text = this.unread ? `Inbox ${this.unread}` : "Inbox";
    ctx.font = "700 11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
    const w = ctx.measureText(text).width + 14;
    const x = Math.round(p.x - w / 2);
    const y = Math.round(p.y - 34);
    ctx.fillStyle = this.unread ? "#d9534f" : "#fffaf0";
    ctx.fillRect(x, y, w, 18);
    ctx.strokeStyle = P.OUTLINE;
    ctx.lineWidth = 2;
    ctx.strokeRect(x + 1, y + 1, w - 2, 16);
    ctx.fillStyle = this.unread ? "#ffffff" : P.OUTLINE;
    ctx.textBaseline = "middle";
    ctx.fillText(text, x + 7, y + 10);
  }

  drawHoverTag(ctx) {
    if (this.hover?.type !== "agent") return;
    const agent = this.state.agents.find((a) => a.id === this.hover.id);
    const sprite = this.sprites.get(this.hover.id);
    if (!agent || !sprite) return;
    const p = this.screen(sprite.x, sprite.y + 4);
    const zone = this.state.zones.find((zz) => zz.id === agent.zoneId);
    const text = `${agent.name} · ${agent.title}${zone ? ` · ${zone.name}` : ""}`;
    ctx.font = "600 11px ui-sans-serif, system-ui, sans-serif";
    const w = ctx.measureText(text).width + 12;
    const x = Math.round(p.x - w / 2);
    const y = Math.round(p.y + 2);
    ctx.fillStyle = "rgba(42,35,32,0.92)";
    ctx.fillRect(x, y, w, 18);
    ctx.fillStyle = "#fffaf0";
    ctx.textBaseline = "middle";
    ctx.fillText(text, x + 6, y + 9.5);
  }
}

function wrap(ctx, text, maxW, maxLines) {
  const words = text.split(" ");
  const lines = [];
  let line = "";
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (ctx.measureText(next).width > maxW && line) {
      lines.push(line);
      line = word;
      if (lines.length === maxLines) break;
    } else {
      line = next;
    }
  }
  if (lines.length < maxLines && line) lines.push(line);
  if (lines.length === maxLines && words.join(" ").length > lines.join(" ").length) {
    let last = lines[maxLines - 1];
    while (ctx.measureText(`${last}…`).width > maxW && last.length) last = last.slice(0, -1);
    lines[maxLines - 1] = `${last}…`;
  }
  return lines;
}

class Sprite {
  constructor(id, x, y, seated) {
    this.id = id;
    this.x = x;
    this.y = y;
    this.path = [];
    this.dir = seated ? 1 : 0;
    this.frame = 0;
    this.walkT = 0;
    this.seated = seated;
    this.arrived = true;
    this.targetKey = null;
    this.idleUntil = 0;
    this.wanderN = 0;
    this.wanderZone = null;
    this.phase = Math.random() * 1000;
    this.speech = "";
    this.speechUntil = 0;
  }

  step(dt, want) {
    let budget = WALK_SPEED * dt;
    let moved = false;
    while (budget > 0 && this.path.length) {
      const next = this.path[0];
      const dx = next.x - this.x;
      const dy = next.y - this.y;
      const dist = Math.hypot(dx, dy);
      if (dist < 0.01) {
        this.path.shift();
        continue;
      }
      if (Math.abs(dx) > Math.abs(dy)) this.dir = dx > 0 ? 2 : 3;
      else this.dir = dy > 0 ? 0 : 1;
      if (dist <= budget) {
        this.x = next.x;
        this.y = next.y;
        budget -= dist;
        this.path.shift();
      } else {
        this.x += (dx / dist) * budget;
        this.y += (dy / dist) * budget;
        budget = 0;
      }
      moved = true;
    }
    if (moved) {
      this.walkT += dt;
      this.frame = Math.floor(this.walkT * 7) % 4;
      this.seated = false;
    } else {
      this.frame = 0;
      if (!this.arrived) {
        this.arrived = true;
        this.seated = Boolean(want.seated);
        this.dir = want.seated ? 1 : want.face ?? this.dir;
      }
    }
  }
}
