// view.js: a player's own 3D view of the race, on their phone or desktop.
// The host runs the one true simulation. Each race it sends the floor theme
// and the random seed, so every screen builds the exact same layout with
// generateFloor, then streams plane positions about 15 times a second. This
// view interpolates between those snapshots and follows the player's plane
// with the same chase camera solo mode uses.

import { createRenderer } from '../host/render3d.js';
import { createHud } from '../host/hud.js';
import { THEMES, generateFloor } from '../game/floors.js';
import { createRace } from '../game/sim.js';
import { colorFor } from '../shared/colors.js';

const STATES = ['held', 'fly', 'slide', 'fall', 'landed'];
const DELAY = 0.12;              // seconds behind the newest snapshot, for smooth interpolation
const lerp = (a, b, k) => a + (b - a) * k;
const lerpAng = (a, b, k) => a + Math.atan2(Math.sin(b - a), Math.cos(b - a)) * k;

export function createPlayerView({ stage, hudRoot, getSeat }) {
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const renderer = createRenderer(stage, { reduceMotion });
  const hud = createHud(hudRoot);
  let race = null, seats = [], phase = 'lobby', introEnd = 0, introLen = 5000;
  let snaps = [];                // [{ at: local seconds, s: snapshot }]
  let clock = 0;                 // local seconds
  let last = performance.now();

  function setLayout(L) {
    const theme = THEMES.find(t => t.id === L.theme);
    if (!theme) return;
    const floor = generateFloor(theme, L.seed);
    seats = L.seats.map(s => s.seat);
    // Same starting positions as the host: build the race the same way
    race = createRace(floor, L.seats.map(s => ({ seat: s.seat, owned: s.owned })));
    race.events = [];
    introLen = L.first ? 6500 : 5000;
    snaps = [];
    renderer.setFloor(floor);
    renderer.setPlanes(L.seats.map(s => ({ seat: s.seat, owned: s.owned, rank: s.rank, stickers: s.stickers || [] })));
    hud.setRace(floor, L.seats.map(s => ({ seat: s.seat, name: s.name })), L.label);
    hud.setMe(getSeat());
    renderer.resize();
  }

  function setPhase(d) {
    phase = d.phase;
    if (phase === 'intro') introEnd = performance.now() + (d.inMs ?? 0);
    document.body.dataset.phase = phase;
  }

  function addSnap(s) {
    snaps.push({ at: clock, s });
    if (snaps.length > 6) snaps.shift();
  }

  // Move the mirror race to the interpolated moment just behind the newest snapshot
  function apply() {
    if (!race || !snaps.length) return;
    const want = clock - DELAY;
    let i = snaps.findIndex(x => x.at >= want);
    if (i < 0) i = snaps.length - 1;
    const B = snaps[i], A = snaps[Math.max(0, i - 1)];
    const k = B.at === A.at ? 1 : Math.max(0, Math.min(1, (want - A.at) / (B.at - A.at)));
    race.t = lerp(A.s.t, B.s.t, k);
    race.timeLimit = B.s.tl;
    race.over = B.s.over;
    for (const pb of B.s.p) {
      const p = race.planes.find(q => q.seat === pb[0]);
      if (!p) continue;
      const pa = A.s.p.find(q => q[0] === pb[0]) || pb;
      p.x = lerp(pa[1], pb[1], k); p.y = lerp(pa[2], pb[2], k); p.z = lerp(pa[3], pb[3], k);
      p.yaw = lerpAng(pa[4], pb[4], k); p.pitch = lerp(pa[5], pb[5], k); p.roll = lerp(pa[6], pb[6], k);
      p.state = STATES[pb[7]]; p.crumpled = !!pb[8]; p.hp = pb[9]; p.maxHp = pb[10]; p.v = pb[11];
      p.aim.yaw = pb[12]; p.aim.pitch = pb[13]; p.aim.power = pb[14];
      p.clips = pb[15]; p.zone = pb[16]; p.duct = pb[17] >= 0 ? pb[17] : null; p.out = pb[18] ? {} : null;
    }
    const taken = new Set(B.s.c);
    race.clips.forEach((c, j) => { c.taken = taken.has(j) ? 1 : -1; });
  }

  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    clock += dt;
    if (race && phase !== 'lobby') {
      apply();
      let view;
      if (phase === 'intro') {
        const left = introEnd - now;
        view = { mode: 'intro', race, introT: 1 - Math.max(0, left - 3000) / (introLen - 3000) };
      } else if (phase === 'shop' || phase === 'final') view = { mode: 'showcase', race, seats };
      else view = { mode: 'race', race, focus: getSeat() };
      renderer.frame(dt, view);
      if (phase === 'race') hud.update(race, renderer.project, null);
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // Feedback for this player's own moments (the host sends these as 'fx')
  function fx(d) {
    const me = race?.planes.find(q => q.seat === getSeat());
    if (!me) return;
    if (d.kind === 'hit') { renderer.shake(Math.min(0.5, (d.dmg || 10) / 50)); renderer.hitPlane(me.seat); }
    if (d.kind === 'clip') {
      renderer.burst(me.x, me.y, me.z, '#c3cad1', 6, 2.5);
      const s = renderer.project(me.x, me.y, me.z);
      if (s.visible) hud.clipFly(s, me.seat, d.n || 1);
    }
    if (d.kind === 'tree') renderer.treeHit(d.x, d.y, d.z);
    if (d.kind === 'trick') {
      const s = renderer.project(me.x, me.y + 1.4, me.z);
      hud.trick(s.visible ? s : null, '', d.label, d.clips, d.mult, colorFor(me.seat));
      renderer.punch(2 + d.mult);
      if (d.boost) { renderer.boost(me.seat, d.boost); renderer.burst(me.x, me.y, me.z, '#f08a2c', 12, 3); }
    }
    if (d.kind === 'boost') { renderer.boost(me.seat, d.amount || 4); renderer.burst(me.x, me.y, me.z, d.ring ? '#8fd0ea' : '#d8ecf4', 10, 3); renderer.punch(d.ring ? 5 : 3); }
    if (d.kind === 'crumple') renderer.shake(0.5);
    if (d.kind === 'throw') renderer.punch(4);
  }

  return { setLayout, setPhase, addSnap, fx, resize: () => renderer.resize() };
}
