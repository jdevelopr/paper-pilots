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
import { moverBox } from './floors.js';

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

// Longer floors scale the flight: horizontal distances grow by k = floor.scale
// while ceiling heights stay put, so the glide ratio grows by k. Speeds grow by
// sqrt(k), so a floor twice as long takes ~1.4x as long to cross, not 2x.
const scaleOf = f => f.scale || 1;

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
    };
  });
  const clips = floor.clips.map(c => ({ ...c, taken: -1 }));
  const k = scaleOf(floor);
  return { floor, k, sk: Math.sqrt(k), timeLimit: SIM.raceTime * Math.sqrt(k), t: 0, planes, clips, events: [], over: false, overAt: null };
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
  p.v = SIM.launchMax * race.sk * power * p.st.launch / (0.85 + 0.15 * p.st.weight);
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

export function stepPlane(race, p, dt) {
  const px = p.x, py = p.y, pz = p.z;
  if (p.state === 'fly') flyStep(race, p, dt);
  else if (p.state === 'slide') slideStep(race, p, dt);
  else if (p.state === 'fall') fallStep(race, p, dt);
  if (p.state === 'landed') return;
  collide(race, p, px, py, pz);
  pickups(race, p);
  p.maxZ = Math.max(p.maxZ, p.z);
}

function flyStep(race, p, dt) {
  const st = p.st, f = race.floor;

  // Pitch: stick up = climb. A slight nose-down trim keeps a hands-off plane gliding.
  const k = race.k ?? 1, sk = race.sk ?? 1;
  const vStall = SIM.vStall * sk, vRef = SIM.vRef * sk;
  let target = -0.05 + p.inY * 0.55;
  if (p.v < vStall) target = lerp(target, -0.7, clamp((vStall - p.v) / vStall + 0.3, 0, 1));
  p.pitch += (target - p.pitch) * clamp(2.6 * dt, 0, 1);
  p.pitch = clamp(p.pitch, -1.1, 0.9);

  // Bank and turn. Heavier, slower planes turn less; banking costs energy.
  p.roll += (p.inX * 0.85 - p.roll) * clamp(4 * dt, 0, 1);
  const vs = clamp(p.v / vRef, 0.45, 1.3);
  p.yaw += p.roll * 1.25 * st.turn * vs * sk * dt;

  const D = SIM.dragK / k * st.drag * (0.85 + 0.15 * st.weight) * (1 + p.roll * p.roll * 0.5);
  p.v += (-SIM.G * k * Math.sin(p.pitch) - D * p.v * p.v) * dt;
  p.v = clamp(p.v, 0.5, 40 * sk);

  // The cap scales up with the floor so a stalled plane still drops as fast as
  // on a short floor: you can always dump height to stick a landing.
  const sinkRatio = clamp((vRef / Math.max(p.v, 0.5)) ** 2, 0.55, 5 * sk);
  const sink = SIM.baseSink / sk * st.sink * Math.pow(st.weight, 0.9) * sinkRatio;

  const h = p.v * Math.cos(p.pitch);
  p.x += Math.sin(p.yaw) * h * dt;
  p.z += Math.cos(p.yaw) * h * dt;
  p.y += (p.v * Math.sin(p.pitch) - sink) * dt;

  // Air currents
  for (const vnt of f.vents) {
    const d2 = (p.x - vnt.x) ** 2 + (p.z - vnt.z) ** 2;
    if (d2 < vnt.r * vnt.r) {
      const edge = 1 - Math.sqrt(d2) / vnt.r;
      const fall = clamp(1 - p.y / (f.height * 0.95), 0, 1);
      p.y += vnt.s * 1.6 * (0.5 + 0.5 * edge) * fall * dt;
      p.v += 0.6 * fall * dt;
    }
  }
  for (const fan of f.fans) {
    const d2 = (p.x - fan.x) ** 2 + (p.z - fan.z) ** 2;
    if (d2 < fan.r * fan.r) {
      const edge = 1 - Math.sqrt(d2) / fan.r;
      p.y -= fan.s * st.wind * (0.4 + 0.6 * edge) * dt;
    }
  }
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
  if (vy < -7 * (race.sk ?? 1)) damage(race, p, -vy - 4 * (race.sk ?? 1), 'floor');
  if (p.state === 'landed') return;
  p.state = 'slide';
  race.events.push({ name: 'touch', seat: p.seat });
}

function slideStep(race, p, dt) {
  p.v -= (9.5 * (race.k ?? 1) / p.st.slide) * dt;
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
  return best ? { tier: best.tier, label: best.label, pay: best.pay } : null;
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

  for (const b of boxesNow(race)) {
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
      damage(race, p, 4 * (race.sk ?? 1), 'hit');
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
      p.v *= 0.55;
      damage(race, p, vn, 'hit');
    } else {
      const vn = Math.abs(h * Math.cos(p.yaw));
      p.z = pz;
      p.yaw = Math.PI - p.yaw;
      p.v *= 0.35;
      damage(race, p, vn, 'hit');
    }
    if (p.state === 'fall') { p.v *= 0.3; }
  }
}

function damage(race, p, impact, kind) {
  if (p.crumpled) return;
  impact /= race.sk ?? 1;
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
      p.clips += c.n || 1;
      race.events.push({ name: 'clip', seat: p.seat, i, n: c.n || 1 });
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
    }))
    .sort((a, b) =>
      (a.crumpled - b.crumpled) ||
      ((b.zone?.tier ?? -1) - (a.zone?.tier ?? -1)) ||
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
