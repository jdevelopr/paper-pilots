// bot.js: computer pilots for solo mode (and for tuning the floors headlessly).
// A bot picks a landing zone it thinks it can reach, rides vents on the way,
// steers around furniture with a short look-ahead, and dives onto the target.
// Pure: given race state, it returns stick input. `rng` is passed in.

import { stepPlane, createRace, throwPlane, SIM, itemReady, buffOn } from './sim.js';
import { moverBox, treeAt, treeTop, groundAt } from './floors.js';
import { partState, UPGRADES, UPGRADE_BY_ID } from '../shared/upgrades.js';
import { PART_VALUE } from './part-values.js';

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
  q.st = p.st; q.hp = p.hp; q.maxHp = p.maxHp; q.x = p.x; q.tr = null;
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
  if (floor.finish) {
    // Race mode: aim for the cork board on the back wall and ride the vents on the way
    bot.target = { x: laneX(floor, floor.finish.z + 6), z: floor.finish.z + 8, tier: -1, race: true };
    bot.reach = floor.length;
    bot.ways = floor.vents
      .filter(v => v.z > 8 && v.z < floor.finish.z - 18 && !inHall(floor, v.z, 15) && Math.abs(v.x - laneX(floor, v.z)) < 6 && bot.rng() < 0.15 + bot.skill * 0.35)
      .sort((a, b) => a.z - b.z)
      .map(v => ({ x: v.x, z: v.z, vent: v }));
    return;
  }
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
  if (floor.finish) aim.power = clamp(0.85 + bot.skill * 0.15 - bot.rng() * 0.1, 0.6, 1);
  // Going for the first mat: a softer throw so it doesn't sail past.
  else if (bot.target.tier === 0 && bot.reach > bot.target.z + 40) aim.power = clamp(aim.power - 0.3, 0.3, 1);
  return aim;
}

function blocked(floor, x, y, z, t = 0) {
  if (x < -floor.width / 2 + 1 || x > floor.width / 2 - 1 || y > floor.height - 0.8) return true;
  const all = floor.movers?.length ? floor.boxes.concat(floor.movers.map(m => moverBox(m, t))) : floor.boxes;
  for (const b of all) {
    if (x > b.x0 - 0.9 && x < b.x1 + 0.9 && z > b.z0 - 0.9 && z < b.z1 + 0.9 && y > b.y0 - 0.9 && y < b.y1 + 0.6) return b;
  }
  const tree = floor.gap?.park && treeAt(floor, x, y, z, 1.1);
  if (tree) return { y1: treeTop(tree), tree: true };
  return false;
}

const CANDS = [-1, -0.65, -0.35, -0.1, 0.15, 0.45, 0.8];

function steerToward(q, tx, tz) {
  return clamp(wrap(Math.atan2(tx - q.x, tz - q.z) - q.yaw) * 2.4, -1, 1);
}

// Fly a copy of the plane forward with a fixed stick and see where it lands.
function predict(race, p, yCmd, tx, tz) {
  const q = { ...p, tr: null };   // predictions don't score tricks
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

// Race mode: go for whatever makes you faster that's close to your line (thrust
// items, a repair when hurt, wall vents, floor vents), otherwise hold a middle
// height along the lane. Better bots look further ahead and commit more.
const RACE_ITEMS = { donut: 3, coffee: 3, bubble: 2, card: 1, glue: 0.5, chipclip: 0.5 };
function raceSteer(bot, race, p, laneSteer, hall) {
  const f = race.floor, look = 30 + bot.skill * 55, g = groundAt(f, p.z);
  let x = laneSteer;
  let y = clamp((Math.min(f.height * 0.45, 6) + g - p.y) * 0.22 + (p.v - 15) * 0.05, -1, 1);
  if (hall) return { x, y };
  // a hallway coming up: line up with its entrance instead of chasing boosts
  const soon = inHall(f, p.z + 10 + p.v * 1.2, 4);
  if (soon) {
    const ez = p.z + 10 + p.v * 1.2;
    return { x: clamp(steerToward(p, laneX(f, ez), ez) * 1.3, -1, 1), y };
  }
  const hurt = p.hp < p.maxHp * 0.6;
  let best = null, bestSc = 0;
  const consider = (tx, ty, tz, value, reach = 0.45) => {
    const dz = tz - p.z;
    if (dz < 2 || dz > look) return;
    const lx = laneX(f, tz);
    if (Math.abs(tx - lx) > 6 + bot.skill * 8) return;          // too far off the line
    if (Math.abs(tx - p.x) > dz * reach + 2) return;            // can't turn that hard in time
    if (inHall(f, tz, 25)) return;                              // not right by a hallway
    if (ty != null && Math.abs(ty - p.y) > dz * 0.35 + 1.5) return;
    // only if the straight line there is clear
    const yy = ty ?? p.y;
    for (const k of [0.25, 0.5, 0.75, 1]) if (blocked(f, p.x + (tx - p.x) * k, p.y + (yy - p.y) * k, p.z + dz * k, race.t + dz * k / Math.max(p.v, 1))) return;
    const sc = value / (1 + dz / 25);
    if (sc > bestSc) { bestSc = sc; best = { x: tx, y: ty, z: tz }; }
  };
  for (const it of race.items || []) {
    if (!itemReady(race, it)) continue;
    let v = RACE_ITEMS[it.kind] ?? 0;
    if (it.kind === 'eraser') v = hurt ? 3 : 0.2;
    if ((it.kind === 'donut' || it.kind === 'coffee') && (buffOn(race, p, 'donut') || buffOn(race, p, 'coffee'))) v *= 0.4;
    if (v > 0) consider(it.x, it.y, it.z, v);
  }
  // wall vents are narrow slots: only go for one that's already nearly lined up
  for (const wv of f.wallVents || []) if (Math.abs(wv.x - p.x) < 2 + bot.skill * 3 && wv.z - p.z > 15) consider(wv.x, (wv.y0 + wv.y1) / 2, wv.z, 3.5, 0.25);
  for (const vn of f.vents || []) if (p.y - groundAt(f, vn.z) < f.height * 0.6) consider(vn.x, null, vn.z, 1.2);
  if (best && !bot.rp?.noSeek) {
    x = steerToward(p, best.x, best.z);
    if (best.y != null) y = clamp((best.y - p.y) * 0.3, -1, 1);
    else y = clamp((g + 3 - p.y) * 0.15, -0.6, 0.6);           // low over a vent: it lifts you the most
  }
  return { x, y };
}

export function botSteer(bot, race, p) {
  const f = race.floor;
  let tg = bot.target;
  if (!tg) return { x: 0, y: 0 };

  // Drop vent waypoints we've passed or ridden high enough in.
  while (bot.ways.length && (p.z > bot.ways[0].z + 1 || Math.hypot(bot.ways[0].z - p.z, bot.ways[0].x - p.x) > (p.y - groundAt(f, p.z) + Math.max(0, p.v - 11) * 0.6) * 8.5 + 6 || (p.y > f.height * 0.72 && p.z > bot.ways[0].z - 3))) bot.ways.shift();
  // Inside a hallway: forget vents and just thread the corridor.
  const hall = inHall(f, p.z, 45);
  const way = hall || tg.race ? null : bot.ways[0];

  let x, y;
  if (way) {
    // Cruise to the vent at an efficient speed.
    // Head for the vent, but via the lane while it's still far ahead.
    const ahead = p.z + 12;
    x = way.z - p.z > 15 ? steerToward(p, laneX(f, ahead), ahead) : steerToward(p, way.x, way.z);
    y = clamp((p.v - (Math.hypot(way.x - p.x, way.z - p.z) < way.vent.r ? 9 : 11.5)) * 0.28, -1, 1);
  } else if (hall || tg.z - p.z > 45 || tg.race) {
    // Far from the target (or in a hallway): follow the clear lane at an efficient speed.
    const rp = bot.rp || {};
    const ahead = p.z + (hall ? (tg.race ? (rp.ha ?? 4) + p.v * (rp.hv ?? 0.25) : 7) : 12);
    x = steerToward(p, laneX(f, ahead), ahead) * (hall && tg.race ? (rp.hg ?? 1.4) : 1);
    x = clamp(x, -1, 1);
    y = clamp((p.v - 11.5) * 0.28, -1, 1);
    // Race mode: speed matters more than glide; hold a middle height and let
    // the dives build speed
    if (tg.race) { const r = raceSteer(bot, race, p, x, hall); x = r.x; y = r.y; }
    // A doorway ahead: get under the lintel in time.
    // (race bots take whichever doorway in the wall is closest to their line)
    const doorsAhead = (f.doors || []).filter(d => d.z > p.z - 1 && d.z - p.z < (tg.race ? 60 : 45));
    const door = tg.race && doorsAhead.length ? doorsAhead.filter(d => Math.abs(d.z - doorsAhead[0].z) < 1).sort((a, b) => Math.abs(a.x - p.x) - Math.abs(b.x - p.x))[0] : doorsAhead[0];
    if (door) {
      const want = door.h - 1.6;
      if (p.y > want - 0.3) y = clamp(-(p.y - want) * 0.35, -1, 0.2);
      else if (p.y < want - 2.5) y = Math.max(y, 0.3);
      if (door.z - p.z < (tg.race ? 12 + p.v * 2.2 : 10)) x = clamp(steerToward(p, door.x, door.z + 2) * (tg.race ? 1.4 : 1), -1, 1);
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

  // Down in the Rooftop park: stay low under the lid of wind, and line up the
  // wind rings and tailwind streams ahead.
  const pk = f.gap?.park;
  if (pk && p.z > pk.dive1 && p.z < pk.lift0 && tg.z > pk.lift0) {
    const boost = [...pk.rings, ...pk.streams.map(s => ({ x: s.x, y: s.y, z: s.z0 + 2 }))]
      .filter(g => g.z > p.z + 2 && g.z - p.z < 40 && Math.abs(g.x - laneX(f, g.z)) < 2 + bot.skill * 12)
      .sort((a, b) => a.z - b.z)[0];
    const wantY = boost ? boost.y : pk.cruise + 1;
    // hug the winding lane closely (cutting its corners runs you into trees)
    x = steerToward(p, laneX(f, p.z + 6), p.z + 6);
    if (boost && boost.z - p.z < 26) x = steerToward(p, boost.x, boost.z);
    // (speed first: a slow plane noses down rather than climbing for a ring)
    y = clamp((p.v - 11.5) * 0.3 + (wantY - p.y) * 0.14 * clamp((p.v - 8) / 3, 0, 1), -1, 1);
  }

  // Look ahead along the heading and swerve around tall things (race bots
  // look further at speed and choose over, under or around).
  if (tg.race && !bot.rp?.oldAvoid) {
    const k = Math.max(1, p.v / 12) * (0.8 + bot.skill * 0.5);
    for (const s0 of [2.5, 5, 8, 12, 16]) {
      const s = s0 * k;
      const hx = p.x + Math.sin(p.yaw) * s, hz = p.z + Math.cos(p.yaw) * s;
      const hy = p.y + Math.sin(p.pitch) * s;
      const tt = race.t + s / Math.max(p.v, 1);
      const b = blocked(f, hx, hy, hz, tt);
      if (!b) continue;
      if (b === true) { x = hx > 0 ? -1 : 1; if (hy > f.height - 1) y = -0.7; break; }
      const over = !blocked(f, hx, hy + 2.5, hz, tt) && (b.y1 ?? 99) + 1.5 < f.height - 1;
      const under = b.y0 != null && b.y0 > groundAt(f, hz) + 2 && !blocked(f, hx, b.y0 - 1.2, hz, tt);
      const l = !blocked(f, p.x + Math.sin(p.yaw - 0.55) * s, hy, p.z + Math.cos(p.yaw - 0.55) * s, tt);
      const r = !blocked(f, p.x + Math.sin(p.yaw + 0.55) * s, hy, p.z + Math.cos(p.yaw + 0.55) * s, tt);
      if (under && (b.y0 - p.y) > -3) y = Math.min(y, -0.7);
      else if (over && (b.y1 - p.y) < 3) y = Math.max(y, 0.75);
      else if (l || r) x = l && r ? (laneX(f, hz) > p.x ? 1 : -1) : r ? 1 : -1;
      else y = over ? 0.8 : -0.8;
      break;
    }
  } else for (const s of [3, 6, 9]) {
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

  // Race mode: not getting anywhere (wedged on something)? Back off toward
  // the lane centre and climb for a moment.
  if (tg.race) {
    if (bot.progZ == null || p.z > bot.progZ + 6) { bot.progZ = p.z; bot.progT = race.t; }
    else if (race.t - bot.progT > 2.5) { bot.unstickUntil = race.t + 1.5; bot.progZ = p.z; bot.progT = race.t; }
    if (race.t < (bot.unstickUntil ?? -1)) { x = steerToward(p, laneX(f, p.z + 10), p.z + 10); y = p.y < f.height - 3 ? 0.6 : -0.3; }
  }
  const w = (1 - bot.skill) * (tg.race ? 0.08 : 0.2) * Math.sin(race.t * 2.3 + bot.wobble);
  return { x: clamp(x + w, -1, 1), y: clamp(y, -1, 1) };
}

// Shop logic for bots: each one builds toward a style (one part per slot, so
// buying never has to swap anything out). The wish list repeats an id to
// level it up; a level the bot's rank can't buy yet is skipped for now.
const BUILDS = [
  ['widewings', 'tissue', 'widewings', 'rubberband', 'magnet', 'widewings', 'tissue', 'flaps', 'rubberband', 'tissue', 'magnet', 'flaps', 'rubberband', 'magnet', 'flaps'],
  ['needle', 'rubberband', 'needle', 'afterburner', 'flaps', 'needle', 'glossy', 'afterburner', 'flaps', 'rubberband', 'glossy', 'afterburner', 'flaps', 'rubberband', 'glossy'],
  ['cardstock', 'tape', 'cardstock', 'binder', 'widewings', 'tape', 'cardstock', 'noseclip', 'binder', 'widewings', 'tape', 'noseclip', 'widewings', 'binder', 'noseclip'],
  ['swallowtail', 'vellum', 'swallowtail', 'bookmark', 'staple', 'vellum', 'swallowtail', 'highlighter', 'bookmark', 'vellum', 'staple', 'highlighter', 'bookmark', 'staple', 'highlighter'],
].map(list => {
  // The main part (the first on the list) goes to Mk IV partway through; after
  // Mk III everywhere, Mk IV of the rest in the same order, then Mk V.
  const order = [...new Set(list)];
  return [...list.slice(0, 10), order[0], ...list.slice(10), ...order.slice(1), ...order];
});
// Race mode builds: toughness (fewer crumples, so fewer janitor stops), speed
// from tricks and items, and sharp turning for the hallways.
const RACE_BUILDS = [
  ['cardstock', 'needle', 'staple', 'flaps', 'afterburner'],
  ['glossy', 'needle', 'pencil', 'bookmark', 'highlighter'],
  ['cardstock', 'stunt', 'staple', 'flaps', 'tape'],
  ['vellum', 'needle', 'noseclip', 'bookmark', 'afterburner'],
].map(([a, b, c, d, e]) => {
  const list = [a, b, a, c, d, a, b, e, c, b, d, e, c, d, e];
  return [...list.slice(0, 10), a, ...list.slice(10), b, c, d, e, a, b, c, d, e];
});
// The old fixed-order shopper, kept for comparison runs (see botPlanShop).
export function botShopFixed(bot, clips, parts = {}, rank = Infinity) {
  const wish = (bot.race ? RACE_BUILDS : BUILDS)[bot.seat % BUILDS.length];
  const have = { ...parts };
  const buys = [];
  let left = clips;
  const want = {};
  for (const id of wish) {
    want[id] = (want[id] || 0) + 1;
    if ((have[id] || 0) >= want[id]) continue;
    const st = partState(have, id, rank);
    if (st.state !== 'open') continue;
    if (st.cost > left) break;              // save up for it rather than skip ahead
    have[id] = (have[id] || 0) + 1; buys.push(id); left -= st.cost;
  }
  return buys;
}

/* Strategic shopping. PART_VALUE (measured headlessly, see part-values.js)
   says what each part is worth on each floor at Mk I, III and V: seconds
   saved per race in Race mode, points gained per race in Golf. Each shop visit
   a bot:
     - values every possible purchase as the gain over the best part it
       already owns for that slot, on the floors still to come, times the
       races left, per clip;
     - buys the best one it can afford, or saves for a clearly better one it
       can afford by next shop;
     - leans toward toughness after a race where it crumpled;
     - has a small personal leaning toward one slot, so the bots differ;
     - fits the best part it owns in each slot for the next floor (swaps are free).
   ctx: { mode, floorsLeft: [floor ids], crumples, income } */
const TOUGH = new Set(['cardstock', 'tape']);
const LEAN = ['fold', 'gadget', 'paper', 'tail', 'nose'];
function partValue(mode, floorsLeft, id, lv) {
  if (!lv) return 0;
  const table = PART_VALUE[mode] || PART_VALUE.golf;
  const fl = floorsLeft.length ? floorsLeft : Object.keys(table);
  let sum = 0;
  for (const f of fl) {
    const v = table[f]?.[id];
    if (!v) continue;
    sum += lv === 1 ? v[0] : lv === 2 ? (v[0] + v[1]) / 2 : lv === 3 ? v[1] : lv === 4 ? (v[1] + v[2]) / 2 : v[2];
  }
  return sum / fl.length;
}
export function botPlanShop(bot, clips, parts = {}, rank = Infinity, ctx = {}) {
  const mode = ctx.mode === 'race' ? 'race' : 'golf';
  const floorsLeft = ctx.floorsLeft || [];
  const racesLeft = Math.max(1, floorsLeft.length);
  const lean = LEAN[bot.seat % LEAN.length];
  const want = (id, lv) => {
    const u = UPGRADE_BY_ID[id];
    let v = partValue(mode, floorsLeft, id, lv);
    if (v > 0 && TOUGH.has(id) && ctx.crumples) v *= 1 + 0.35 * Math.min(3, ctx.crumples);
    if (v > 0 && u.slot === lean) v *= 1.15;
    return v;
  };
  const have = { ...parts };
  const slotBest = slot => Math.max(0, ...UPGRADES.filter(u => u.slot === slot && have[u.id]).map(u => want(u.id, have[u.id])));
  const buys = [];
  let left = clips;
  for (let guard = 0; guard < 12; guard++) {
    const opts = [];
    for (const u of UPGRADES) {
      const st = partState(have, u.id, rank);
      if (st.state !== 'open') continue;
      const gain = want(u.id, (have[u.id] || 0) + 1) - slotBest(u.slot);
      if (gain <= 0.05) continue;
      opts.push({ id: u.id, cost: st.cost, gain, score: (gain * racesLeft) / st.cost });
    }
    if (!opts.length) break;
    opts.sort((a, b) => b.score - a.score);
    const top = opts[0];
    const afford = opts.filter(o => o.cost <= left);
    let pick = null;
    if (top.cost <= left) pick = top;
    else {
      // Worth saving for? Only if it's clearly better and affordable by next shop
      const nextShop = left + (ctx.income || 0);
      const alt = afford[0];
      if (racesLeft > 1 && top.cost <= nextShop && (!alt || alt.score < top.score * 0.6)) break;
      pick = alt || null;
    }
    if (!pick) break;
    have[pick.id] = (have[pick.id] || 0) + 1; buys.push(pick.id); left -= pick.cost;
  }
  // Fit the best part owned in each slot for the next floor
  const next = floorsLeft[0] ? [floorsLeft[0]] : floorsLeft;
  const loadout = {};
  for (const sl of new Set(UPGRADES.map(u => u.slot))) {
    let best = null, bv = 0.05;
    for (const u of UPGRADES) if (u.slot === sl && have[u.id]) {
      const v = partValue(mode, next, u.id, have[u.id]);
      if (v > bv) { bv = v; best = u.id; }
    }
    loadout[sl] = best;      // null: stock is best here
  }
  return { buys, loadout };
}
// Simple form (old callers): just the list of buys
export function botShop(bot, clips, parts = {}, rank = Infinity, ctx = {}) {
  return botPlanShop(bot, clips, parts, rank, ctx).buys;
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
