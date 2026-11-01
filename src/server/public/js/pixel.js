// Procedural pixel art: characters, icons, furniture, floors and scenery.
// Everything is drawn with fillRect at 1 world pixel = 1 art pixel, so it
// stays crisp when the camera scales it up.

export const TILE = 16;
export const OUTLINE = "#2a2320";

export function rect(ctx, x, y, w, h, color) {
  ctx.fillStyle = color;
  ctx.fillRect(Math.round(x), Math.round(y), w, h);
}

function hexToRgb(hex) {
  const h = hex.replace("#", "");
  const n = parseInt(h.length === 3 ? h.split("").map((c) => c + c).join("") : h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Lighten (amt > 0) or darken (amt < 0) a hex colour. */
export function shade(hex, amt) {
  const [r, g, b] = hexToRgb(hex);
  const t = amt < 0 ? 0 : 255;
  const p = Math.abs(amt);
  const mix = (c) => Math.round((t - c) * p + c);
  return `rgb(${mix(r)},${mix(g)},${mix(b)})`;
}

/** Small deterministic RNG so scenery doesn't reshuffle on every redraw. */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  return h >>> 0;
}

// ── Characters ────────────────────────────────────────────────────

/**
 * Draws a character with its feet at (fx, fy).
 * dir: 0 down, 1 up, 2 right, 3 left. frame: 0..3 walk cycle (0 = standing).
 */
export function drawCharacter(ctx, fx, fy, look, dir = 0, frame = 0, opts = {}) {
  const { seated = false, alpha = 1 } = opts;
  if (dir === 3) {
    ctx.save();
    ctx.translate(Math.round(fx) * 2, 0);
    ctx.scale(-1, 1);
    drawCharacter(ctx, fx, fy, look, 2, frame, opts);
    ctx.restore();
    return;
  }
  ctx.save();
  ctx.globalAlpha = alpha;
  const L = Math.round(fx) - 6;
  const T = Math.round(fy) - 21;
  const bob = frame === 1 || frame === 3 ? -1 : 0;
  const skinShade = shade(look.skin, -0.18);
  const shirtShade = shade(look.shirt, -0.22);

  // shadow
  ctx.fillStyle = "rgba(20,30,10,0.22)";
  ctx.fillRect(L + 2, T + 19, 8, 2);
  ctx.fillRect(L + 1, T + 20, 10, 1);

  // legs
  if (!seated) {
    const lUp = frame === 1 ? 1 : 0;
    const rUp = frame === 3 ? 1 : 0;
    if (dir === 2) {
      const swing = frame === 1 ? 1 : frame === 3 ? -1 : 0;
      rect(ctx, L + 4 + swing, T + 14, 4, 6, OUTLINE);
      rect(ctx, L + 5 + swing, T + 15, 2, 4, look.pants);
      rect(ctx, L + 5 - swing, T + 15, 2, 4, shade(look.pants, -0.2));
      rect(ctx, L + 5 + swing, T + 19, 3, 1, OUTLINE);
    } else {
      rect(ctx, L + 2, T + 14, 4, 6 - lUp, OUTLINE);
      rect(ctx, L + 6, T + 14, 4, 6 - rUp, OUTLINE);
      rect(ctx, L + 3, T + 15, 2, 3 - lUp, look.pants);
      rect(ctx, L + 7, T + 15, 2, 3 - rUp, look.pants);
      rect(ctx, L + 3, T + 18 - lUp, 2, 1, "#3a2f2a");
      rect(ctx, L + 7, T + 18 - rUp, 2, 1, "#3a2f2a");
    }
  }

  // body
  const by = T + 8 + bob;
  if (dir === 2) {
    rect(ctx, L + 2, by, 8, 8, OUTLINE);
    rect(ctx, L + 3, by + 1, 6, 6, look.shirt);
    rect(ctx, L + 3, by + 6, 6, 1, shirtShade);
    const swing = frame === 1 ? 1 : frame === 3 ? -1 : 0;
    rect(ctx, L + 5 + swing, by + 2, 2, 4, shirtShade);
    rect(ctx, L + 5 + swing, by + 6, 2, 1, look.skin);
  } else {
    rect(ctx, L + 1, by, 10, 8, OUTLINE);
    rect(ctx, L + 2, by + 1, 8, 6, look.shirt);
    rect(ctx, L + 2, by + 6, 8, 1, shirtShade);
    if (dir === 0) {
      rect(ctx, L + 5, by + 1, 2, 2, shade(look.shirt, 0.25)); // collar
    }
    const swing = frame === 1 ? 1 : frame === 3 ? -1 : 0;
    rect(ctx, L + 1, by + 1 + swing, 1, 4, look.shirt);
    rect(ctx, L + 10, by + 1 - swing, 1, 4, look.shirt);
    rect(ctx, L + 1, by + 5 + swing, 1, 1, look.skin);
    rect(ctx, L + 10, by + 5 - swing, 1, 1, look.skin);
  }

  // head
  const hy = T + 1 + bob;
  rect(ctx, L + 1, hy, 10, 9, OUTLINE);
  rect(ctx, L + 2, hy + 1, 8, 7, look.skin);
  rect(ctx, L + 2, hy + 7, 8, 1, skinShade);

  if (dir === 0) {
    rect(ctx, L + 4, hy + 4, 1, 2, OUTLINE);
    rect(ctx, L + 7, hy + 4, 1, 2, OUTLINE);
    rect(ctx, L + 3, hy + 6, 1, 1, shade(look.skin, -0.08));
    rect(ctx, L + 8, hy + 6, 1, 1, shade(look.skin, -0.08));
  } else if (dir === 2) {
    rect(ctx, L + 8, hy + 4, 1, 2, OUTLINE);
  }
  drawHair(ctx, L, hy, look, dir);
  ctx.restore();
}

function drawHair(ctx, L, hy, look, dir) {
  const hair = look.hair;
  const dark = shade(hair, -0.25);
  const style = look.hairStyle ?? 0;
  if (style === 4) {
    // cap
    rect(ctx, L + 1, hy - 1, 10, 4, OUTLINE);
    rect(ctx, L + 2, hy, 8, 3, look.accent);
    rect(ctx, L + 2, hy + 2, 8, 1, shade(look.accent, -0.25));
    if (dir === 0) rect(ctx, L + 2, hy + 3, 8, 1, shade(look.accent, -0.4));
    if (dir === 2) rect(ctx, L + 8, hy + 3, 4, 1, shade(look.accent, -0.4));
    if (dir === 1) rect(ctx, L + 2, hy + 3, 8, 4, hair);
    return;
  }
  if (dir === 1) {
    rect(ctx, L + 2, hy + 1, 8, 7, hair);
    rect(ctx, L + 2, hy + 6, 8, 1, dark);
    if (style === 1) rect(ctx, L + 2, hy + 8, 8, 3, hair);
    if (style === 3) rect(ctx, L + 4, hy - 2, 4, 3, hair);
    return;
  }
  // front or side
  rect(ctx, L + 2, hy + 1, 8, 2, hair);
  if (dir === 0) {
    rect(ctx, L + 2, hy + 3, 1, 2, hair);
    rect(ctx, L + 9, hy + 3, 1, 2, hair);
    rect(ctx, L + 3, hy + 3, 2, 1, hair);
  } else {
    rect(ctx, L + 2, hy + 3, 4, 3, hair);
  }
  rect(ctx, L + 2, hy + 1, 8, 1, shade(hair, 0.15));
  if (style === 1) {
    rect(ctx, L + 1, hy + 2, 2, 8, hair);
    if (dir === 0) rect(ctx, L + 9, hy + 2, 2, 8, hair);
  } else if (style === 2) {
    rect(ctx, L + 3, hy - 1, 1, 2, hair);
    rect(ctx, L + 5, hy - 2, 2, 3, hair);
    rect(ctx, L + 8, hy - 1, 1, 2, hair);
  } else if (style === 3) {
    rect(ctx, L + 4, hy - 3, 4, 4, OUTLINE);
    rect(ctx, L + 5, hy - 2, 2, 2, hair);
  }
}

/** Chair back drawn over a seated character (we see them from behind). */
export function drawChairBack(ctx, cx, fy, color = "#6b5b4a") {
  const x = Math.round(cx) - 6;
  const y = Math.round(fy) - 9;
  rect(ctx, x, y, 12, 8, OUTLINE);
  rect(ctx, x + 1, y + 1, 10, 5, color);
  rect(ctx, x + 1, y + 5, 10, 1, shade(color, -0.25));
  rect(ctx, x + 2, y + 8, 1, 2, OUTLINE);
  rect(ctx, x + 9, y + 8, 1, 2, OUTLINE);
}

// ── Icons (9x9) for speech bubbles ────────────────────────────────

const ICON_PALETTE = {
  k: OUTLINE,
  w: "#ffffff",
  g: "#9aa3ad",
  d: "#5b6670",
  y: "#f2c94c",
  o: "#f2994a",
  r: "#e5534b",
  b: "#4a90d9",
  l: "#9fd0ff",
  n: "#57b36a",
  p: "#b685e0",
  t: "#c69c6d",
  m: "#e86fa5",
};

const ICON_ART = {
  think: [
    ".........",
    ".........",
    ".........",
    ".........",
    "kk.kk.kk.",
    "kk.kk.kk.",
    ".........",
    ".........",
    ".........",
  ],
  chat: [
    ".kkkkkkk.",
    "kwwwwwwwk",
    "kwkwkwkwk",
    "kwwwwwwwk",
    ".kkwkkkk.",
    "..kk.....",
    ".k.......",
    ".........",
    ".........",
  ],
  search: [
    "..kkk....",
    ".klllk...",
    "klwllk...",
    "klllllk..",
    ".klllk...",
    "..kkkkk..",
    "......kk.",
    ".......kk",
    "........k",
  ],
  read: [
    ".........",
    "kkkk.kkkk",
    "kwwwkwwwk",
    "kwggkggwk",
    "kwwwkwwwk",
    "kwggkggwk",
    "kwwwkwwwk",
    ".kkkkkkk.",
    ".........",
  ],
  write: [
    ".......kk",
    "......kok",
    ".....kyk.",
    "....kyk..",
    "...kyk...",
    "..kyk....",
    ".ktk.....",
    ".kk......",
    "k........",
  ],
  run: [
    "kkkkkkkkk",
    "kdddddddk",
    "knddddddk",
    "kdnddddk.",
    "knddddddk",
    "kddnnnddk",
    "kdddddddk",
    "kkkkkkkkk",
    ".........",
  ],
  mail: [
    ".........",
    "kkkkkkkkk",
    "kkwwwwwkk",
    "kwkwwwkwk",
    "kwwkwkwwk",
    "kwwwkwwwk",
    "kwwwwwwwk",
    "kkkkkkkkk",
    ".........",
  ],
  task: [
    "...kkk...",
    ".kkyyykk.",
    ".kwkkkwk.",
    ".kwwwwwk.",
    ".kwkkkwk.",
    ".kwwwwwk.",
    ".kwkkwwk.",
    ".kwwwwwk.",
    ".kkkkkkk.",
  ],
  report: [
    "kk.......",
    "krrrrr...",
    "krrrrrrr.",
    "krrrrrr..",
    "krrrrrrr.",
    "kk.......",
    "kk.......",
    "kk.......",
    "kk.......",
  ],
  note: [
    "....r....",
    "...rrr...",
    ".kkkkkkk.",
    ".kyyyyyk.",
    ".kykkkyk.",
    ".kyyyyyk.",
    ".kykkyyk.",
    ".kyyyyyk.",
    ".kkkkkkk.",
  ],
  hire: [
    "..kkk....",
    ".ktttk...",
    ".ktttk.n.",
    "..kkk.nnn",
    ".kbbbk.n.",
    "kbbbbbk..",
    "kbbbbbk..",
    "kkkkkkk..",
    ".........",
  ],
  done: [
    ".........",
    "........n",
    ".......nn",
    "n.....nn.",
    "nn...nn..",
    ".nn.nn...",
    "..nnn....",
    "...n.....",
    ".........",
  ],
  error: [
    "...kkk...",
    "...krk...",
    "...krk...",
    "...krk...",
    "...krk...",
    "...kkk...",
    "...krk...",
    "...kkk...",
    ".........",
  ],
  idle: [
    "...g.g...",
    "..g.g....",
    "...g.g...",
    ".kkkkkk..",
    ".kttttkkk",
    ".kwwwwk.k",
    ".kwwwwkkk",
    ".kwwwwk..",
    "..kkkk...",
  ],
  sleep: [
    ".....kkkk",
    "........k",
    ".......k.",
    "kkkk.kkkk",
    "...k.....",
    "..k......",
    ".k.......",
    "kkkk.....",
    ".........",
  ],
  pause: [
    ".........",
    ".kkk.kkk.",
    ".kdk.kdk.",
    ".kdk.kdk.",
    ".kdk.kdk.",
    ".kdk.kdk.",
    ".kdk.kdk.",
    ".kkk.kkk.",
    ".........",
  ],
  globe: [
    "..kkkkk..",
    ".kbnbbbk.",
    "kbnnbbnbk",
    "kbbnnbnnk",
    "kbbbnbbbk",
    "kbbnnnbbk",
    ".kbbnbbk.",
    "..kkkkk..",
    ".........",
  ],
  repo: [
    ".kkkkkkk.",
    "kpppppppk",
    "kpwppppwk",
    "kpppppppk",
    "kpppwpppk",
    "kpppppppk",
    ".kkkkkkk.",
    "..k...k..",
    ".........",
  ],
};

/** Which icon to show for an agent activity. */
export const ACTIVITY_ICON = {
  idle: "idle",
  thinking: "think",
  writing: "write",
  searching: "search",
  reading: "read",
  editing: "write",
  running: "run",
  messaging: "mail",
  delegating: "task",
  reporting: "report",
  noting: "note",
  hiring: "hire",
  done: "done",
  error: "error",
};

const iconCache = new Map();

/** Returns an offscreen canvas for the icon at the given pixel scale. */
export function icon(name, scale = 2) {
  const key = `${name}@${scale}`;
  if (iconCache.has(key)) return iconCache.get(key);
  const art = ICON_ART[name] ?? ICON_ART.think;
  const c = document.createElement("canvas");
  c.width = 9 * scale;
  c.height = 9 * scale;
  const ctx = c.getContext("2d");
  art.forEach((row, y) => {
    for (let x = 0; x < 9; x++) {
      const color = ICON_PALETTE[row[x]];
      if (color) {
        ctx.fillStyle = color;
        ctx.fillRect(x * scale, y * scale, scale, scale);
      }
    }
  });
  iconCache.set(key, c);
  return c;
}

// ── Floors & walls ────────────────────────────────────────────────

export const THEME_STYLE = {
  hq: { floor: "#d9a866", floor2: "#c8955a", wall: "#efe3cc", trim: "#b98f5e", accent: "#e8b04a", pattern: "planks" },
  lab: { floor: "#ece6d3", floor2: "#ddd5bd", wall: "#e3ecef", trim: "#9fb3bb", accent: "#5aa9c9", pattern: "tiles" },
  workshop: { floor: "#b8b6ae", floor2: "#a9a69c", wall: "#d6d3ca", trim: "#7f7c73", accent: "#e07b39", pattern: "concrete" },
  markets: { floor: "#7f93ab", floor2: "#71859d", wall: "#dfe6ee", trim: "#5d6f86", accent: "#3fb37f", pattern: "carpet" },
  studio: { floor: "#e8b9b4", floor2: "#dca59f", wall: "#f6e7e1", trim: "#c08a83", accent: "#d96aa0", pattern: "diamond" },
  library: { floor: "#a8754a", floor2: "#966541", wall: "#eadcc4", trim: "#7b5535", accent: "#9b6bc4", pattern: "parquet" },
  garden: { floor: "#cfe4b2", floor2: "#bfd8a0", wall: "#eef5e2", trim: "#8fb07a", accent: "#6dbb5a", pattern: "tiles" },
};

export function drawFloor(ctx, x, y, w, h, theme, seed) {
  const s = THEME_STYLE[theme] ?? THEME_STYLE.garden;
  rect(ctx, x, y, w, h, s.floor);
  const r = rng(seed);
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  switch (s.pattern) {
    case "planks":
      for (let yy = y; yy < y + h; yy += 6) {
        rect(ctx, x, yy, w, 1, s.floor2);
        const off = ((yy - y) / 6) % 2 ? 12 : 0;
        for (let xx = x + off; xx < x + w; xx += 24) rect(ctx, xx, yy, 1, 6, s.floor2);
      }
      break;
    case "parquet":
      for (let yy = y; yy < y + h; yy += 8) {
        for (let xx = x; xx < x + w; xx += 8) {
          const vertical = ((xx - x) / 8 + (yy - y) / 8) % 2 === 0;
          if (vertical) {
            rect(ctx, xx + 3, yy, 1, 8, s.floor2);
          } else {
            rect(ctx, xx, yy + 3, 8, 1, s.floor2);
          }
          rect(ctx, xx, yy, 8, 1, shade(s.floor, -0.12));
        }
      }
      break;
    case "tiles":
      for (let yy = y; yy < y + h; yy += 8) {
        for (let xx = x; xx < x + w; xx += 8) {
          if (((xx - x) / 8 + (yy - y) / 8) % 2 === 0) rect(ctx, xx, yy, 8, 8, s.floor2);
        }
      }
      break;
    case "concrete":
      for (let i = 0; i < (w * h) / 40; i++) rect(ctx, x + r() * w, y + r() * h, 1, 1, s.floor2);
      for (let xx = x; xx < x + w; xx += 32) rect(ctx, xx, y, 1, h, s.floor2);
      for (let yy = y; yy < y + h; yy += 32) rect(ctx, x, yy, w, 1, s.floor2);
      break;
    case "carpet":
      for (let yy = y; yy < y + h; yy += 4) {
        for (let xx = x + ((yy - y) / 4) % 2 * 2; xx < x + w; xx += 4) rect(ctx, xx, yy, 1, 1, s.floor2);
      }
      break;
    case "diamond":
      for (let yy = y; yy < y + h; yy += 12) {
        for (let xx = x; xx < x + w; xx += 12) {
          rect(ctx, xx + 5, yy + 2, 2, 1, s.floor2);
          rect(ctx, xx + 4, yy + 3, 4, 1, s.floor2);
          rect(ctx, xx + 3, yy + 4, 6, 2, s.floor2);
          rect(ctx, xx + 4, yy + 6, 4, 1, s.floor2);
          rect(ctx, xx + 5, yy + 7, 2, 1, s.floor2);
        }
      }
      break;
  }
  ctx.restore();
}

// ── Furniture ─────────────────────────────────────────────────────
// Each takes the top-left corner in world pixels.

const WOOD = "#a87449";
const WOOD_DARK = "#7d5233";
const METAL = "#8b939b";

export function drawDesk(ctx, x, y, seed) {
  const r = rng(seed);
  // legs + body
  rect(ctx, x, y + 4, 32, 13, OUTLINE);
  rect(ctx, x + 1, y + 5, 30, 6, WOOD);
  rect(ctx, x + 1, y + 10, 30, 1, shade(WOOD, 0.15));
  rect(ctx, x + 1, y + 11, 30, 5, WOOD_DARK);
  rect(ctx, x + 2, y + 16, 2, 3, OUTLINE);
  rect(ctx, x + 28, y + 16, 2, 3, OUTLINE);
  // monitor
  rect(ctx, x + 9, y - 6, 14, 11, OUTLINE);
  rect(ctx, x + 10, y - 5, 12, 8, "#3c4a5c");
  rect(ctx, x + 15, y + 4, 2, 2, OUTLINE);
  // keyboard
  rect(ctx, x + 10, y + 7, 12, 2, "#d8dde3");
  // desk clutter
  if (r() > 0.4) {
    rect(ctx, x + 25, y + 4, 4, 4, OUTLINE);
    rect(ctx, x + 26, y + 5, 2, 2, ["#e5534b", "#4a90d9", "#f2c94c", "#ffffff"][Math.floor(r() * 4)]);
  }
  if (r() > 0.5) {
    rect(ctx, x + 2, y + 5, 6, 4, "#f4f1e8");
    rect(ctx, x + 3, y + 6, 4, 1, "#c9c3b2");
  }
}

/** Animated monitor contents for an agent working at this desk. */
export function drawScreenActivity(ctx, deskX, deskY, t, color = "#9fd0ff") {
  const x = deskX + 10;
  const y = deskY - 5;
  rect(ctx, x, y, 12, 8, "#1f3b57");
  const lines = 3;
  for (let i = 0; i < lines; i++) {
    const len = 3 + ((Math.floor(t / 180) + i * 3) % 8);
    rect(ctx, x + 1, y + 1 + i * 2, Math.min(10, len), 1, color);
  }
  if (Math.floor(t / 400) % 2) rect(ctx, x + 10, y + 6, 1, 1, "#ffffff");
}

export function drawBookshelf(ctx, x, y, seed) {
  const r = rng(seed);
  rect(ctx, x, y, 28, 36, OUTLINE);
  rect(ctx, x + 1, y + 1, 26, 34, WOOD_DARK);
  const colors = ["#c0504d", "#4f81bd", "#9bbb59", "#f2c94c", "#8064a2", "#4bacc6", "#f79646", "#e8e2d0"];
  for (let shelf = 0; shelf < 3; shelf++) {
    const sy = y + 2 + shelf * 11;
    rect(ctx, x + 2, sy, 24, 9, shade(WOOD_DARK, -0.3));
    let bx = x + 3;
    while (bx < x + 25) {
      const bw = 2 + Math.floor(r() * 2);
      const bh = 6 + Math.floor(r() * 3);
      if (bx + bw > x + 25) break;
      rect(ctx, bx, sy + 9 - bh, bw, bh, colors[Math.floor(r() * colors.length)]);
      bx += bw + (r() > 0.85 ? 2 : 0);
    }
    rect(ctx, x + 1, sy + 9, 26, 2, WOOD);
  }
}

export function drawWhiteboard(ctx, x, y, seed) {
  const r = rng(seed);
  rect(ctx, x, y, 40, 24, OUTLINE);
  rect(ctx, x + 1, y + 1, 38, 22, "#c8ccd0");
  rect(ctx, x + 2, y + 2, 36, 19, "#fbfdff");
  const inks = ["#e5534b", "#4a90d9", "#57b36a", "#2a2320"];
  for (let i = 0; i < 5; i++) {
    const lx = x + 4 + Math.floor(r() * 10);
    rect(ctx, lx, y + 4 + i * 3, 8 + Math.floor(r() * 18), 1, inks[Math.floor(r() * inks.length)]);
  }
  rect(ctx, x + 28, y + 6, 6, 6, "#f2c94c");
  rect(ctx, x + 4, y + 21, 32, 2, "#9aa3ad");
}

export function drawWindow(ctx, x, y) {
  rect(ctx, x, y, 24, 18, OUTLINE);
  rect(ctx, x + 1, y + 1, 22, 16, "#f4f1e8");
  rect(ctx, x + 2, y + 2, 20, 14, "#9ad3f5");
  rect(ctx, x + 2, y + 10, 20, 6, "#b9e3fb");
  rect(ctx, x + 6, y + 5, 6, 2, "#ffffff");
  rect(ctx, x + 11, y + 2, 2, 14, "#f4f1e8");
  rect(ctx, x + 2, y + 8, 20, 2, "#f4f1e8");
}

export function drawPlant(ctx, x, y, seed) {
  const r = rng(seed);
  const leaf = ["#4f9d4a", "#5cae55", "#3f8a43"][Math.floor(r() * 3)];
  rect(ctx, x + 3, y + 14, 10, 9, OUTLINE);
  rect(ctx, x + 4, y + 15, 8, 7, "#c9714a");
  rect(ctx, x + 4, y + 15, 8, 2, "#dd8a60");
  rect(ctx, x + 1, y + 2, 14, 13, OUTLINE);
  rect(ctx, x + 2, y + 3, 12, 11, leaf);
  rect(ctx, x + 4, y, 8, 5, OUTLINE);
  rect(ctx, x + 5, y + 1, 6, 4, leaf);
  rect(ctx, x + 4, y + 5, 3, 3, shade(leaf, 0.25));
  rect(ctx, x + 9, y + 8, 3, 3, shade(leaf, -0.2));
}

export function drawServerRack(ctx, x, y, seed) {
  const r = rng(seed);
  rect(ctx, x, y, 16, 38, OUTLINE);
  rect(ctx, x + 1, y + 1, 14, 36, "#3d434b");
  for (let i = 0; i < 7; i++) {
    const sy = y + 3 + i * 5;
    rect(ctx, x + 2, sy, 12, 4, "#545c66");
    rect(ctx, x + 3, sy + 1, 1, 1, r() > 0.3 ? "#57d16a" : "#f2c94c");
    rect(ctx, x + 5, sy + 1, 1, 1, r() > 0.5 ? "#57d16a" : "#3d434b");
    rect(ctx, x + 8, sy + 2, 5, 1, "#2b3036");
  }
}

export function drawChartScreen(ctx, x, y, seed) {
  const r = rng(seed);
  rect(ctx, x, y, 36, 24, OUTLINE);
  rect(ctx, x + 1, y + 1, 34, 20, "#14202c");
  let py = y + 12;
  for (let i = 0; i < 8; i++) {
    const up = r() > 0.45;
    const h = 2 + Math.floor(r() * 5);
    const cx = x + 3 + i * 4;
    rect(ctx, cx + 1, py - h - 1, 1, h + 3, "#7b8a99");
    rect(ctx, cx, py - h, 3, h, up ? "#3fb37f" : "#e5534b");
    py = Math.max(y + 6, Math.min(y + 18, py + (up ? -2 : 2)));
  }
  rect(ctx, x + 15, y + 21, 6, 3, OUTLINE);
}

export function drawTickerBoard(ctx, x, y, seed) {
  const r = rng(seed);
  rect(ctx, x, y, 44, 10, OUTLINE);
  rect(ctx, x + 1, y + 1, 42, 8, "#101820");
  for (let i = 0; i < 9; i++) {
    rect(ctx, x + 3 + i * 4.5, y + 3, 3, 1, "#f2c94c");
    rect(ctx, x + 3 + i * 4.5, y + 5, 2, 1, r() > 0.5 ? "#3fb37f" : "#e5534b");
  }
}

export function drawClock(ctx, x, y) {
  rect(ctx, x + 1, y, 8, 10, OUTLINE);
  rect(ctx, x, y + 1, 10, 8, OUTLINE);
  rect(ctx, x + 1, y + 1, 8, 8, "#fbfdff");
  rect(ctx, x + 4, y + 2, 1, 3, OUTLINE);
  rect(ctx, x + 4, y + 4, 3, 1, OUTLINE);
}

export function drawPainting(ctx, x, y, seed) {
  const r = rng(seed);
  rect(ctx, x, y, 22, 18, "#b88a3e");
  rect(ctx, x + 2, y + 2, 18, 14, "#f4ecd8");
  const colors = ["#e5534b", "#4a90d9", "#f2c94c", "#57b36a", "#b685e0"];
  for (let i = 0; i < 4; i++) {
    rect(ctx, x + 3 + Math.floor(r() * 10), y + 3 + Math.floor(r() * 8), 4 + Math.floor(r() * 4), 3 + Math.floor(r() * 3), colors[Math.floor(r() * colors.length)]);
  }
  rect(ctx, x, y, 22, 1, OUTLINE);
  rect(ctx, x, y + 17, 22, 1, OUTLINE);
  rect(ctx, x, y, 1, 18, OUTLINE);
  rect(ctx, x + 21, y, 1, 18, OUTLINE);
}

export function drawFridge(ctx, x, y) {
  rect(ctx, x, y, 18, 36, OUTLINE);
  rect(ctx, x + 1, y + 1, 16, 34, "#e7ebee");
  rect(ctx, x + 1, y + 13, 16, 1, "#aab3ba");
  rect(ctx, x + 14, y + 4, 1, 6, METAL);
  rect(ctx, x + 14, y + 17, 1, 8, METAL);
}

export function drawCounter(ctx, x, y) {
  rect(ctx, x, y + 10, 28, 20, OUTLINE);
  rect(ctx, x + 1, y + 11, 26, 4, "#e0e4e8");
  rect(ctx, x + 1, y + 15, 26, 14, "#b9a283");
  rect(ctx, x + 13, y + 16, 1, 12, OUTLINE);
  // coffee machine
  rect(ctx, x + 3, y, 10, 12, OUTLINE);
  rect(ctx, x + 4, y + 1, 8, 10, "#4a4f57");
  rect(ctx, x + 6, y + 6, 4, 4, "#2b3036");
  rect(ctx, x + 7, y + 8, 2, 2, "#f4f1e8");
  // mugs
  rect(ctx, x + 17, y + 7, 4, 4, OUTLINE);
  rect(ctx, x + 18, y + 8, 2, 2, "#e5534b");
}

export function drawEasel(ctx, x, y, seed) {
  rect(ctx, x + 3, y + 8, 2, 28, WOOD_DARK);
  rect(ctx, x + 17, y + 8, 2, 28, WOOD_DARK);
  rect(ctx, x + 10, y + 4, 2, 32, WOOD_DARK);
  drawPainting(ctx, x, y + 4, seed);
}

export function drawPiano(ctx, x, y) {
  rect(ctx, x, y, 40, 30, OUTLINE);
  rect(ctx, x + 1, y + 1, 38, 18, "#2b2b33");
  rect(ctx, x + 1, y + 19, 38, 6, "#f7f7f2");
  for (let i = 0; i < 9; i++) rect(ctx, x + 3 + i * 4, y + 19, 2, 3, OUTLINE);
  rect(ctx, x + 1, y + 25, 38, 4, "#2b2b33");
}

export function drawLamp(ctx, x, y) {
  rect(ctx, x + 2, y, 12, 8, OUTLINE);
  rect(ctx, x + 3, y + 1, 10, 6, "#f6d98b");
  rect(ctx, x + 7, y + 8, 2, 26, OUTLINE);
  rect(ctx, x + 3, y + 33, 10, 3, OUTLINE);
}

export function drawToolBoard(ctx, x, y) {
  rect(ctx, x, y, 34, 22, OUTLINE);
  rect(ctx, x + 1, y + 1, 32, 20, "#c9a77a");
  for (let i = 0; i < 6; i++) rect(ctx, x + 4 + i * 5, y + 3, 1, 1, OUTLINE);
  rect(ctx, x + 4, y + 5, 2, 10, METAL);
  rect(ctx, x + 3, y + 5, 4, 3, "#5b6670");
  rect(ctx, x + 10, y + 5, 2, 12, "#e07b39");
  rect(ctx, x + 15, y + 5, 6, 2, METAL);
  rect(ctx, x + 17, y + 7, 2, 9, WOOD_DARK);
  rect(ctx, x + 25, y + 5, 4, 4, METAL);
  rect(ctx, x + 26, y + 9, 2, 8, "#e5534b");
}

export function drawRug(ctx, x, y, w, h, color) {
  rect(ctx, x, y, w, h, shade(color, -0.25));
  rect(ctx, x + 2, y + 2, w - 4, h - 4, color);
  rect(ctx, x + 4, y + 4, w - 8, h - 8, shade(color, 0.2));
  rect(ctx, x + 6, y + 6, w - 12, h - 12, color);
}

/** Back-wall furniture per room theme: [drawFn, widthPx, heightPx]. */
export const WALL_ITEMS = {
  hq: [["window", 24, 18], ["whiteboard", 40, 24], ["plant", 16, 23], ["window", 24, 18], ["clock", 10, 10], ["painting", 22, 18], ["counter", 28, 30]],
  lab: [["bookshelf", 28, 36], ["whiteboard", 40, 24], ["window", 24, 18], ["bookshelf", 28, 36], ["plant", 16, 23], ["fridge", 18, 36]],
  workshop: [["server", 16, 38], ["server", 16, 38], ["toolboard", 34, 22], ["window", 24, 18], ["server", 16, 38], ["counter", 28, 30]],
  markets: [["chart", 36, 24], ["ticker", 44, 10], ["chart", 36, 24], ["clock", 10, 10], ["chart", 36, 24], ["plant", 16, 23]],
  studio: [["painting", 22, 18], ["window", 24, 18], ["easel", 22, 36], ["piano", 40, 30], ["plant", 16, 23], ["lamp", 16, 36]],
  library: [["bookshelf", 28, 36], ["bookshelf", 28, 36], ["lamp", 16, 36], ["bookshelf", 28, 36], ["window", 24, 18], ["bookshelf", 28, 36]],
  garden: [["window", 24, 18], ["plant", 16, 23], ["window", 24, 18], ["plant", 16, 23], ["painting", 22, 18], ["plant", 16, 23]],
};

export function drawWallItem(ctx, kind, x, y, seed) {
  switch (kind) {
    case "window": return drawWindow(ctx, x, y);
    case "whiteboard": return drawWhiteboard(ctx, x, y, seed);
    case "plant": return drawPlant(ctx, x, y, seed);
    case "clock": return drawClock(ctx, x, y);
    case "painting": return drawPainting(ctx, x, y, seed);
    case "counter": return drawCounter(ctx, x, y);
    case "bookshelf": return drawBookshelf(ctx, x, y, seed);
    case "fridge": return drawFridge(ctx, x, y);
    case "server": return drawServerRack(ctx, x, y, seed);
    case "toolboard": return drawToolBoard(ctx, x, y);
    case "chart": return drawChartScreen(ctx, x, y, seed);
    case "ticker": return drawTickerBoard(ctx, x, y, seed);
    case "easel": return drawEasel(ctx, x, y, seed);
    case "piano": return drawPiano(ctx, x, y);
    case "lamp": return drawLamp(ctx, x, y);
  }
}

// ── Outdoors ──────────────────────────────────────────────────────

export const GRASS = "#8fd16a";

export function drawGrass(ctx, w, h, seed) {
  rect(ctx, 0, 0, w, h, GRASS);
  const r = rng(seed);
  for (let i = 0; i < (w * h) / 90; i++) {
    const x = Math.floor(r() * w);
    const y = Math.floor(r() * h);
    const c = r() > 0.5 ? "#7fc25b" : "#a3dc7f";
    rect(ctx, x, y, 1, 2, c);
    if (r() > 0.6) rect(ctx, x + 2, y + 1, 1, 1, c);
  }
}

export function drawPath(ctx, x, y, w, h, seed) {
  rect(ctx, x, y, w, h, "#d9c68f");
  rect(ctx, x + 1, y + 1, w - 2, h - 2, "#ecdcaa");
  const r = rng(seed);
  for (let i = 0; i < (w * h) / 70; i++) {
    rect(ctx, x + 2 + r() * (w - 4), y + 2 + r() * (h - 4), 1, 1, r() > 0.5 ? "#dcc995" : "#f5e9c2");
  }
}

export function drawTree(ctx, x, y, seed) {
  const r = rng(seed);
  const leaf = ["#4f9d4a", "#3f8a43", "#5cae55"][Math.floor(r() * 3)];
  ctx.fillStyle = "rgba(20,40,10,0.2)";
  ctx.fillRect(x + 3, y + 26, 22, 4);
  rect(ctx, x + 11, y + 18, 6, 11, OUTLINE);
  rect(ctx, x + 12, y + 18, 4, 10, "#8a5a36");
  rect(ctx, x + 4, y + 2, 20, 18, OUTLINE);
  rect(ctx, x + 2, y + 6, 24, 11, OUTLINE);
  rect(ctx, x + 5, y + 3, 18, 16, leaf);
  rect(ctx, x + 3, y + 7, 22, 9, leaf);
  rect(ctx, x + 7, y + 5, 6, 4, shade(leaf, 0.22));
  rect(ctx, x + 16, y + 12, 6, 4, shade(leaf, -0.18));
}

export function drawBush(ctx, x, y, seed) {
  const r = rng(seed);
  const leaf = r() > 0.5 ? "#5cae55" : "#4f9d4a";
  rect(ctx, x, y + 2, 16, 10, OUTLINE);
  rect(ctx, x + 2, y, 12, 13, OUTLINE);
  rect(ctx, x + 1, y + 3, 14, 8, leaf);
  rect(ctx, x + 3, y + 1, 10, 11, leaf);
  rect(ctx, x + 4, y + 3, 3, 2, shade(leaf, 0.25));
  if (r() > 0.5) rect(ctx, x + 10, y + 6, 2, 2, "#e5534b");
}

export function drawFlowers(ctx, x, y, seed) {
  const r = rng(seed);
  const colors = ["#e5534b", "#f2c94c", "#b685e0", "#ffffff", "#e86fa5"];
  for (let i = 0; i < 4; i++) {
    const fx = x + Math.floor(r() * 12);
    const fy = y + Math.floor(r() * 8);
    rect(ctx, fx, fy + 2, 1, 2, "#3f8a43");
    rect(ctx, fx - 1, fy, 3, 2, colors[Math.floor(r() * colors.length)]);
  }
}

export function drawLampPost(ctx, x, y) {
  rect(ctx, x + 3, y, 6, 6, OUTLINE);
  rect(ctx, x + 4, y + 1, 4, 4, "#fff2b3");
  rect(ctx, x + 5, y + 6, 2, 20, OUTLINE);
  rect(ctx, x + 3, y + 25, 6, 2, OUTLINE);
}

export function drawMailbox(ctx, x, y, flagUp) {
  ctx.fillStyle = "rgba(20,40,10,0.22)";
  ctx.fillRect(x + 1, y + 26, 16, 3);
  rect(ctx, x + 7, y + 12, 4, 15, OUTLINE);
  rect(ctx, x + 8, y + 12, 2, 14, "#8a5a36");
  rect(ctx, x, y, 18, 14, OUTLINE);
  rect(ctx, x + 1, y + 1, 16, 12, "#d9534f");
  rect(ctx, x + 1, y + 1, 16, 3, "#ea6b66");
  rect(ctx, x + 3, y + 7, 10, 2, "#a33b37");
  if (flagUp) {
    rect(ctx, x + 17, y - 8, 2, 14, OUTLINE);
    rect(ctx, x + 19, y - 8, 7, 5, OUTLINE);
    rect(ctx, x + 19, y - 7, 6, 3, "#f2c94c");
  } else {
    rect(ctx, x + 17, y + 4, 8, 2, OUTLINE);
  }
}

export function drawSignpost(ctx, x, y) {
  rect(ctx, x + 9, y + 10, 3, 18, OUTLINE);
  rect(ctx, x, y, 22, 12, OUTLINE);
  rect(ctx, x + 1, y + 1, 20, 10, "#c69c6d");
  rect(ctx, x + 3, y + 4, 14, 1, "#7d5233");
  rect(ctx, x + 3, y + 7, 10, 1, "#7d5233");
}

export function drawEnvelope(ctx, x, y) {
  rect(ctx, x, y, 10, 7, OUTLINE);
  rect(ctx, x + 1, y + 1, 8, 5, "#ffffff");
  rect(ctx, x + 2, y + 2, 1, 1, OUTLINE);
  rect(ctx, x + 3, y + 3, 1, 1, OUTLINE);
  rect(ctx, x + 4, y + 4, 2, 1, OUTLINE);
  rect(ctx, x + 6, y + 3, 1, 1, OUTLINE);
  rect(ctx, x + 7, y + 2, 1, 1, OUTLINE);
}

export function drawClipboard(ctx, x, y) {
  rect(ctx, x, y, 9, 11, OUTLINE);
  rect(ctx, x + 1, y + 1, 7, 9, "#f4f1e8");
  rect(ctx, x + 3, y, 3, 2, "#f2c94c");
  rect(ctx, x + 2, y + 4, 5, 1, "#9aa3ad");
  rect(ctx, x + 2, y + 6, 4, 1, "#9aa3ad");
}
