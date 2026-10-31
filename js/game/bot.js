// bot.js: computer pilots for solo mode (and for tuning the floors headlessly).
// A bot picks a landing zone it thinks it can reach, rides vents on the way,
// steers around furniture with a short look-ahead, and dives onto the target.
// Pure: given race state, it returns stick input. `rng` is passed in.

import { stepPlane, createRace, throwPlane, SIM } from './sim.js';
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

const inHall = (floor, z, pad = 0) => (floor.halls || []).some(([a, b]) => z > a - pad && z < b + pad);

export function createBot(seat, skill, rng) {
  return { seat, skill, rng, target: null, ways: [], thrown: false, throwAt: 0.6 + rng() * 2.2, wobble: rng() * 10 };
}

// Choose a zone and plan a route before throwing.
// Fly a copy of this plane down the lane with no vents to see how far it gets.
// Bots aim for the best zone they can actually reach, so they progress as
// they buy upgrades, just like players.
function estimateReach(bot, floor, p, aim) {
  const r = createRace(floor, [{ seat: p.seat, owned: [] }]);
  const q = r.planes[0];
  q.st = p.st; q.hp = p.hp; q.maxHp = p.maxHp; q.x = p.x;
  throwPlane(r, p.seat, aim);
  const ghost = { ...bot, target: { x: laneX(floor, floor.length - 5), z: floor.length - 5, tier: -1 }, ways: [], nextPlan: Infinity, planY: 0 };
  const dt = 1 / 30;
  for (let i = 0; i < 4000 && q.state !== 'landed'; i++) {
    r.t += dt;
    if (q.state === 'fly') { const st = botSteer(ghost, r, q); q.inX = st.x; q.inY = st.y; }
    stepPlane(r, q, dt);
  }
  return q.crumpled ? q.z * 0.8 : q.z;
}

function plan(bot, floor, p, aim) {
  const reach = estimateReach(bot, floor, p, aim);
  // Best zone comfortably inside that reach; weaker bots sometimes play it safe,
  // stronger ones sometimes gamble on the next zone out using vents.
  const ok = floor.zones.filter(z => z.z + z.d / 2 < reach - 6).sort((a, b) => b.tier - a.tier);
  let pick = ok[0] || floor.zones[0];
  if (ok[1] && bot.rng() < (1 - bot.skill) * 0.6) pick = ok[1];
  const next = floor.zones.find(z => z.tier === pick.tier + 1);
  if (next && bot.rng() < bot.skill * 0.25) pick = next;
  bot.target = pick;
  bot.reach = reach;
  bot.ways = floor.vents
    .filter(v => v.z > 8 && v.z < bot.target.z - 18 && !inHall(floor, v.z, 15) && Math.abs(v.x - laneX(floor, v.z)) < 8 && bot.rng() < 0.35 + bot.skill * 0.6)
    .sort((a, b) => a.z - b.z)
    .map(v => ({ x: v.x, z: v.z, vent: v }));
}

export function botAim(bot, floor, p) {
  const first = { x: laneX(floor, 20), z: 20 };
  const yaw = clamp(Math.atan2(first.x - p.x, first.z - p.z), -0.45, 0.45);
  const sloppy = (1 - bot.skill) * 0.25;
  const aim = {
    yaw: yaw + (bot.rng() - 0.5) * sloppy,
    pitch: 0.12 + bot.rng() * 0.18,
    power: clamp(0.7 + bot.skill * 0.3 - bot.rng() * 0.15, 0.4, 1),
  };
  plan(bot, floor, p, aim);
  // Going for the first mat: a softer throw so it doesn't sail past.
  if (bot.target.tier === 0 && bot.reach > bot.target.z + 40) aim.power = clamp(aim.power - 0.3, 0.3, 1);
  return aim;
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
  const fake = { floor: race.floor, timeLimit: race.timeLimit, t: race.t, planes: [q], clips: [], events: [] };
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
  while (bot.ways.length && (p.z > bot.ways[0].z + 1 || Math.hypot(bot.ways[0].z - p.z, bot.ways[0].x - p.x) > (p.y + Math.max(0, p.v - 11) * 0.6) * 8.5 + 6 || (p.y > f.height * 0.72 && p.z > bot.ways[0].z - 3))) bot.ways.shift();
  // Inside a hallway: forget vents and just thread the corridor.
  const hall = inHall(f, p.z, 45);
  const way = hall ? null : bot.ways[0];

  let x, y;
  if (way) {
    // Cruise to the vent at an efficient speed.
    // Head for the vent, but via the lane while it's still far ahead.
    const ahead = p.z + 12;
    x = way.z - p.z > 15 ? steerToward(p, laneX(f, ahead), ahead) : steerToward(p, way.x, way.z);
    y = clamp((p.v - (Math.hypot(way.x - p.x, way.z - p.z) < way.vent.r ? 9 : 11.5)) * 0.28, -1, 1);
  } else if (hall || tg.z - p.z > 45) {
    // Far from the target (or in a hallway): follow the clear lane at an efficient speed.
    const ahead = p.z + (hall ? 7 : 12);
    x = steerToward(p, laneX(f, ahead), ahead);
    y = clamp((p.v - 11.5) * 0.28, -1, 1);
    // A doorway ahead: get under the lintel in time.
    const door = (f.doors || []).find(d => d.z > p.z - 1 && d.z - p.z < 45);
    if (door) {
      const want = door.h - 1.6;
      if (p.y > want - 0.3) y = clamp(-(p.y - want) * 0.35, -1, 0.2);
      else if (p.y < want - 2.5) y = Math.max(y, 0.3);
      if (door.z - p.z < 10) x = steerToward(p, door.x, door.z + 2);
    }
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
  for (const s of [3, 6, 9]) {
    const hx = p.x + Math.sin(p.yaw) * s, hz = p.z + Math.cos(p.yaw) * s;
    const hy = p.y + Math.sin(p.pitch) * s;
    const b = blocked(f, hx, hy, hz, race.t + s / Math.max(p.v, 1));
    if (!b) continue;
    if (b.y1 && b.y1 < p.y + 1.2 && p.v > 10) { y = Math.max(y, 0.6); break; }
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
