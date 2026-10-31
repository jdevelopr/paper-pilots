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
import { moverBox, ringAt, RINGS, groundAt, gapWind } from './floors.js';

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
  window:   { label: 'Window Washer',     value: 8 },
  duct:     { label: 'Duct Rat',          value: 8 },
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
};
// Chain multiplier per trick in a flight: x1, x1.5, x2, x2.5, x3 (cap).
const chainMult = n => Math.min(3, 1 + 0.5 * (n - 1));
// Repeatable tricks are capped per flight so one floor full of vents can't
// outscore the landing zones.
const PER_FLIGHT = { close: 3, drafts: 2, under: 3, circle: 2, ceiling: 2, carpet: 2, zigzag: 2, speed: 1, stall: 2, hang: 1, dodge: 2, sweep: 1, slip: 2 };
function newTricks() {
  return {
    list: [], chain: 0, clips: 0, vents: [], under: [], doors: [], hall: null,
    turn: 0, turnSign: 0, ceilT: 0, lowT: 0, flips: [], rollSign: 0, stalledAt: null, clipTimes: [], behind: {},
  };
}

const TRICK_BOOST_CAP = 26;   // a boost never pushes a plane past this speed

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
  // Afterburner Doodle: mid-flight tricks kick the plane forward. No upgrade, no boost.
  let boost = 0;
  if (p.st.trickBoost > 0 && !p.crumpled && (p.state === 'fly' || p.duct != null || p.out)) {
    boost = Math.max(0, Math.min(p.st.trickBoost, TRICK_BOOST_CAP - p.v));
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
  if (p.v >= 20) trick(race, p, 'speed');

  // Stall Recovery: stall, then dive back up to cruising speed cleanly
  if (p.v < SIM.vStall) tr.stalledAt ??= t;
  else if (tr.stalledAt != null && p.v > 10) {
    if (t - tr.stalledAt < 5 && cleanSince(tr.stalledAt)) trick(race, p, 'stall');
    tr.stalledAt = null;
  }

  // Hang Time: stay airborne about as long as it takes to cross the whole floor
  if (p.thrownAt != null && t - p.thrownAt >= (f.length || 800) / 26) trick(race, p, 'hang');

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
  if (zn.perch) trick(race, p, 'perch');
  if (p.lastHit != null && race.t - p.lastHit < 3) trick(race, p, 'bank');
  if (p.hp <= p.maxHp * 0.25) trick(race, p, 'clutch');
}

export function stepPlane(race, p, dt) {
  const px = p.x, py = p.y, pz = p.z, pyaw = p.yaw;
  if (p.state === 'fly') flyStep(race, p, dt, pz);
  else if (p.state === 'slide') slideStep(race, p, dt);
  else if (p.state === 'fall') fallStep(race, p, dt, pz);
  if (p.state === 'landed') return;
  collide(race, p, px, py, pz);
  pickups(race, p);
  flightTricks(race, p, px, py, pz, dt, pyaw);
  p.maxZ = Math.max(p.maxZ, p.z);
}

function flyStep(race, p, dt, pz = p.z) {
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
    if (d2 < vnt.r * vnt.r && p.duct == null && !p.out) {
      const edge = 1 - Math.sqrt(d2) / vnt.r;
      // (the vent under a ceiling duct's hole keeps pushing all the way up into it)
      const fall = vnt.duct ? 1 : clamp(1 - p.y / (f.height * 0.95), 0, 1);
      p.y += vnt.s * 1.6 * st.lift * (0.5 + 0.5 * edge) * fall * dt;
      // Drafts also carry you forward: riding one is a speed boost.
      p.v += vnt.s * 0.5 * (0.5 + 0.5 * edge) * dt;
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
  if (p.out && f.ledge) { p.x += f.ledge.side * f.ledge.wind * st.wind * dt; p.y += 1.25 * dt; }
  // In a duct: the airflow carries you along
  if (p.duct != null && p.v < 21) p.v += 6 * dt;
  // Out over the gap between the Rooftop's buildings: the crosswind swings you
  // sideways, and below the roofline gusts push you back up. Go deeper than
  // the gusts reach and you're on your own.
  const gp = f.gap;
  if (gp && p.z > gp.z0 && p.z < gp.z1) {
    const w = gapWind(gp, race.t);
    p.x += w.side * gp.cross * st.wind * dt;
    if (p.y < 0) {
      const d = -p.y, reach = clamp((d - 1) / 5, 0, 1) * clamp(1 - (d - 16) / 8, 0, 1);
      const up = 9 * (0.25 + 0.75 * w.up) * reach;
      p.y += up * dt;
      if (up > 3) inDraft = 'up';
    }
  }
  p.v = Math.min(p.v, 40);
  if (inDraft && !p.inDraft) race.events.push({ name: 'gust', seat: p.seat, dir: inDraft });
  p.inDraft = inDraft;
  for (const b of f.blowers) {
    if (p.x > b.x0 && p.x < b.x1 && p.z > b.z0 && p.z < b.z1 && p.y < b.y1 && p.duct == null && !p.out) {
      p.x += b.dir * b.s * st.wind * dt;
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

  // Slid off the edge of a desk (or the roof)
  if (p.support > groundAt(race.floor, p.z) + 0.05 && !supportAt(race.floor, p.x, p.z, p.support)) {
    p.state = 'fly'; p.pitch = -0.6; p.v = Math.max(p.v, 3);
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
    x: best.x, z: best.z, w: best.w, d: best.d, y: best.y || 0, perch: !!best.perch || (best.y || 0) > 0.5,
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
    p.x = clamp(p.x, -hw, hw);
    p.yaw = -p.yaw;
    p.v *= 0.6;
    if (p.state === 'fly') damage(race, p, vn, 'wall');
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
    if (race.t > 1.5) trick(race, p, closeTo.mover ? 'dodge' : 'close');
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
    // Crumpling in a shortcut: wedged in the duct, or stuck on the ledge
    if (p.duct != null && p.state !== 'landed') land(race, p);
    else if (p.out) stuckOutside(race, p, 'crumpled');
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
