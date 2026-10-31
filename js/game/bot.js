// bot.js: computer pilots for solo mode (and for tuning the floors headlessly).
// A bot picks a landing zone it thinks it can reach, rides vents on the way,
// steers around furniture with a short look-ahead, and dives onto the target.
// Pure: given race state, it returns stick input. `rng` is passed in.

import { stepPlane, SIM } from './sim.js';
import { moverBox } from './floors.js';
import { nextCost } from '../shared/upgrades.js';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const wrap = a => Math.atan2(Math.sin(a), Math.cos(a));

// x of the floor's clear lane at distance z (falls back to the centre line).
export function laneX(floor, z) {
  const c = floor.lane;
  if (!c) return 0;
  for (let i = 1; i < c.length; i++) {
    if (z <= c[i][0]) { const [z0, x0] = c[i - 1], [z1, x1] = c[i]; return x0 + (x1 - x0) * (z - z0) / (z1 - z0); }
  }
  return c[c.length - 1][1];
}

export function createBot(seat, skill, rng) {
  return { seat, skill, rng, target: null, ways: [], thrown: false, throwAt: 0.6 + rng() * 2.2, wobble: rng() * 10 };
}

// Choose a zone and plan a route before throwing.
function plan(bot, floor, p) {
  const r = bot.rng();
  // Skilled bots aim higher, but everyone sometimes plays it safe.
  const reach = clamp(Math.round(bot.skill * 4 + (r - 0.5) * 2 + (p.st.sink < 0.9 ? 1 : 0)), 0, 4);
  bot.target = floor.zones.find(z => z.tier === reach) || floor.zones[0];
  bot.ways = floor.vents
    .filter(v => v.z > 8 && v.z < bot.target.z - 18 && Math.abs(v.x - laneX(floor, v.z)) < 8 && bot.rng() < 0.35 + bot.skill * 0.6)
    .sort((a, b) => a.z - b.z)
    .map(v => ({ x: v.x, z: v.z, vent: v }));
}

export function botAim(bot, floor, p) {
  plan(bot, floor, p);
  const first = { x: laneX(floor, 20), z: 20 };
  const yaw = clamp(Math.atan2(first.x - p.x, first.z - p.z), -0.45, 0.45);
  const sloppy = (1 - bot.skill) * 0.25;
  return {
    yaw: yaw + (bot.rng() - 0.5) * sloppy,
    pitch: 0.12 + bot.rng() * 0.18,
    power: clamp(0.7 + bot.skill * 0.3 - bot.rng() * 0.15, 0.4, 1),
  };
}

function blocked(floor, x, y, z, t = 0) {
  if (x < -floor.width / 2 + 1 || x > floor.width / 2 - 1 || y > floor.height - 0.8) return true;
  const all = floor.movers?.length ? floor.boxes.concat(floor.movers.map(m => moverBox(m, t))) : floor.boxes;
  for (const b of all) {
    if (x > b.x0 - 0.9 && x < b.x1 + 0.9 && z > b.z0 - 0.9 && z < b.z1 + 0.9 && y > b.y0 - 0.9 && y < b.y1 + 0.6) return b;
  }
  return false;
}

const CANDS = [-1, -0.65, -0.35, -0.1, 0.15, 0.45, 0.8];

function steerToward(q, tx, tz) {
  return clamp(wrap(Math.atan2(tx - q.x, tz - q.z) - q.yaw) * 2.4, -1, 1);
}

// Fly a copy of the plane forward with a fixed stick and see where it lands.
function predict(race, p, yCmd, tx, tz) {
  const q = { ...p };
  const fake = { floor: race.floor, k: race.k, sk: race.sk, timeLimit: race.timeLimit, t: race.t, planes: [q], clips: [], events: [] };
  const dt = 1 / 30;
  for (let i = 0; i < 1500 && q.state !== 'landed'; i++) {
    fake.t += dt;
    q.inX = steerToward(q, tx, tz);
    q.inY = yCmd;
    stepPlane(fake, q, dt);
  }
  return q;
}

function scoreLanding(q, tg) {
  let s = Math.hypot(q.x - tg.x, q.z - tg.z);
  if (q.zone && q.zone.tier === tg.tier) s *= 0.15;
  else if (Math.abs(q.y - SIM.restH - (tg.y || 0)) > 0.6) s += 12;
  if (q.crumpled) s += 120;
  return s;
}

export function botSteer(bot, race, p) {
  const f = race.floor;
  let tg = bot.target;
  if (!tg) return { x: 0, y: 0 };

  // Drop vent waypoints we've passed or ridden high enough in.
  while (bot.ways.length && (p.z > bot.ways[0].z + 1 || Math.hypot(bot.ways[0].z - p.z, bot.ways[0].x - p.x) > (p.y + Math.max(0, p.v / (race.sk ?? 1) - 11) * 0.6) * 8.5 * (race.k ?? 1) + 6 || (p.y > f.height * 0.72 && p.z > bot.ways[0].z - 3))) bot.ways.shift();
  const way = bot.ways[0];

  let x, y;
  if (way) {
    // Cruise to the vent at an efficient speed.
    // Head for the vent, but via the lane while it's still far ahead.
    const ahead = p.z + 12 * (race.sk ?? 1);
    x = way.z - p.z > 15 ? steerToward(p, laneX(f, ahead), ahead) : steerToward(p, way.x, way.z);
    y = clamp((p.v / (race.sk ?? 1) - (Math.hypot(way.x - p.x, way.z - p.z) < way.vent.r ? 9 : 11.5)) * 0.28, -1, 1);
  } else if (tg.z - p.z > 45 * (race.sk ?? 1)) {
    // Far from the target: follow the clear lane at an efficient speed.
    const ahead = p.z + 12 * (race.sk ?? 1);
    x = steerToward(p, laneX(f, ahead), ahead);
    y = clamp((p.v / (race.sk ?? 1) - 11.5) * 0.28, -1, 1);
  } else {
    x = steerToward(p, tg.x, tg.z);
    const every = 0.25 + (1 - bot.skill) * 0.45;
    if (bot.nextPlan == null || race.t >= bot.nextPlan) {
      bot.nextPlan = race.t + every;
      let best = Infinity, bestY = 0, bestQ = null;
      for (const c of CANDS) {
        const q = predict(race, p, c, tg.x, tg.z);
        const sc = scoreLanding(q, tg);
        if (sc < best) { best = sc; bestY = c; bestQ = q; }
      }
      // Can't make it? Settle for the best zone we can actually reach.
      if (bestQ && best > 6 && bestQ.z < tg.z - 6) {
        const fallback = [...f.zones].filter(z => z.z - z.d / 2 < bestQ.z + 4 && z.tier < tg.tier).sort((a, b) => b.tier - a.tier)[0];
        if (fallback) bot.target = fallback;
      }
      bot.planY = clamp(bestY + (bot.rng() - 0.5) * (1 - bot.skill) * 0.5, -1, 1);
    }
    y = bot.planY ?? 0;
  }

  // Look ahead along the heading and swerve around tall things.
  for (const s of [3, 6, 9].map(d => d * (race.sk ?? 1))) {
    const hx = p.x + Math.sin(p.yaw) * s, hz = p.z + Math.cos(p.yaw) * s;
    const hy = p.y + Math.sin(p.pitch) * s;
    const b = blocked(f, hx, hy, hz, race.t + s / Math.max(p.v, 1));
    if (!b) continue;
    if (b.y1 && b.y1 < p.y + 1.2 && p.v > 10 * (race.sk ?? 1)) { y = Math.max(y, 0.6); break; }
    const l = blocked(f, p.x + Math.sin(p.yaw - 0.6) * s, hy, p.z + Math.cos(p.yaw - 0.6) * s, race.t);
    const r = blocked(f, p.x + Math.sin(p.yaw + 0.6) * s, hy, p.z + Math.cos(p.yaw + 0.6) * s, race.t);
    x = !r ? 1 : !l ? -1 : (tg.x > p.x ? 1 : -1);
    break;
  }

  const w = (1 - bot.skill) * 0.2 * Math.sin(race.t * 2.3 + bot.wobble);
  return { x: clamp(x + w, -1, 1), y: clamp(y, -1, 1) };
}

// Shop logic for bots: buy the best-value upgrade they can afford.
export function botShop(bot, clips, owned, upgrades) {
  const pref = ['widewings', 'rubberband', 'glossy', 'tape', 'cardstock', 'binder', 'flaps', 'magnet', 'noseclip'];
  const buys = [];
  let left = clips;
  for (const id of pref) {
    const u = upgrades.find(x => x.id === id);
    const cost = nextCost([...owned, ...buys], id);
    if (cost != null && !buys.includes(id) && cost <= left && bot.rng() < 0.8) { buys.push(id); left -= cost; }
  }
  return buys;
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
