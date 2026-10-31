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
import { moverBox, ringAt, RINGS } from './floors.js';

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
};

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
  // Planes fly the same on every floor; longer floors just allow longer flights
  // (riding vents) before stragglers are forced down.
  return { floor, timeLimit: SIM.raceTime + (floor.length || 200) / 10, t: 0, planes, clips, events: [], over: false, overAt: null };
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
  p.state = 'fly';
  p.thrownAt = race.t;
  race.events.push({ name: 'throw', seat, power: p.aim.power, boost: p.st.launch > 1 });
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
    if (p.state === 'landed') continue;

    // Out of time: stragglers stuck circling in a vent get dropped.
    if (race.t > race.timeLimit && p.state === 'fly') {
      p.state = 'fall'; p.crumpled = true; p.hp = 0;
      race.events.push({ name: 'timeout', seat: p.seat });
    }

    stepPlane(race, p, dt);
  }

  if (!race.over && race.planes.every(p => p.state === 'landed')) {
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
};
// Chain multiplier per trick in a flight: x1, x1.5, x2, x2.5, x3 (cap).
const chainMult = n => Math.min(3, 1 + 0.5 * (n - 1));
// Repeatable tricks are capped per flight so one floor full of vents can't
// outscore the landing zones.
const PER_FLIGHT = { close: 3, drafts: 2, under: 3 };
function newTricks() { return { list: [], chain: 0, clips: 0, vents: [], under: [], doors: [], hall: null }; }

function trick(race, p, id) {
  const tr = p.tr;
  if (!tr) return;
  const t = TRICKS[id];
  if (PER_FLIGHT[id] && tr.list.filter(x => x.id === id).length >= PER_FLIGHT[id]) return;
  tr.chain = Math.min(5, tr.chain + 1);
  const mult = chainMult(tr.chain);
  const clips = Math.round(t.value * mult);
  tr.clips += clips;
  tr.list.push({ id, label: t.label, value: t.value, mult, clips });
  race.events.push({ name: 'trick', seat: p.seat, id, label: t.label, value: t.value, mult, clips, x: p.x, y: p.y, z: p.z });
}

function flightTricks(race, p, px, py, pz) {
  const tr = p.tr, f = race.floor;
  if (!tr || p.state !== 'fly' || p.crumpled) return;
  // Through a doorway, under the lintel
  (f.doors || []).forEach((d, i) => {
    if (tr.doors.includes(i)) return;
    if (pz < d.z && p.z >= d.z && Math.abs(p.x - d.x) < d.w / 2 && p.y < d.h) { tr.doors.push(i); trick(race, p, 'doorway'); }
  });
  // Under a desk or table (not the launch desk)
  (f.objects || []).forEach((o, i) => {
    if ((o.type !== 'desk' && o.type !== 'table') || o.launch || tr.under.includes(i)) return;
    if (p.y < o.h - 0.6 && Math.abs(p.x - o.x) < o.w / 2 && Math.abs(p.z - o.z) < o.d / 2) { tr.under.push(i); trick(race, p, 'under'); }
  });
  // Riding a second (third...) different vent in one flight
  f.vents.forEach((v, i) => {
    if (tr.vents.includes(i)) return;
    if ((p.x - v.x) ** 2 + (p.z - v.z) ** 2 < v.r * v.r) { tr.vents.push(i); if (tr.vents.length === 2 || tr.vents.length === 4) trick(race, p, 'drafts'); }
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

function landingTricks(race, p, zn) {
  if (!p.tr || p.crumpled || !zn) return;
  if (zn.ring === 0) trick(race, p, 'bullseye');
  if ((zn.y || 0) > 0.5) trick(race, p, 'perch');
  if (p.lastHit != null && race.t - p.lastHit < 3) trick(race, p, 'bank');
  if (p.hp <= p.maxHp * 0.25) trick(race, p, 'clutch');
}

export function stepPlane(race, p, dt) {
  const px = p.x, py = p.y, pz = p.z;
  if (p.state === 'fly') flyStep(race, p, dt);
  else if (p.state === 'slide') slideStep(race, p, dt);
  else if (p.state === 'fall') fallStep(race, p, dt);
  if (p.state === 'landed') return;
  collide(race, p, px, py, pz);
  pickups(race, p);
  flightTricks(race, p, px, py, pz);
  p.maxZ = Math.max(p.maxZ, p.z);
}

function flyStep(race, p, dt) {
  const st = p.st, f = race.floor;

  // Pitch: stick up = climb. A slight nose-down trim keeps a hands-off plane gliding.
  const vStall = SIM.vStall, vRef = SIM.vRef;
  let target = -0.05 + p.inY * 0.55;
  if (p.v < vStall) target = lerp(target, -0.7, clamp((vStall - p.v) / vStall + 0.3, 0, 1));
  p.pitch += (target - p.pitch) * clamp(2.6 * dt, 0, 1);
  p.pitch = clamp(p.pitch, -1.1, 0.9);

  // Bank and turn. Heavier, slower planes turn less; banking costs energy.
  p.roll += (p.inX * 0.85 - p.roll) * clamp(4 * dt, 0, 1);
  const vs = clamp(p.v / vRef, 0.45, 1.3);
  p.yaw += p.roll * 1.25 * st.turn * vs * dt;

  const D = SIM.dragK * st.drag * (0.85 + 0.15 * st.weight) * (1 + p.roll * p.roll * 0.5);
  p.v += (-SIM.G * Math.sin(p.pitch) - D * p.v * p.v) * dt;
  p.v = clamp(p.v, 0.5, 40);

  const sinkRatio = clamp((vRef / Math.max(p.v, 0.5)) ** 2, 0.55, 5 * st.stallDrop);
  const sink = SIM.baseSink * st.sink * Math.pow(st.weight, 0.9) * sinkRatio;

  const h = p.v * Math.cos(p.pitch);
  p.x += Math.sin(p.yaw) * h * dt;
  p.z += Math.cos(p.yaw) * h * dt;
  p.y += (p.v * Math.sin(p.pitch) - sink) * dt;

  // Air currents
  let inDraft = false;
  for (const vnt of f.vents) {
    const d2 = (p.x - vnt.x) ** 2 + (p.z - vnt.z) ** 2;
    if (d2 < vnt.r * vnt.r) {
      const edge = 1 - Math.sqrt(d2) / vnt.r;
      const fall = clamp(1 - p.y / (f.height * 0.95), 0, 1);
      p.y += vnt.s * 1.6 * st.lift * (0.5 + 0.5 * edge) * fall * dt;
      // Drafts also carry you forward: riding one is a speed boost.
      p.v += vnt.s * 0.5 * (0.5 + 0.5 * edge) * dt;
      inDraft = 'up';
    }
  }
  for (const fan of f.fans) {
    const d2 = (p.x - fan.x) ** 2 + (p.z - fan.z) ** 2;
    if (d2 < fan.r * fan.r) {
      const edge = 1 - Math.sqrt(d2) / fan.r;
      p.y -= fan.s * st.wind * (0.4 + 0.6 * edge) * dt;
      // A downdraft costs height but pushes you faster (Nose Clip doesn't blunt this).
      p.v += fan.s * 1.1 * (0.4 + 0.6 * edge) * dt;
      inDraft = 'down';
    }
  }
  p.v = Math.min(p.v, 40);
  if (inDraft && !p.inDraft) race.events.push({ name: 'gust', seat: p.seat, dir: inDraft });
  p.inDraft = inDraft;
  for (const b of f.blowers) {
    if (p.x > b.x0 && p.x < b.x1 && p.z > b.z0 && p.z < b.z1 && p.y < b.y1) {
      p.x += b.dir * b.s * st.wind * dt;
    }
  }

  // Ceiling
  if (p.y > f.height - SIM.planeR) {
    const hitV = p.v * Math.max(0, Math.sin(p.pitch));
    p.y = f.height - SIM.planeR;
    p.pitch = -Math.abs(p.pitch) * 0.6 - 0.1;
    p.v *= 0.85;
    damage(race, p, hitV, 'ceiling');
  }

  // Floor touch-down
  if (p.y <= SIM.restH) {
    const vy = p.v * Math.sin(p.pitch);
    p.y = SIM.restH;
    touchDown(race, p, 0, vy);
  }
}

function touchDown(race, p, surfaceY, vy) {
  p.support = surfaceY;
  p.y = surfaceY + SIM.restH;
  if (p.crumpled) { land(race, p); return; }
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

  // Slid off the edge of a desk
  if (p.support > 0 && !supportAt(race.floor, p.x, p.z, p.support)) {
    p.state = 'fly'; p.pitch = -0.6; p.v = Math.max(p.v, 3);
  }
}

function fallStep(race, p, dt) {
  // Crumpled ball: no lift, just falls and drifts.
  p.vy = (p.vy ?? 0) - SIM.G * 1.2 * dt;
  p.v *= Math.pow(0.4, dt);
  p.x += Math.sin(p.yaw) * p.v * dt;
  p.z += Math.cos(p.yaw) * p.v * dt;
  p.y += p.vy * dt;
  p.pitch += 6 * dt; p.roll += 4 * dt;
  if (p.y <= SIM.restH + 0.2) { p.y = SIM.restH + 0.2; land(race, p); }
}

function land(race, p) {
  p.state = 'landed';
  p.v = 0;
  p.landedAt = race.t;
  p.dist = Math.max(0, p.z);
  p.zone = p.crumpled ? null : zoneAt(race.floor, p.x, p.y, p.z);
  race.events.push({ name: 'landed', seat: p.seat, zone: p.zone, crumpled: p.crumpled });
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
    x: best.x, z: best.z, w: best.w, d: best.d, y: best.y || 0,
  };
}

function supportAt(floor, x, z, y) {
  for (const b of floor.boxes) {
    if (Math.abs(b.y1 - y) < 0.05 && x >= b.x0 && x <= b.x1 && z >= b.z0 && z <= b.z1) return true;
  }
  return false;
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
  // Side walls and end wall
  const hw = f.width / 2 - r;
  if (p.x < -hw || p.x > hw) {
    const vn = Math.abs(p.v * Math.cos(p.pitch) * Math.sin(p.yaw));
    p.x = clamp(p.x, -hw, hw);
    p.yaw = -p.yaw;
    p.v *= 0.6;
    if (p.state === 'fly') damage(race, p, vn, 'wall');
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
    if (wasOutX) {
      const vn = Math.abs(h * Math.sin(p.yaw));
      p.x = px;
      p.yaw = -p.yaw;
      p.v *= Math.min(0.9, 0.55 * p.st.bounce);
      damage(race, p, vn, 'hit');
    } else {
      const vn = Math.abs(h * Math.cos(p.yaw));
      p.z = pz;
      p.yaw = Math.PI - p.yaw;
      p.v *= Math.min(0.8, 0.35 * p.st.bounce);
      damage(race, p, vn, 'hit');
    }
    if (p.state === 'fall') { p.v *= 0.3; }
  }
  if (closeTo && p.lastHit !== race.t && p.state === 'fly') {
    p.lastClose = race.t;
    race.events.push({ name: 'close', seat: p.seat, x: p.x, y: p.y, z: p.z });
    if (race.t > 1.5) trick(race, p, 'close');
  }
}

function damage(race, p, impact, kind) {
  if (p.crumpled) return;
  p.lastHit = race.t;
  if (p.tr && p.tr.chain > 1) race.events.push({ name: 'chainbreak', seat: p.seat, chain: p.tr.chain });
  if (p.tr) p.tr.chain = 0;
  const dmg = Math.max(0, impact - 2.5) * 5.2 * p.st.dmg;
  if (dmg <= 0) return;
  p.hp = Math.max(0, p.hp - dmg);
  race.events.push({ name: 'hit', seat: p.seat, dmg: Math.round(dmg), kind, x: p.x, y: p.y, z: p.z });
  if (p.hp <= 0) {
    p.crumpled = true;
    if (p.state === 'fly' || p.state === 'slide') {
      p.state = p.y > SIM.restH + 0.3 ? 'fall' : p.state;
      p.vy = 0;
      if (p.state === 'slide') land(race, p);
    }
    race.events.push({ name: 'crumple', seat: p.seat, x: p.x, y: p.y, z: p.z });
  }
}

function pickups(race, p) {
  if (p.state !== 'fly' && p.state !== 'slide') return;
  const R = SIM.clipR * p.st.magnet;
  const R2 = R * R;
  for (let i = 0; i < race.clips.length; i++) {
    const c = race.clips[i];
    if (c.taken >= 0) continue;
    const d2 = (p.x - c.x) ** 2 + (p.y - c.y) ** 2 + (p.z - c.z) ** 2;
    if (d2 < R2) {
      c.taken = p.seat;
      const n = (c.n || 1) + (p.st.clipBonus || 0);
      p.clips += n;
      race.events.push({ name: 'clip', seat: p.seat, i, n });
    }
  }
}

/* ------------------------------------------------------------- results --- */

// Ranking: best landing zone first, then distance flown. Crumpled planes rank
// below everyone who landed intact.
export function standings(race) {
  return [...race.planes]
    .map(p => ({
      seat: p.seat, zone: p.zone, crumpled: p.crumpled,
      dist: Math.round(p.dist * 10) / 10, clips: p.clips, landedAt: p.landedAt,
      clean: !p.crumpled && p.hp >= p.maxHp, tricks: p.tr ? p.tr.list : [], trickClips: p.tr ? p.tr.clips : 0,
    }))
    .sort((a, b) =>
      (a.crumpled - b.crumpled) ||
      ((b.zone?.tier ?? -1) - (a.zone?.tier ?? -1)) ||
      ((a.zone?.ring ?? 9) - (b.zone?.ring ?? 9)) ||      // closer to the centre wins
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
