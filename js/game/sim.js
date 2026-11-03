// sim.js: paper-plane flight physics and race simulation. Pure: no DOM, no network.
//
// Coordinate system (sim space): x = lateral (+ is the pilot's right), y = up,
// z = forward distance along the floor (start at 0, end wall at floor.length).
// The renderer maps sim z to three.js -z so "forward" points into the screen.
//
// The flight model is a simple energy glider:
//   speed changes with gravity along the flight path and quadratic drag,
//   altitude changes with v*sin(pitch) minus a sink rate that grows as speed drops.
// Diving converts height into speed; climbing converts speed back into height.
// Paper planes don't fly forever, so the best line through vents and around
// obstacles decides who reaches the far landing zones.

import { statsFor } from '../shared/upgrades.js';
import { moverBox, ringAt, RINGS, groundAt, gapWind, treesNear, treeHit } from './floors.js';

export const SIM = {
  dt: 1 / 60,
  G: 9.0,
  vRef: 13,          // speed where sink equals baseSink
  vStall: 5.5,
  baseSink: 0.6,
  dragK: 0.0024,
  launchMax: 16,
  startY: 5.6,
  planeR: 0.45,      // collision radius
  restH: 0.12,       // how high a resting plane sits on a surface
  clipR: 1.25,       // pickup radius before magnet
  raceTime: 48,      // seconds after GO before stragglers are forced down
  throwWindow: 9,    // seconds to throw before an automatic weak toss
  // Paper fatigue (see flyStep): below fatigueV of forward speed it builds up
  fatigueV: 7, fatigueRate: 0.9, fatigueRecover: 0.6, fatigueMax: 3, fatigueSink: 0.9,
};

// Power-up items. Fly through one and its bonus kicks in at once; grabbing the
// same kind again while it runs restarts its clock. An item comes back a few
// seconds after someone takes it, so pilots further back still get a chance.
export const ITEMS = {
  donut:    { label: 'Donut',         dur: 3,  what: 'Thrust' },
  card:     { label: 'Index Card',    dur: 5,  what: 'Invincible' },
  glue:     { label: 'Glue Bottle',   dur: 5,  what: 'Clip magnet' },
  chipclip: { label: 'Chip Bag Clip', dur: 10, what: 'Clips +2' },
  // added 2026-11-02
  coffee:   { label: 'Coffee Cup',    dur: 5,  what: 'Thrust' },
  eraser:   { label: 'Eraser',        dur: 0,  what: 'Repairs 35', heal: 35 },
  bubble:   { label: 'Bubble Wrap',   dur: 5,  what: 'Float up' },
};
export const ITEM_RESPAWN = 8, ITEM_R = 1.7, GLUE_R = 7;

/* ------------------------------------------------------------ race mode --- */
// Race mode (floor.finish set): first plane to stick into the cork board on the back wall wins. Planes don't
// land: touching down skims you back up, the building's air keeps you at a
// cruising speed, and a crumpled plane is scooped up by the janitor and put
// back on the lane after RESPAWN_S seconds with half its durability.
export const RACE_PTS = [15, 12, 10, 8, 6, 4, 2, 1];
export const RACE = { cruise: 13, cruiseAccel: 5, skimV: 9, respawnS: 2, close: 25 };
export const isRaceMode = race => race.mode === 'race';
// x of the clear lane at z (the floor's lane control points)
export function laneAt(floor, z) {
  const c = floor.lane || [[0, 0]];
  for (let i = 1; i < c.length; i++) if (z <= c[i][0]) { const [z0, x0] = c[i - 1], [z1, x1] = c[i]; return x0 + (x1 - x0) * ((z - z0) / Math.max(1e-6, z1 - z0)); }
  return c[c.length - 1][1];
}
// Live running order: finishers by time, then everyone else by how far along
export function raceOrder(race) {
  return [...race.planes].sort((a, b) =>
    (a.finished && b.finished ? a.finishedAt - b.finishedAt : 0) || ((b.finished ? 1 : 0) - (a.finished ? 1 : 0)) || (b.maxZ - a.maxZ));
}
export const itemReady = (race, it) => race.t - it.takenAt >= ITEM_RESPAWN;
export const buffOn = (race, p, k) => (p.buffs?.[k] ?? -1) > race.t;

// Scoring. A run scores distance points (how far down the floor you got, out
// of 10, landed on a target or not) plus target points for landing on one,
// worth the full amount under the target's par time and shrinking to nothing
// at double par. Bullseyes and inner rings multiply the target points.
export const TIER_PTS = [3, 5, 8, 11, 15];
export function scoreRun(floor, p, now) {
  const L = floor.length || 800;
  const dist = Math.max(0, p.state === 'landed' ? (p.dist ?? p.z) : p.z);
  const distPts = Math.round(10 * Math.min(1, dist / L));
  let targetPts = 0, parFactor = 0, flightT = null, par = null;
  if (p.zone && !p.crumpled) {
    flightT = Math.round(((p.landedAt ?? now ?? 0) - (p.thrownAt ?? 0)) * 10) / 10;
    par = p.zone.par ?? null;
    parFactor = par ? clamp(2 - flightT / par, 0, 1) : 1;
    targetPts = Math.round(TIER_PTS[p.zone.tier] * (RINGS[p.zone.ring ?? 2]?.mult ?? 1) * parFactor);
  }
  return { distPts, targetPts, total: distPts + targetPts, parFactor, flightT, par };
}

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;

/* --------------------------------------------------------------- setup --- */

export function startX(seat, count) {
  return (seat - (count - 1) / 2) * 2.6;
}

export function createRace(floor, players) {
  const count = players.length;
  const planes = players.map((p, i) => {
    const st = statsFor(p.owned);
    return {
      seat: p.seat, slot: i, st,
      x: startX(i, count), y: SIM.startY, z: 0.6,
      yaw: 0, pitch: 0, roll: 0, v: 0,
      hp: st.hp, maxHp: st.hp,
      state: 'held',        // held | fly | slide | fall | landed
      crumpled: false,
      support: 0,           // y of the surface we're sliding on
      inX: 0, inY: 0,
      aim: { yaw: 0, pitch: 0.18, power: 0 },
      clips: 0,
      thrownAt: null, landedAt: null,
      zone: null, dist: 0, maxZ: 0,
      tr: newTricks(),
    };
  });
  const clips = floor.clips.map(c => ({ ...c, taken: -1 }));
  const items = (floor.items || []).map(it => ({ ...it, takenAt: -99 }));
  // Planes fly the same on every floor; longer floors just allow longer flights
  // (riding vents) before stragglers are forced down.
  // Race mode: 1.5-2.5 minutes of flying to the cork board; once the winner is
  // through, everyone else gets RACE_CLOSE seconds to finish.
  const isRace = !!floor.finish;
  const timeLimit = isRace ? 40 + floor.length / 9 : SIM.raceTime + (floor.length || 200) / 10;
  return { floor, mode: isRace ? 'race' : 'golf', timeLimit, t: 0, planes, clips, items, events: [], over: false, overAt: null, finishers: 0 };
}

/* -------------------------------------------------------------- inputs --- */

export function aimPlane(race, seat, aim) {
  const p = race.planes.find(q => q.seat === seat);
  if (!p || p.state !== 'held') return;
  p.aim.yaw = clamp(+aim.yaw || 0, -0.5, 0.5);
  p.aim.pitch = clamp(+aim.pitch || 0, -0.1, 0.6);
  p.aim.power = clamp(+aim.power || 0, 0, 1);
}

export function throwPlane(race, seat, aim) {
  const p = race.planes.find(q => q.seat === seat);
  if (!p || p.state !== 'held') return false;
  if (aim) aimPlane(race, seat, aim);
  const power = 0.35 + 0.65 * p.aim.power;
  p.yaw = p.aim.yaw;
  p.pitch = p.aim.pitch;
  p.v = SIM.launchMax * power * p.st.launch / (0.85 + 0.15 * p.st.weight);
  // Rubber Band Launcher Mk V: let go right on GO for an extra-hard throw
  if (p.st.perk.rubberband && race.t < 0.5) p.v *= 1.08;
  p.state = 'fly';
  p.thrownAt = race.t;
  race.events.push({ name: 'throw', seat, power: p.aim.power, boost: p.st.launch > 1 });
  // Quick Draw: a full-power throw inside the first second after GO
  if (race.t < 1 && p.aim.power > 0.8) trick(race, p, 'quick');
  return true;
}

export function steer(race, seat, x, y) {
  const p = race.planes.find(q => q.seat === seat);
  if (!p) return;
  p.inX = clamp(+x || 0, -1, 1);
  p.inY = clamp(+y || 0, -1, 1);
}

/* ---------------------------------------------------------------- step --- */

export function stepRace(race, dt = SIM.dt) {
  race.t += dt;
  const f = race.floor;
  for (const p of race.planes) {
    if (p.state === 'held') {
      if (race.t > SIM.throwWindow) throwPlane(race, p.seat, { ...p.aim, power: Math.max(p.aim.power, 0.25) });
      continue;
    }
    if (p.state === 'landed') {
      // Race mode: the janitor puts a crumpled plane back on the lane
      if (p.respawnAt != null && race.t >= p.respawnAt) {
        if (race.t >= race.timeLimit) { p.respawnAt = null; p.dnf = true; }
        else respawn(race, p);
      }
      continue;
    }

    // Race mode: out of time means you didn't finish (no crumple)
    if (isRaceMode(race) && race.t > race.timeLimit && (p.state === 'fly' || p.state === 'fall' || p.state === 'slide')) {
      p.state = 'landed'; p.dnf = true; p.landedAt = race.t; p.dist = Math.max(0, p.maxZ); p.respawnAt = null;
      race.events.push({ name: 'timeout', seat: p.seat });
      continue;
    }
    // Out of time: stragglers stuck circling in a vent get dropped.
    if (race.t > race.timeLimit && p.state === 'fly') {
      p.state = 'fall'; p.crumpled = true; p.hp = 0;
      race.events.push({ name: 'timeout', seat: p.seat });
    }

    stepPlane(race, p, dt);
  }

  if (!race.over && race.planes.every(p => p.state === 'landed' && p.respawnAt == null)) {
    race.over = true; race.overAt = race.t;
  }
  return race;
}

/* -------------------------------------------------------------- tricks --- */
// Trick shots pay bonus paper clips. Every trick in one flight grows a combo
// multiplier (x2, x3, up to x5); taking a hit breaks the chain. Bot look-ahead
// copies set p.tr = null so predictions never score tricks.
export const TRICKS = {
  close:    { label: 'Close Call',        value: 1 },
  doorway:  { label: 'Thread the Needle', value: 3 },
  under:    { label: 'Under the Desk',    value: 2 },
  drafts:   { label: 'Draft Chain',       value: 2 },
  hallway:  { label: 'Clean Hallway',     value: 4 },
  bullseye: { label: 'Bullseye',          value: 3 },
  perch:    { label: 'Stuck It',          value: 4 },
  bank:     { label: 'Bank Shot',         value: 3 },
  clutch:   { label: 'Running on Fumes',  value: 3 },
  window:   { label: 'Window Washer',     value: 8 },
  duct:     { label: 'Duct Rat',          value: 5 },   // threading a wall vent
  // Flying style
  circle:   { label: 'Full Circle',       value: 4 },
  ceiling:  { label: 'Ceiling Skim',      value: 3 },
  carpet:   { label: 'Carpet Burner',     value: 3 },
  zigzag:   { label: 'Zigzag',            value: 2 },
  speed:    { label: 'Speed Demon',       value: 3 },
  stall:    { label: 'Stall Recovery',    value: 3 },
  hang:     { label: 'Hang Time',         value: 4 },
  dodge:    { label: 'Traffic Dodger',    value: 3 },
  sweep:    { label: 'Clip Sweep',        value: 3 },
  slip:     { label: 'Slipstream',        value: 4 },
  // More flying style (added 2026-11-01)
  knife:    { label: 'Knife Edge',        value: 3 },
  nosedive: { label: 'Pull Up!',          value: 3 },
  rocket:   { label: 'Rocket Climb',      value: 2 },
  elevator: { label: 'Elevator Ride',     value: 3 },
  hoops:    { label: 'Hoop Streak',       value: 4 },
  windride: { label: 'Wind Rider',        value: 3 },
  edge:     { label: 'Off the Edge',      value: 3 },
  quick:    { label: 'Quick Draw',        value: 2 },
  feather:  { label: 'Feather Touch',     value: 3 },
  spotless: { label: 'Spotless',          value: 4 },
  // Basement
  rung:     { label: 'Rung Runner',       value: 4 },   // through a ladder, between the rungs
};
// Chain multiplier per trick in a flight: x1, x1.5, x2, x2.5, x3 (cap).
const chainMult = n => Math.min(3, 1 + 0.5 * (n - 1));
// Repeatable tricks are capped per flight so one floor full of vents can't
// outscore the landing zones.
const PER_FLIGHT = 3;   // any trick pays at most 3 times in one flight
function newTricks() {
  return {
    list: [], chain: 0, clips: 0, vents: [], under: [], doors: [], hall: null,
    turn: 0, turnSign: 0, ceilT: 0, lowT: 0, flips: [], rollSign: 0, stalledAt: null, clipTimes: [], behind: {},
    knifeT: 0, diveT: 0, diveAt: null, climbY: null, lift: null, rings: 0, ride: null, ladders: [],
  };
}

const TRICK_BOOST_CAP = 26;   // a boost never pushes a plane past this speed

function trick(race, p, id) {
  const tr = p.tr;
  if (!tr) return;
  const t = TRICKS[id];
  if (tr.list.filter(x => x.id === id).length >= PER_FLIGHT) return;
  tr.chain = Math.min(5, tr.chain + 1);
  const mult = chainMult(tr.chain);
  // Stunt Fold Mk V: every trick after the first in a combo pays one more clip
  const clips = Math.round(t.value * mult) + (p.st.perk.stunt && tr.chain > 1 ? 1 : 0);
  tr.clips += clips;
  tr.list.push({ id, label: t.label, value: t.value, mult, clips });
  // Afterburner Doodle: mid-flight tricks kick the plane forward. No upgrade, no boost.
  let boost = 0;
  if (p.st.trickBoost > 0 && !p.crumpled && (p.state === 'fly' || p.duct != null || p.out)) {
    // Mk V: bursts are 50% bigger and may push past the usual cap
    const big = p.st.perk.afterburner, cap = big ? TRICK_BOOST_CAP + 4 : TRICK_BOOST_CAP;
    boost = Math.max(0, Math.min(p.st.trickBoost * (big ? 1.5 : 1), cap - p.v));
    p.v += boost;
  }
  race.events.push({ name: 'trick', seat: p.seat, id, label: t.label, value: t.value, mult, clips, boost, x: p.x, y: p.y, z: p.z });
}

function flightTricks(race, p, px, py, pz, dt, pyaw) {
  const tr = p.tr, f = race.floor;
  if (!tr || p.state !== 'fly' || p.crumpled || p.duct != null || p.out) return;
  styleTricks(race, p, dt, pyaw);
  // Through a doorway, under the lintel
  (f.doors || []).forEach((d, i) => {
    if (tr.doors.includes(i)) return;
    if (pz < d.z && p.z >= d.z && Math.abs(p.x - d.x) < d.w / 2 && p.y < d.h) { tr.doors.push(i); trick(race, p, 'doorway'); }
  });
  // Between the rungs of a ladder (Basement)
  (f.ladders || []).forEach((l, i) => {
    if (tr.ladders.includes(i)) return;
    if (pz < l.z && p.z >= l.z && Math.abs(p.x - l.x) < l.w / 2 - 0.3 && p.y > 0.4 && p.y < l.h - 0.4
      && l.rungs.every(y => Math.abs(p.y - y) > 0.12 + SIM.planeR) && race.t - (p.scrapeT ?? -9) > 0.6) { tr.ladders.push(i); trick(race, p, 'rung'); }
  });
  // Under a desk or table (not the launch desk)
  (f.objects || []).forEach((o, i) => {
    if ((o.type !== 'desk' && o.type !== 'table') || o.launch || tr.under.includes(i)) return;
    if (p.y < o.h - 0.6 && Math.abs(p.x - o.x) < o.w / 2 && Math.abs(p.z - o.z) < o.d / 2) { tr.under.push(i); trick(race, p, 'under'); }
  });
  // Riding a second (third...) different vent in one flight
  f.vents.forEach((v, i) => {
    if (tr.vents.includes(i)) return;
    if ((p.x - v.x) ** 2 + (p.z - v.z) ** 2 < v.r * v.r) { tr.vents.push(i); if (tr.vents.length >= 2 && tr.vents.length % 2 === 0) trick(race, p, 'drafts'); }
  });
  // All the way down a hallway without touching anything
  (f.halls || []).forEach(([zs, ze], i) => {
    if (pz < zs && p.z >= zs) tr.hall = { i, hit: p.lastHit ?? -1 };
    if (tr.hall && tr.hall.i === i && pz < ze && p.z >= ze) {
      if ((p.lastHit ?? -1) === tr.hall.hit) trick(race, p, 'hallway');
      tr.hall = null;
    }
  });
}

// Flying-style tricks: things you do with the plane rather than places you go.
function styleTricks(race, p, dt, pyaw) {
  const tr = p.tr, f = race.floor, t = race.t;
  const cleanSince = at => (p.lastHit ?? -99) < at;     // no hit since time `at`

  // Full Circle: turn (very nearly) all the way around in one direction without straightening out
  const dy = Math.atan2(Math.sin(p.yaw - pyaw), Math.cos(p.yaw - pyaw));
  const sg = Math.sign(dy);
  if (Math.abs(p.roll) < 0.25 || (sg && sg !== tr.turnSign)) { tr.turn = 0; tr.turnSign = sg; }
  tr.turn += Math.abs(dy);
  if (tr.turn >= Math.PI * 1.7) { tr.turn = 0; trick(race, p, 'circle'); }

  // Ceiling Skim: hug the ceiling for 2 s without touching it
  tr.ceilT = !f.open && p.y > f.height - 1.4 && cleanSince(t - 2) ? tr.ceilT + dt : 0;
  if (tr.ceilT >= 2) { tr.ceilT = -3; trick(race, p, 'ceiling'); }

  // Carpet Burner: skim the floor at speed for 1.5 s
  tr.lowT = p.y - groundAt(f, p.z) < 1.1 && p.v > 10 ? tr.lowT + dt : 0;
  if (tr.lowT >= 1.5) { tr.lowT = -3; trick(race, p, 'carpet'); }

  // Zigzag: four hard bank reversals inside 3 s
  const rs = p.roll > 0.45 ? 1 : p.roll < -0.45 ? -1 : 0;
  if (rs && rs !== tr.rollSign) { if (tr.rollSign) tr.flips.push(t); tr.rollSign = rs; }
  tr.flips = tr.flips.filter(x => t - x < 3);
  if (tr.flips.length >= 4) { tr.flips = []; trick(race, p, 'zigzag'); }

  // Speed Demon: hit top speed
  if (p.v >= 20 && !tr.fast) { tr.fast = true; trick(race, p, 'speed'); }
  else if (p.v < 17) tr.fast = false;          // drop back below to earn it again

  // Stall Recovery: stall, then dive back up to cruising speed cleanly
  if (p.v < SIM.vStall) tr.stalledAt ??= t;
  else if (tr.stalledAt != null && p.v > 10) {
    if (t - tr.stalledAt < 5 && cleanSince(tr.stalledAt)) trick(race, p, 'stall');
    tr.stalledAt = null;
  }

  // Hang Time: stay airborne about as long as it takes to cross the whole floor
  // (and again at double and triple that time)
  tr.hangN ??= 0;
  if (p.thrownAt != null && t - p.thrownAt >= (tr.hangN + 1) * (f.length || 800) / 26) { tr.hangN++; trick(race, p, 'hang'); }

  // Knife Edge: hold a full bank for 1.4 s at speed
  tr.knifeT = Math.abs(p.roll) > 0.78 && p.v > 8 ? tr.knifeT + dt : Math.min(0, tr.knifeT);
  if (tr.knifeT >= 1.4) { tr.knifeT = -2; trick(race, p, 'knife'); }

  // Pull Up!: a steep dive for most of a second, then level out clean before the floor
  if (p.pitch < -0.45) { tr.diveT += dt; tr.diveAt ??= t; }
  else if (p.pitch > -0.1) {
    if (tr.diveT >= 0.6 && p.y - groundAt(f, p.z) > 0.6 && cleanSince(tr.diveAt)) trick(race, p, 'nosedive');
    tr.diveT = 0; tr.diveAt = null;
  }

  // Rocket Climb: nose up and gain 5 height in one go
  if (p.pitch > 0.4) {
    tr.climbY ??= p.y;
    if (p.y - tr.climbY >= 5) { tr.climbY = Infinity; trick(race, p, 'rocket'); }
  } else tr.climbY = null;

  // Elevator Ride: ride one vent up 5 height
  const vi = f.vents.findIndex(v => (p.x - v.x) ** 2 + (p.z - v.z) ** 2 < v.r * v.r);
  if (vi < 0) tr.lift = null;
  else if (!tr.lift || tr.lift.i !== vi) tr.lift = { i: vi, y: p.y, done: false };
  else if (!tr.lift.done && p.y - tr.lift.y >= 5) { tr.lift.done = true; trick(race, p, 'elevator'); }

  // Slipstream: tuck in right behind another plane for 1.5 s, then pass it
  for (const o of race.planes) {
    if (o === p || o.state !== 'fly') continue;
    const fx = Math.sin(o.yaw), fz = Math.cos(o.yaw);
    const rx = p.x - o.x, ry = p.y - o.y, rz = p.z - o.z;
    const along = rx * fx + rz * fz;                         // + ahead of o, - behind
    const side = Math.hypot(rx - along * fx, rz - along * fz, ry);
    const key = o.seat;
    if (along < -0.5 && along > -6 && side < 2.2) tr.behind[key] = (tr.behind[key] || 0) + dt;
    else if (along > 0.5 && (tr.behind[key] || 0) >= 0.75 && side < 6) { tr.behind[key] = 0; trick(race, p, 'slip'); }
    else if (along < -8 || side > 6) tr.behind[key] = 0;
  }
}

function landingTricks(race, p, zn) {
  if (!p.tr || p.crumpled || !zn) return;
  if (zn.ring === 0) trick(race, p, 'bullseye');
  if (p.lastHit != null && race.t - p.lastHit < 3) trick(race, p, 'bank');
  if (p.hp <= p.maxHp * 0.25) trick(race, p, 'clutch');
  // Feather Touch: settle onto a zone barely sinking at all
  if ((p.touchVy ?? -9) > -1.6) trick(race, p, 'feather');
  // Spotless: land on a zone without a single scratch
  if (p.lastHit == null && p.hp >= p.maxHp) trick(race, p, 'spotless');
}

export function stepPlane(race, p, dt) {
  const px = p.x, py = p.y, pz = p.z, pyaw = p.yaw;
  if (p.state === 'fly') flyStep(race, p, dt, pz);
  else if (p.state === 'slide') slideStep(race, p, dt);
  else if (p.state === 'fall') fallStep(race, p, dt, pz);
  if (p.state === 'landed') return;
  // Race mode: reaching the cork board on the back wall sticks you into it
  const fz = race.floor.finish?.z;
  if (fz != null && p.state === 'fly' && !p.crumpled && p.duct == null && !p.out && p.z >= fz) { finishRace(race, p); return; }
  collide(race, p, px, py, pz);
  pickups(race, p);
  flightTricks(race, p, px, py, pz, dt, pyaw);
  p.maxZ = Math.max(p.maxZ, p.z);
}

function finishRace(race, p) {
  const f = race.floor;
  p.finished = true; p.finishedAt = race.t; p.place = ++race.finishers;
  p.state = 'landed'; p.landedAt = race.t; p.dist = f.length; p.v = 0;
  // stuck in the cork, nose first, a little tipped the way you came in
  p.z = f.length - 0.55; p.maxZ = Math.max(p.maxZ, p.z);
  p.x = clamp(p.x, -f.width / 2 + 1.2, f.width / 2 - 1.2);
  p.y = clamp(p.y, groundAt(f, p.z) + 0.8, f.height - 0.8);
  p.yaw = clamp(p.yaw, -0.35, 0.35); p.pitch = clamp(p.pitch, -0.3, 0.3) - 0.08; p.roll = clamp(p.roll, -0.4, 0.4);
  race.events.push({ name: 'finish', seat: p.seat, place: p.place, t: Math.round((race.t - (p.thrownAt ?? 0)) * 10) / 10 });
  // first one through: everyone else gets a little longer to finish
  if (p.place === 1) race.timeLimit = Math.min(race.timeLimit, race.t + RACE.close);
}

function respawn(race, p) {
  const f = race.floor, r = SIM.planeR;
  let z = Math.max(6, p.maxZ - 2), x = clamp(laneAt(f, z), -f.width / 2 + 2, f.width / 2 - 2), y = groundAt(f, z) + 5;
  if (f.gap?.park && z > f.gap.z0 && z < f.gap.z1) y = f.gap.park.cruise;
  // find a clear spot: up over furniture, or a little further along
  for (let i = 0; i < 30; i++) {
    const hit = f.boxes.find(b => x > b.x0 - r - 0.5 && x < b.x1 + r + 0.5 && z > b.z0 - r - 0.5 && z < b.z1 + r + 0.5 && y > b.y0 - r - 0.5 && y < b.y1 + r + 0.5);
    if (!hit) break;
    if (hit.y1 + 1.6 < f.height - 1.5) y = hit.y1 + 1.6;
    else { z += 3; x = clamp(laneAt(f, z), -f.width / 2 + 2, f.width / 2 - 2); y = groundAt(f, z) + 5; }
  }
  Object.assign(p, {
    x, y, z, yaw: 0, pitch: 0, roll: 0, v: 11, vy: 0, state: 'fly', crumpled: false, hp: Math.round(p.maxHp * 0.5),
    respawnAt: null, landedAt: null, fatigue: 0, out: null, duct: null, zone: null,
  });
  if (p.tr) p.tr.chain = 0;
  // a moment of safety right after the drop
  p.buffs = { ...(p.buffs || {}), card: race.t + 1.2 };
  race.events.push({ name: 'respawn', seat: p.seat, x, y, z });
}

function flyStep(race, p, dt, pz = p.z) {
  const st = p.st, f = race.floor;

  // Pitch: stick up = climb. A slight nose-down trim keeps a hands-off plane gliding.
  const vStall = SIM.vStall, vRef = SIM.vRef;
  let target = -0.05 + p.inY * 0.55;
  // (Swallowtail Fold Mk V: a stall barely tips the nose down)
  if (p.v < vStall) target = lerp(target, st.perk.swallowtail ? -0.28 : -0.7, clamp((vStall - p.v) / vStall + 0.3, 0, 1));
  p.pitch += (target - p.pitch) * clamp(2.6 * dt, 0, 1);
  p.pitch = clamp(p.pitch, -1.1, 0.9);

  // Bank and turn. Heavier, slower planes turn less; banking costs energy.
  p.roll += (p.inX * 0.85 - p.roll) * clamp(4 * dt, 0, 1);
  const vs = clamp(p.v / vRef, 0.45, 1.3);
  p.yaw += p.roll * 1.25 * st.turn * vs * dt;

  // (Sticky Note Flaps Mk V: banking costs no speed)
  const D = SIM.dragK * st.drag * (0.85 + 0.15 * st.weight) * (1 + (st.perk.flaps ? 0 : p.roll * p.roll * 0.5));
  // Bubble Wrap: speed never drops while it lasts, so you can climb for free
  const dv = (-SIM.G * Math.sin(p.pitch) - D * p.v * p.v) * dt;
  p.v += buffOn(race, p, 'bubble') ? Math.max(0, dv) : dv;
  // Race mode: the building's air keeps you moving at a cruising speed
  // (p.catchup: extra cruise the host gives computer racers who've fallen
  // behind the human players, kart-style)
  const cruise = RACE.cruise + (p.catchup || 0);
  if (race.mode === 'race' && p.v < cruise && !p.crumpled) p.v += RACE.cruiseAccel * dt;
  p.v = clamp(p.v, 0.5, 40);

  const sinkRatio = clamp((vRef / Math.max(p.v, 0.5)) ** 2, 0.55, 5 * st.stallDrop);
  let sink = SIM.baseSink * st.sink * Math.pow(st.weight, 0.9) * sinkRatio;

  const h = p.v * Math.cos(p.pitch);
  // Paper fatigue: a plane has to keep making headway down the floor. Circling,
  // hovering in a vent or crawling along builds fatigue, and fatigue makes it
  // sink faster; flying forward with purpose shakes it off again.
  // Bookmark Ribbon slows the build-up (and speeds recovery); at Mk V there's
  // no fatigue at all on the last 20% of the floor. Wide Glider Mk V only
  // starts tiring below 5.5.
  const vz = h * Math.cos(p.yaw);
  const fV = st.perk.widewings ? 5.5 : SIM.fatigueV;
  if (st.perk.bookmark && p.z > 0.8 * (f.length || 800)) p.fatigue = 0;
  else if (vz < fV) p.fatigue = Math.min(SIM.fatigueMax, (p.fatigue || 0) + (1 - Math.max(0, vz) / fV) * SIM.fatigueRate * st.fatigue * dt);
  else p.fatigue = Math.max(0, (p.fatigue || 0) - SIM.fatigueRecover / st.fatigue * dt);
  sink *= 1 + SIM.fatigueSink * p.fatigue;
  // ...and it floats you gently upward instead of sinking
  if (buffOn(race, p, 'bubble')) sink = -1.4;
  // Tissue Paper Mk V: a cushion of air just above the floor
  if (st.perk.tissue && p.y - groundAt(f, p.z) < 1.4 && p.pitch < 0.1) sink *= 0.45;
  p.x += Math.sin(p.yaw) * h * dt;
  p.z += Math.cos(p.yaw) * h * dt;
  p.y += (p.v * Math.sin(p.pitch) - sink) * dt;

  // Air currents
  let inDraft = false;
  for (const vnt of f.vents) {
    const d2 = (p.x - vnt.x) ** 2 + (p.z - vnt.z) ** 2;
    if (d2 < vnt.r * vnt.r && p.duct == null && !p.out) {
      const edge = 1 - Math.sqrt(d2) / vnt.r;
      // (the vent under a ceiling duct's hole keeps pushing all the way up into it)
      const fall = vnt.duct ? 1 : clamp(1 - p.y / (f.height * 0.95), 0, 1);
      p.y += vnt.s * 1.6 * st.lift * (0.5 + 0.5 * edge) * fall * dt;
      // Drafts also carry you forward: riding one is a speed boost.
      // (Vellum Mk V: 50% more push)
      p.v += vnt.s * 0.5 * (st.perk.vellum ? 1.5 : 1) * (0.5 + 0.5 * edge) * dt;
      inDraft = 'up';
    }
  }
  for (const fan of f.fans) {
    const d2 = (p.x - fan.x) ** 2 + (p.z - fan.z) ** 2;
    if (d2 < fan.r * fan.r && p.duct == null && !p.out) {
      const edge = 1 - Math.sqrt(d2) / fan.r;
      p.y -= fan.s * st.wind * (0.4 + 0.6 * edge) * dt;
      // A downdraft costs height but pushes you faster (Nose Clip doesn't blunt this).
      p.v += fan.s * 1.1 * (0.4 + 0.6 * edge) * dt;
      inDraft = 'down';
    }
  }
  // Outside on the ledge run: a crosswind shoves you away from the building
  // ...and air rising up the facade roughly cancels your sink, so a clean
  // line can hold window height all the way along.
  // (Paper Clip Nose Mk V: crosswinds don't push you)
  const cross = st.perk.noseclip ? 0 : st.wind;
  if (p.out && f.ledge) { p.x += f.ledge.side * f.ledge.wind * cross * dt; p.y += 1.25 * dt; }
  // In a duct: the airflow carries you along
  if (p.duct != null && p.v < 21) p.v += 6 * dt;
  // The Rooftop park. Off the edge of the first roof a huge downdraft shoves
  // every plane down among the trees, and a lid of wind keeps you there; at
  // the far end a wall of updraft carries everyone still flying back up over
  // the far roof. In between, the crosswind swings you about and wind rings
  // and tailwind streams keep your speed up.
  const gp = f.gap, pk = gp?.park;
  if (pk && p.z > gp.z0 && p.z < gp.z1 && !p.crumpled) {
    const w = gapWind(gp, race.t);
    p.x += w.side * gp.cross * 0.5 * cross * dt;
    if (pz < pk.dive0 + 0.01 && p.z >= pk.dive0) race.events.push({ name: 'parkwind', seat: p.seat, phase: 'dive' });
    if (pz < pk.lift0 && p.z >= pk.lift0) race.events.push({ name: 'parkwind', seat: p.seat, phase: 'lift' });
    if (p.z < pk.dive1) {
      if (p.y > pk.cruise) {
        p.y -= pk.diveS * clamp((p.y - pk.cruise) / 5, 0.3, 1) * dt;
        p.pitch = Math.min(p.pitch, 0.05);
        if (p.v < 16) p.v += 3 * dt;
        inDraft = 'down';
      }
    } else if (p.z < pk.lift0) {
      if (p.y > pk.cap) { p.y -= (3 + 4 * (p.y - pk.cap)) * dt; p.pitch = Math.min(p.pitch, 0.1); }
      // warm air off the grass: a gentle cushion that keeps a clean glide going down among the trees
      else if (p.y < pk.cruise) p.y += 2 * clamp((pk.cruise - p.y) / 5, 0, 1) * dt;
      // and the big gust keeps blowing down the park, so nobody stalls out among the trees
      if (p.v < 11.5) p.v += 3 * dt;
    } else if (p.y < pk.liftTop) {
      p.y += pk.liftS * clamp((pk.liftTop - p.y) / 8, 0.35, 1) * dt;
      if (p.v < 17) p.v += 5 * dt;
      p.pitch = Math.max(p.pitch, -0.15);
      inDraft = 'up';
    }
    // Tailwind streams: ride one for a long push (and it holds you up)
    let inS = -1;
    for (let i = 0; i < pk.streams.length; i++) {
      const s = pk.streams[i];
      if (p.z > s.z0 && p.z < s.z1 && Math.abs(p.x - s.x) < s.hw && Math.abs(p.y - s.y) < s.hh) { inS = i; break; }
    }
    if (inS >= 0) {
      const s = pk.streams[inS];
      if (p.v < 24) p.v += s.s * dt;
      p.y += 1.3 * dt;
      p.x += (s.x - p.x) * 0.8 * dt;
      if (p.stream !== inS) race.events.push({ name: 'boost', seat: p.seat, kind: 'stream', amount: 4, x: p.x, y: p.y, z: p.z });
    }
    if (inS >= 0) p.stream = inS;
    // Wind Rider: catch a stream near its start and ride it all the way to the end
    const tr = p.tr;
    if (tr) {
      if (inS >= 0 && (!tr.ride || tr.ride.i !== inS)) tr.ride = { i: inS, ok: p.z - pk.streams[inS].z0 < 8 };
      if (tr.ride && inS !== tr.ride.i) {
        const sr = pk.streams[tr.ride.i];
        if (tr.ride.ok && p.z >= sr.z1 - 1) trick(race, p, 'windride');
        tr.ride = null;
      }
    }
    // Wind rings: thread one for a burst of speed
    for (const g of pk.rings) {
      if (pz < g.z && p.z >= g.z && (p.x - g.x) ** 2 + (p.y - g.y) ** 2 < g.r * g.r) {
        p.v = Math.min(28, Math.max(p.v, 8) + g.s);
        race.events.push({ name: 'boost', seat: p.seat, kind: 'ring', amount: g.s, gold: !!g.off, x: p.x, y: p.y, z: p.z });
        // Hoop Streak: three rings in one flight
        if (p.tr && ++p.tr.rings % 3 === 0) trick(race, p, 'hoops');
      }
    }
  }
  // Donut: a burst of thrust that also holds you up
  // Donut (3 s) and Coffee Cup (5 s): a burst of thrust that also holds you up
  if (buffOn(race, p, 'donut') || buffOn(race, p, 'coffee')) { if (p.v < 27) p.v += 10 * dt; p.y += 0.9 * dt; }
  // Wall vents: a narrow slot in a wall with air rushing through it. Line up and
  // it sucks you in; thread it and the jet on the far side fires you forward.
  for (const wv of f.wallVents || []) {
    const dz = p.z - wv.z;
    if (dz < -8 || dz > 12 || p.duct != null || p.out) continue;
    if (Math.abs(p.x - wv.x) > wv.w / 2 + 1.4 || p.y < wv.y0 - 1.4 || p.y > wv.y1 + 1.4) continue;
    if (dz < 0) { p.x += (wv.x - p.x) * 1.6 * dt; p.y += ((wv.y0 + wv.y1) / 2 - p.y) * 1.6 * dt; }
    // (Needle Dart Mk V: the jet fires you out 10% faster)
    const jet = st.perk.needle ? 1.1 : 1;
    if (p.v < 27 * jet) p.v += (dz < 0 ? 5 : 15) * jet * dt;
    if (pz < wv.z && p.z >= wv.z && Math.abs(p.x - wv.x) < wv.w / 2 && p.y > wv.y0 && p.y < wv.y1) {
      p.v = Math.min(28 * jet, p.v + 5 * jet);
      race.events.push({ name: 'boost', seat: p.seat, kind: 'wallvent', amount: 6, x: p.x, y: p.y, z: p.z });
      trick(race, p, 'duct');
    }
  }
  p.v = Math.min(p.v, 40);
  if (inDraft && !p.inDraft) race.events.push({ name: 'gust', seat: p.seat, dir: inDraft });
  p.inDraft = inDraft;
  for (const b of f.blowers) {
    if (p.x > b.x0 && p.x < b.x1 && p.z > b.z0 && p.z < b.z1 && p.y < b.y1 && p.duct == null && !p.out) {
      p.x += b.dir * b.s * cross * dt;
    }
  }

  if (p.duct != null) { ductStep(race, p, dt); return; }

  // Up through an open ceiling hole into the duct
  // (the duct's suction pulls you in once you're close to the hole)
  if (p.y > f.height - 1.3 && !p.out) {
    const d = (f.ducts || []).findIndex(d => d.kind === 'ceil' && holeAt(d, d.ez, p));
    if (d >= 0) { enterDuct(race, p, d); return; }
  }
  if (f.open && p.y > f.height - SIM.planeR) {
    // Open sky: thin air up here just tips you back down
    p.y = f.height - SIM.planeR; p.pitch = Math.min(p.pitch, -0.1);
  }
  if (p.y > f.height - SIM.planeR) {
    const hitV = p.v * Math.max(0, Math.sin(p.pitch));
    p.y = f.height - SIM.planeR;
    p.pitch = -Math.abs(p.pitch) * 0.6 - 0.1;
    p.v *= 0.85;
    damage(race, p, hitV, 'ceiling');
  }

  // Down through an open floor hole into the duct (outside there is no
  // floor: you've fallen off the building)
  if (p.y < 1.2 && !p.out && p.state === 'fly') {
    const d = (f.ducts || []).findIndex(d => d.kind === 'floor' && holeAt(d, d.ez, p));
    if (d >= 0) { enterDuct(race, p, d); return; }
  }
  if (p.out && p.y < (f.ledge?.sill ?? 4) - 3) { stuckOutside(race, p, 'fell'); return; }
  if (gp && facade(race, p, pz)) return;
  const ground = groundAt(f, p.z);
  if (p.y <= ground + SIM.restH) {
    const vy = p.v * Math.sin(p.pitch);
    touchDown(race, p, ground, vy);
  }
}

// Rooftop: the two buildings' walls facing the gap. Flying into the far
// building below its roofline is a crash; the near one just bounces you.
function facade(race, p, pz) {
  const g = race.floor.gap, r = SIM.planeR;
  if (p.z >= g.z1 - r && pz < g.z1 - r + 0.01 && p.y < -g.drop - 0.05) {
    const vn = Math.abs(p.v * Math.cos(p.yaw));
    p.z = g.z1 - r - 0.01;
    p.yaw = Math.PI - p.yaw;
    p.v *= 0.35;
    if (p.state === 'fly') damage(race, p, vn, 'wall');
    return true;
  }
  if (p.z <= g.z0 + r && pz > g.z0 + r - 0.01 && p.y < -0.05) {
    p.z = g.z0 + r + 0.01;
    p.yaw = Math.PI - p.yaw;
    p.v *= 0.5;
    return true;
  }
  return false;
}

function touchDown(race, p, surfaceY, vy) {
  p.support = surfaceY;
  p.touchVy = vy;
  p.y = surfaceY + SIM.restH;
  if (p.crumpled) { land(race, p); return; }
  // Race mode: no landing. Touching down skims you back up into the air (a
  // hard hit still hurts).
  if (isRaceMode(race) && p.state === 'fly') {
    if (vy < -7) damage(race, p, (-vy - 4) * p.st.landDmg, 'floor');
    if (p.crumpled) { if (p.state !== 'landed') land(race, p); return; }
    p.y = surfaceY + 0.5; p.pitch = Math.max(p.pitch, 0.22); p.v = Math.max(p.v * 0.85, RACE.skimV);
    if (race.t - (p.skimT ?? -9) > 0.6) { p.skimT = race.t; race.events.push({ name: 'skim', seat: p.seat, x: p.x, y: p.y, z: p.z }); }
    return;
  }
  // Eraser Skids Mk V: once per flight, touching down fast off a target skips
  // you back up into the air (landing on a target still lands)
  if (p.st.perk.skids && !p.skimmed && p.state === 'fly' && p.v * Math.cos(p.pitch) > 9 && !zoneAt(race.floor, p.x, p.y, p.z)) {
    p.skimmed = true;
    p.y = surfaceY + 0.4; p.pitch = 0.3; p.v *= 0.85;
    race.events.push({ name: 'perk', seat: p.seat, id: 'skids', x: p.x, y: p.y, z: p.z });
    return;
  }
  p.v = p.v * Math.cos(p.pitch) * 0.72;
  p.pitch = 0; p.roll = 0;
  if (vy < -7) damage(race, p, (-vy - 4) * p.st.landDmg, 'floor');
  if (p.state === 'landed') return;
  p.state = 'slide';
  race.events.push({ name: 'touch', seat: p.seat });
}

function slideStep(race, p, dt) {
  p.v -= (9.5 / p.st.slide) * dt;
  if (p.v <= 0.25) { p.v = 0; land(race, p); return; }
  p.x += Math.sin(p.yaw) * p.v * dt;
  p.z += Math.cos(p.yaw) * p.v * dt;

  // Slid off the edge of a desk (or the roof)
  if (p.support > groundAt(race.floor, p.z) + 0.05 && !supportAt(race.floor, p.x, p.z, p.support)) {
    p.state = 'fly'; p.pitch = -0.6; p.v = Math.max(p.v, 3);
    // Off the Edge: slid off a desk (or the roof) and back into the air
    if (!p.crumpled && p.v > 3) trick(race, p, 'edge');
  }
}

function fallStep(race, p, dt, pz = p.z) {
  // Crumpled ball: no lift, just falls and drifts.
  p.vy = (p.vy ?? 0) - SIM.G * 1.2 * dt;
  p.v *= Math.pow(0.4, dt);
  p.x += Math.sin(p.yaw) * p.v * dt;
  p.z += Math.cos(p.yaw) * p.v * dt;
  p.y += p.vy * dt;
  p.pitch += 6 * dt; p.roll += 4 * dt;
  if (race.floor.gap) facade(race, p, pz);
  const ground = groundAt(race.floor, p.z);
  if (p.y <= ground + SIM.restH + 0.2) { p.y = ground + SIM.restH + 0.2; land(race, p); }
}

function land(race, p) {
  if (isRaceMode(race) && !p.finished) {
    // A race plane only comes down to stop when it's crumpled: the janitor is on the way
    if (p.crumpled) {
      p.state = 'landed'; p.v = 0; p.landedAt = race.t; p.respawnAt = race.t + RACE.respawnS;
      race.events.push({ name: 'landed', seat: p.seat, zone: null, crumpled: true, respawning: true });
      return;
    }
  }
  p.state = 'landed';
  p.v = 0;
  p.landedAt = race.t;
  p.dist = Math.max(0, p.z);
  p.zone = p.crumpled ? null : zoneAt(race.floor, p.x, p.y, p.z);
  // Binder Clip Brake Mk V: the outer ring counts as the inner ring
  if (p.zone && p.st.perk.binder && p.zone.ring === 2) {
    p.zone.ring = 1; p.zone.ringName = RINGS[1].name; p.zone.pay = Math.round(p.zone.base * RINGS[1].mult); p.zone.perk = 'binder';
  }
  race.events.push({ name: 'landed', seat: p.seat, zone: p.zone, crumpled: p.crumpled });
  // Stuck It: come to rest on top of the furniture
  if (!p.crumpled && p.tr && p.y - SIM.restH > groundAt(race.floor, p.z) + 0.5) trick(race, p, 'perch');
  landingTricks(race, p, p.zone);
}

export function zoneAt(floor, x, y, z) {
  let best = null;
  for (const zn of floor.zones) {
    const zy = zn.y || 0;
    if (Math.abs(y - SIM.restH - zy) > 0.6) continue;
    if (x >= zn.x - zn.w / 2 && x <= zn.x + zn.w / 2 && z >= zn.z - zn.d / 2 && z <= zn.z + zn.d / 2) {
      if (!best || zn.tier > best.tier) best = zn;
    }
  }
  if (!best) return null;
  const ring = ringAt(best, x, z);
  return {
    tier: best.tier, label: best.label, ring, ringName: RINGS[ring].name, base: best.pay,
    pay: Math.round(best.pay * RINGS[ring].mult),
    x: best.x, z: best.z, w: best.w, d: best.d, y: best.y || 0, perch: !!best.perch || (best.y || 0) > 0.5, par: best.par,
  };
}

function supportAt(floor, x, z, y) {
  for (const b of floor.boxes) {
    if (Math.abs(b.y1 - y) < 0.05 && x >= b.x0 && x <= b.x1 && z >= b.z0 && z <= b.z1) return true;
  }
  return false;
}

/* ----------------------------------------------------------- shortcuts --- */

// Over (or under) one of a duct's open holes? A little forgiving at the edges.
const holeAt = (d, gz, p) => Math.abs(p.x - d.x) < d.half - 0.1 && Math.abs(p.z - gz) < d.hole;

function enterDuct(race, p, i) {
  const d = race.floor.ducts[i], r = SIM.planeR;
  p.duct = i;
  p.x = clamp(p.x, d.x - d.half + r, d.x + d.half - r);
  p.y = d.kind === 'ceil' ? d.y0 + r + 0.2 : d.y1 - r - 0.2;
  // Level out into the tunnel
  p.pitch = d.kind === 'ceil' ? Math.min(p.pitch, 0.15) : Math.max(p.pitch, -0.15);
  race.events.push({ name: 'ductin', seat: p.seat, x: p.x, y: p.y, z: p.z });
}

function ductStep(race, p, dt) {
  const d = race.floor.ducts[p.duct], r = SIM.planeR;
  const scrape = () => damage(race, p, 4.2, 'scrape');
  // Side walls: tight, and every scrape hurts
  if (Math.abs(p.x - d.x) > d.half - r) {
    p.x = d.x + Math.sign(p.x - d.x) * (d.half - r);
    p.yaw = -p.yaw * 0.6; p.v *= 0.88; scrape();
  }
  const atExit = holeAt(d, d.xz, p), atEntry = holeAt(d, d.ez, p);
  if (d.kind === 'ceil') {
    if (atExit) {
      // Exit hole: the downdraft drops you back into the room
      p.y -= 10 * dt;
      if (p.y < d.y0 - r) return leaveDuct(race, p, true);
    } else if (atEntry && p.y < d.y0 - r) return leaveDuct(race, p, false);   // fell back out
    else if (!atEntry && p.y < d.y0 + r) { p.y = d.y0 + r; p.pitch = Math.max(p.pitch, 0.05); if (p.v * Math.sin(p.pitch) < -2) scrape(); }
    if (p.y > d.y1 - r) { p.y = d.y1 - r; p.pitch = -Math.abs(p.pitch) * 0.5; scrape(); }
  } else {
    if (atExit) {
      // Exit hole: an updraft blows you up and out
      p.y += 20 * dt;
      if (p.y > d.y1 + r) { p.pitch = Math.max(p.pitch, 0.25); return leaveDuct(race, p, true); }
    } else if (atEntry && p.y > d.y1 + r) return leaveDuct(race, p, false);   // climbed back out
    else if (!atEntry && p.y > d.y1 - r) { p.y = d.y1 - r; p.pitch = -Math.abs(p.pitch) * 0.5; scrape(); }
    if (p.y < d.y0 + r) { p.y = d.y0 + r; p.pitch = Math.max(p.pitch, 0.08); if (p.v * Math.sin(-p.pitch) > 2) scrape(); }
  }
  // Closed ends
  if (p.z > d.z1 - r || p.z < d.z0 + r) {
    p.z = Math.max(d.z0 + r, Math.min(d.z1 - r, p.z));
    p.yaw = Math.PI - p.yaw; p.v *= 0.5; damage(race, p, 6, 'hit');
  }
}

function leaveDuct(race, p, made) {
  p.duct = null;
  if (!made) return;
  p.v += 5;
  race.events.push({ name: 'ductout', seat: p.seat, x: p.x, y: p.y, z: p.z });
  trick(race, p, 'duct');
}

function windowAt(f, side, z, y) {
  return (f.windows || []).find(w => w.side === side && Math.abs(z - w.z) < w.half && y > w.y0 && y < w.y1);
}

// Outside the building on the ledge run. Get back in through an open window,
// or you're stuck out here.
function outsideStep(race, p) {
  const f = race.floor, L = f.ledge, r = SIM.planeR, W2 = f.width / 2;
  const side = L.side, out = side * p.x;              // distance from centre on the window side
  if (out < W2 + r) {
    const w = windowAt(f, side, p.z, p.y);
    if (w) {
      p.out = null;
      if (w.id === 'in') { p.v += 5; race.events.push({ name: 'inside', seat: p.seat, x: p.x, y: p.y, z: p.z }); trick(race, p, 'window'); }
      else race.events.push({ name: 'inside', seat: p.seat, x: p.x, y: p.y, z: p.z, back: true });
      return;
    }
    // Smacked the outside of the building
    const vn = Math.abs(p.v * Math.sin(p.yaw));
    p.x = side * (W2 + r);
    p.yaw = -p.yaw; p.v *= 0.7;
    damage(race, p, vn, 'wall');
  }
  // Edge of the ledge run: a wall of wind shoves you back toward the building
  // (no damage). You only get stuck out here by falling, crumpling or
  // flying past the end of the ledge.
  if (out > W2 + L.depth - r) {
    p.x = side * (W2 + L.depth - r);
    if (side * Math.sin(p.yaw) > 0) {
      p.yaw = -p.yaw; p.v *= 0.85;
      race.events.push({ name: 'gust', seat: p.seat, dir: 'side', x: p.x, y: p.y, z: p.z });
    }
  }
  if (p.z < L.z0 - 2 || p.z > L.z1 + 2) return stuckOutside(race, p, 'lost');
  if (p.y > f.height - r) { p.y = f.height - r; p.pitch = -Math.abs(p.pitch) * 0.5; }
}

function stuckOutside(race, p, why) {
  const L = race.floor.ledge, W2 = race.floor.width / 2;
  p.out = null;
  if (!p.crumpled) {
    p.crumpled = true; p.hp = 0;
    if (p.tr) p.tr.chain = 0;
    race.events.push({ name: 'stuck', seat: p.seat, why, x: p.x, y: p.y, z: p.z });
    race.events.push({ name: 'crumple', seat: p.seat, x: p.x, y: p.y, z: p.z });
  }
  // Ends up wedged on the outside ledge
  p.x = L.side * (W2 + 1);
  p.z = Math.max(L.z0, Math.min(L.z1, p.z));
  p.y = L.sill + SIM.restH + 0.2;
  land(race, p);
}

/* ----------------------------------------------------------- collision --- */

// Static furniture plus every moving obstacle where it is right now.
function boxesNow(race) {
  const f = race.floor;
  if (!f.movers?.length) return f.boxes;
  if (race._mbT !== race.t) { race._mb = f.boxes.concat(f.movers.map(m => moverBox(m, race.t))); race._mbT = race.t; }
  return race._mb;
}

function collide(race, p, px, py, pz) {
  const f = race.floor, r = SIM.planeR;
  if (p.state === 'landed') return;
  if (p.duct != null) return;                       // ducts handle their own walls
  if (p.out) { outsideStep(race, p); return; }
  // Side walls and end wall (an open window lets you out onto the ledge)
  const hw = f.width / 2 - r;
  if ((p.x < -hw || p.x > hw) && f.ledge && p.state === 'fly' && !p.crumpled) {
    const w = windowAt(f, p.x > 0 ? 1 : -1, p.z, p.y);
    if (w && w.id === 'out') {
      p.out = { since: race.t };
      // Clear of the wall plane so the next step doesn't count as coming back in
      p.x = (p.x > 0 ? 1 : -1) * (f.width / 2 + r + 0.05);
      race.events.push({ name: 'outside', seat: p.seat, x: p.x, y: p.y, z: p.z });
      return;
    }
  }
  if ((p.x < -hw || p.x > hw) && f.open) {
    // Open sky: a wall of wind at the building's edge turns you back in
    p.x = clamp(p.x, -hw, hw);
    if (Math.sign(Math.sin(p.yaw)) === Math.sign(p.x)) { p.yaw = -p.yaw; p.v *= 0.9; }
  }
  if (p.x < -hw || p.x > hw) {
    const vn = Math.abs(p.v * Math.cos(p.pitch) * Math.sin(p.yaw));
    const away = p.x > 0 ? -1 : 1;
    p.x = clamp(p.x, -hw, hw);
    scrape(race, p, vn, away, 'wall');
  }
  if (p.z > f.length - r && f.open) {
    p.z = f.length - r;
    if (Math.cos(p.yaw) > 0) { p.yaw = Math.PI - p.yaw; p.v *= 0.6; }
  }
  if (p.z > f.length - r) {
    const vn = Math.abs(p.v * Math.cos(p.yaw));
    p.z = f.length - r;
    p.yaw = Math.PI - p.yaw;
    p.v *= 0.35;
    if (p.state === 'fly') damage(race, p, vn, 'wall');
  }
  if (p.z < -4) { p.z = -4; p.yaw = Math.PI - p.yaw; p.v *= 0.4; }

  // Near misses: skimming past something at speed earns a "close call".
  const C = r + 0.9;
  const canClose = p.state === 'fly' && !p.crumpled && p.v > 9 && race.t - (p.lastClose ?? -9) > 1.5 && race.t - (p.lastHit ?? -9) > 0.8;
  let closeTo = null;
  for (const b of boxesNow(race)) {
    if (canClose && !closeTo && p.x > b.x0 - C && p.x < b.x1 + C && p.z > b.z0 - C && p.z < b.z1 + C && p.y > b.y0 - C && p.y < b.y1 + C) closeTo = b;
    if (p.x < b.x0 - r || p.x > b.x1 + r || p.z < b.z0 - r || p.z > b.z1 + r) continue;
    if (p.y < b.y0 - r || p.y > b.y1 + SIM.restH - 0.01) continue;

    if (p.state === 'slide' || (p.state !== 'fly' && p.state !== 'fall')) {
      // Sliding into the side of something: stop dead against it.
      if (p.support >= b.y1 - 0.05) continue;
      p.x = px; p.z = pz; p.v = 0; land(race, p);
      continue;
    }

    if (py >= b.y1 + SIM.restH - 0.05 && !b.mover) {
      // Came down on top: land on the surface.
      const vy = p.state === 'fall' ? (p.vy || 0) : p.v * Math.sin(p.pitch) - 1;
      touchDown(race, p, b.y1, vy);
      continue;
    }
    if (b.mover && py >= b.y1 - 0.2) {
      // Clipped the top of something moving: get knocked upward.
      p.y = b.y1 + r; p.pitch = Math.abs(p.pitch) * 0.5 + 0.1; p.v *= 0.8;
      damage(race, p, 4, 'hit');
      continue;
    }
    if (py <= b.y0 - r + 0.05) {
      p.y = b.y0 - r;
      p.pitch = -Math.abs(p.pitch) - 0.15;
      damage(race, p, 2, 'bump');
      continue;
    }
    const wasOutX = px < b.x0 - r + 0.02 || px > b.x1 + r - 0.02;
    const h = p.v * Math.cos(p.pitch);
    if (b.mover) {
      // Something moving (a cart, a drone, a flock) knocks you aside and slows
      // you, but you keep flying the way you were going. Only walls and
      // furniture turn you around.
      const vn = h * (wasOutX ? Math.abs(Math.sin(p.yaw)) : Math.abs(Math.cos(p.yaw)));
      const lim = f.width / 2 - r - 0.05;
      let side = p.x >= (b.x0 + b.x1) / 2 ? 1 : -1;
      if ((side > 0 ? b.x1 + r + 0.05 : b.x0 - r - 0.05) * side > lim) side = -side;   // no room that way
      const nx = side > 0 ? b.x1 + r + 0.05 : b.x0 - r - 0.05;
      // Staple Nose softens the knock (less turn, speed loss and damage);
      // at Mk V moving things don't slow you at all.
      const kn = p.st.knock;
      if (Math.abs(nx) <= lim) { p.x = nx; p.yaw += side * 0.18 * kn; }
      else p.z = Math.min(pz, b.z0 - r - 0.05);       // wedged against the wall: just held back
      if (!p.st.perk.staple) p.v *= 1 - (1 - Math.min(0.85, 0.6 * p.st.bounce)) * kn;
      if (race.t - (p.moverT ?? -9) > 0.4) { p.moverT = race.t; damage(race, p, 2.5 + (Math.max(vn, 3.5) - 2.5) * kn, 'hit'); }
      if (p.state === 'fall') p.v *= 0.3;
      continue;
    }
    // Walls and furniture don't turn you around any more: you scrape off them,
    // lose speed and take damage, and carry on the way you were heading.
    if (wasOutX) {
      const vn = Math.abs(h * Math.sin(p.yaw));
      p.x = px;
      scrape(race, p, vn, px < b.x0 ? -1 : 1, 'hit');
    } else {
      // Nose first into a face: held back, and nudged toward the nearer edge
      const vn = Math.abs(h * Math.cos(p.yaw));
      p.z = pz - Math.sign(Math.cos(p.yaw) || 1) * 0.05;
      const side = (p.x - b.x0) < (b.x1 - p.x) ? -1 : 1;
      scrape(race, p, vn, side, 'hit', true);
    }
    if (p.state === 'fall') { p.v *= 0.3; }
  }
  // Rooftop park trees: clip a canopy and you bounce off it, scratched and slowed
  if (f.gap?.park && p.state === 'fly' && !p.crumpled && p.z > f.gap.z0 && p.z < f.gap.z1) {
    for (const t of treesNear(f, p.z)) {
      if (!treeHit(t, p.x, p.y, p.z, r)) {
        if (canClose && !closeTo && treeHit(t, p.x, p.y, p.z, C)) closeTo = t;
        continue;
      }
      // Push back out to the surface (canopy, or the trunk below it)
      const cy = t.y + t.h * 0.62, rx = t.r * 0.85 + r, ry = t.r * 0.98 + r;
      let ex = (p.x - t.x) / rx, ey = (p.y - cy) / ry, ez = (p.z - t.z) / rx;
      const el = Math.hypot(ex, ey, ez);
      if (p.y < cy && el >= 1) {
        const hl = Math.hypot(p.x - t.x, p.z - t.z) || 0.01, k = (0.5 + r + 0.02) / hl;
        p.x = t.x + (p.x - t.x) * k; p.z = t.z + (p.z - t.z) * k; ey = 0;
      } else {
        const k = el > 1e-3 ? 1.02 / el : 1;
        if (el <= 1e-3) { ex = 0; ey = 1; ez = 0; }
        p.x = t.x + ex * k * rx; p.y = cy + ey * k * ry; p.z = t.z + ez * k * rx;
      }
      if (race.t - (p.treeT ?? -9) < 0.5) break;      // still scraping the same branches
      p.treeT = race.t;
      const nx = p.x - t.x, nz = p.z - t.z, nl = Math.hypot(nx, nz) || 1;
      const hx = Math.sin(p.yaw), hz = Math.cos(p.yaw);
      const into = -(hx * nx + hz * nz) / nl;          // 1 = flying straight at the trunk
      const h = p.v * Math.cos(p.pitch);
      // glance off it (a full mirror bounce would just fling you into the next tree)
      if (into > 0) p.yaw = Math.atan2(hx + 1.25 * into * nx / nl, hz + 1.25 * into * nz / nl);
      if (ey > 0.6) p.pitch = Math.max(p.pitch, 0.05);
      else if (ey < -0.6) p.pitch = Math.min(p.pitch, -0.15);
      p.v *= Math.min(0.8, 0.55 * p.st.bounce);
      race.events.push({ name: 'tree', seat: p.seat, x: p.x, y: p.y, z: p.z });
      damage(race, p, Math.max(3.6, 0.8 * h * Math.max(into, 0.35)), 'tree');
      break;
    }
  }
  if (closeTo && p.lastHit !== race.t && p.state === 'fly') {
    p.lastClose = race.t;
    race.events.push({ name: 'close', seat: p.seat, x: p.x, y: p.y, z: p.z });
    if (race.t > 1.5) trick(race, p, closeTo.mover ? 'dodge' : 'close');
  }
}

// Scrape off a wall or furniture: keep heading down the floor (angled a touch
// away from what you hit), slow down by how square the hit was, take damage.
// `away` is the side (-1 left / +1 right) to veer toward.
function scrape(race, p, vn, away, kind, headOn = false) {
  const fwd = Math.cos(p.yaw) >= -0.2 ? 1 : -1;
  if (headOn) {
    p.yaw = Math.atan2(Math.sin(p.yaw) + away * 0.45, Math.max(0.5, Math.abs(Math.cos(p.yaw))) * fwd);
    p.v *= Math.min(0.75, 0.45 * p.st.bounce + 0.1);
  } else {
    p.yaw = Math.atan2(away * 0.14, fwd);
    const square = Math.min(1, vn / Math.max(1, p.v));
    // Glossy Photo Paper Mk V: slick enough that a glancing scrape costs no speed
    if (!p.st.perk.glossy) p.v *= Math.max(0.5, 1 - 0.5 * square);
    // Pencil Tip Mk V: glance off and spring forward a little
    if (p.st.perk.pencil && p.state === 'fly' && race.t - (p.scrapeT ?? -9) >= 0.35) p.v = Math.min(26, p.v + 1.5);
  }
  if (race.t - (p.scrapeT ?? -9) < 0.35) return;     // still grinding along the same wall
  p.scrapeT = race.t;
  if (p.state === 'fly') damage(race, p, vn, kind);
}

function damage(race, p, impact, kind) {
  if (p.crumpled) return;
  // Index Card: nothing hurts you (and your trick chain survives) while it lasts
  if (buffOn(race, p, 'card')) return;
  const dmg = Math.max(0, impact - 2.5) * 5.2 * p.st.dmg;
  // Cardstock Mk V: the first real hit of each flight bounces off
  if (dmg > 0 && p.st.perk.cardstock && !p.shrugged && p.state === 'fly') {
    p.shrugged = true;
    race.events.push({ name: 'perk', seat: p.seat, id: 'cardstock', x: p.x, y: p.y, z: p.z });
    return;
  }
  p.lastHit = race.t;
  if (p.tr && p.tr.chain > 1) race.events.push({ name: 'chainbreak', seat: p.seat, chain: p.tr.chain });
  if (p.tr) p.tr.chain = 0;
  if (dmg <= 0) return;
  p.hp = Math.max(0, p.hp - dmg);
  // Packing Tape Mk V: once per race, holds the plane together at 1 durability
  if (p.hp <= 0 && p.st.perk.tape && !p.taped) {
    p.taped = true; p.hp = 1;
    race.events.push({ name: 'perk', seat: p.seat, id: 'tape', x: p.x, y: p.y, z: p.z });
  }
  race.events.push({ name: 'hit', seat: p.seat, dmg: Math.round(dmg), kind, x: p.x, y: p.y, z: p.z });
  if (p.hp <= 0) {
    p.crumpled = true;
    if (p.state === 'fly' || p.state === 'slide') {
      p.state = p.y > groundAt(race.floor, p.z) + SIM.restH + 0.3 ? 'fall' : p.state;
      p.vy = 0;
      if (p.state === 'slide') land(race, p);
    }
    race.events.push({ name: 'crumple', seat: p.seat, x: p.x, y: p.y, z: p.z });
    // Crumpling in a shortcut: wedged in the duct, or stuck on the ledge
    if (p.duct != null && p.state !== 'landed') land(race, p);
    else if (p.out) stuckOutside(race, p, 'crumpled');
  }
}

function pickups(race, p) {
  if (p.state !== 'fly' && p.state !== 'slide') return;
  // Items
  if (!p.crumpled) {
    const items = race.items || [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (!itemReady(race, it)) continue;
      if ((p.x - it.x) ** 2 + (p.y - it.y) ** 2 + (p.z - it.z) ** 2 > ITEM_R * ITEM_R) continue;
      it.takenAt = race.t;
      p.buffs = { ...(p.buffs || {}), [it.kind]: race.t + ITEMS[it.kind].dur * p.st.itemTime };
      // Eraser: rubs out the damage at once
      if (ITEMS[it.kind].heal) p.hp = Math.min(p.maxHp, p.hp + ITEMS[it.kind].heal);
      // Highlighter Mk V: every item also patches the plane up a little
      if (p.st.perk.highlighter) p.hp = Math.min(p.maxHp, p.hp + 15);
      race.events.push({ name: 'item', seat: p.seat, kind: it.kind, i, x: it.x, y: it.y, z: it.z });
    }
  }
  // Glue Bottle: a huge clip magnet for a few seconds
  const R = buffOn(race, p, 'glue') ? GLUE_R : SIM.clipR * p.st.magnet;
  const R2 = R * R;
  for (let i = 0; i < race.clips.length; i++) {
    const c = race.clips[i];
    if (c.taken >= 0) continue;
    const d2 = (p.x - c.x) ** 2 + (p.y - c.y) ** 2 + (p.z - c.z) ** 2;
    if (d2 < R2) {
      c.taken = p.seat;
      // Chip Bag Clip: every clip is worth 2 more while it lasts
      const n = (c.n || 1) + (p.st.clipBonus || 0) + (buffOn(race, p, 'chipclip') ? 2 : 0);
      p.clips += n;
      race.events.push({ name: 'clip', seat: p.seat, i, n });
      // Clip Sweep: five pickups inside 3 s
      if (p.tr) {
        p.tr.clipTimes.push(race.t);
        p.tr.clipTimes = p.tr.clipTimes.filter(x => race.t - x < 3);
        if (p.tr.clipTimes.length >= 5) { p.tr.clipTimes = []; trick(race, p, 'sweep'); }
      }
    }
  }
}

/* ------------------------------------------------------------- results --- */

// Ranking: by score (distance points + target points), then distance flown,
// then who landed first.
export function standings(race) {
  if (isRaceMode(race)) {
    // Race: finish order, then how far along; points by place
    const L = race.floor.length || 800;
    return raceOrder(race).map((p, i) => ({
      seat: p.seat, zone: null, crumpled: false, finished: !!p.finished, dnf: !p.finished,
      dist: Math.round((p.finished ? L : p.maxZ) * 10) / 10, clips: p.clips, landedAt: p.landedAt,
      finishT: p.finished ? Math.round((p.finishedAt - (p.thrownAt ?? 0)) * 10) / 10 : null,
      clean: p.hp >= p.maxHp && p.lastHit == null, tricks: p.tr ? p.tr.list : [], trickClips: p.tr ? p.tr.clips : 0,
      score: { distPts: Math.round(10 * Math.min(1, (p.finished ? L : p.maxZ) / L)), targetPts: 0, total: RACE_PTS[i] ?? 0, parFactor: 0, race: true },
    }));
  }
  return [...race.planes]
    .map(p => ({
      seat: p.seat, zone: p.zone, crumpled: p.crumpled,
      dist: Math.round(p.dist * 10) / 10, clips: p.clips, landedAt: p.landedAt,
      clean: !p.crumpled && p.hp >= p.maxHp, tricks: p.tr ? p.tr.list : [], trickClips: p.tr ? p.tr.clips : 0,
      score: scoreRun(race.floor, p, race.t),
    }))
    .sort((a, b) =>
      (b.score.total - a.score.total) ||
      (b.dist - a.dist) ||
      ((a.landedAt ?? 999) - (b.landedAt ?? 999)));
}

// Compact per-plane snapshot for the wire (phones show HUD info only).
export function snapshot(race) {
  return {
    t: Math.round(race.t * 10) / 10,
    planes: race.planes.map(p => ({
      seat: p.seat, state: p.state, hp: Math.round(p.hp), maxHp: p.maxHp,
      clips: p.clips, z: Math.round(p.z), v: Math.round(p.v),
      crumpled: p.crumpled,
    })),
  };
}
