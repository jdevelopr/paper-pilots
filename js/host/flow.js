// flow.js: the host's round flow. Owns the match, runs the race simulation,
// talks to phones through `link` (net.js host or the solo local link), and tells
// the renderer and HUD what to show.
//
//   intro -> race -> results -> shop -> intro (next floor) ... -> final

import { createRace, aimPlane, throwPlane, steer, stepRace, standings, SIM } from '../game/sim.js';
import { createMatch, addPlayer, currentFloor, isLastRound, payout, buy, finalStandings, SHOP_MS, legOf, RACES_PER_FLOOR, rankOf } from '../game/rules.js';
import { createBot, botAim, botSteer, botShop, mulberry32 } from '../game/bot.js';
import { generateFloor } from '../game/floors.js';
import { UPGRADES } from '../shared/upgrades.js';
import { colorFor } from '../shared/colors.js';
import { sfx, setWind } from './audio.js';
import { TIER_COLORS } from '../shared/colors.js';

const INTRO_FIRST_MS = 6500;
const INTRO_MS = 5000;
const RESULTS_MS = 7500;
const BOT_NAMES = ['Dot Matrix', 'Ms. Memo', 'Stapler', 'Intern Ivy'];

export function createFlow({ link, renderer, hud, solo = false, botCount = 0, onExit }) {
  let match = null;
  let phase = 'lobby';
  let race = null;
  let layout = null;             // the generated floor for the current race
  let raceSeats = [];
  let bots = new Map();          // seat -> bot brain
  let timers = [];
  let startsAt = 0;              // local ms timestamp for intro end / shop end
  let roundsWanted = 5;
  let shopDone = new Set();
  let lastRows = null, finalRows = null;
  let raceOverAt = null;
  const rng = mulberry32((Date.now() ^ 0x5eed) >>> 0);

  const later = (ms, fn) => { const t = setTimeout(fn, ms); timers.push(t); return t; };
  const clearTimers = () => { timers.forEach(clearTimeout); timers = []; };

  const humans = () => link.players.map(p => ({ seat: p.seat, name: p.name, connected: p.connected }));
  const nameOf = seat => match?.players[seat]?.name ?? '?';
  const sendTo = (seat, name, data) => link.sendTo(seat, { t: 'event', name, data });
  const broadcast = (name, data) => link.event(name, data);

  function setPhase(p) { phase = p; link.setPhase(p); }

  /* ---------------------------------------------------------- start --- */
  function start(rounds = 5) {
    clearTimers();
    roundsWanted = rounds;
    match = createMatch(rounds);
    bots = new Map();
    for (const h of humans()) addPlayer(match, h.seat, h.name);
    for (let i = 0; i < botCount; i++) {
      const seat = 1 + i;
      addPlayer(match, seat, BOT_NAMES[i], true);
      bots.set(seat, { skill: [0.55, 0.75, 0.9, 0.65][i] });
    }
    startRound();
  }

  function startRound() {
    clearTimers();
    // Anyone who joined since the last round gets a seat at the table now.
    for (const h of humans()) addPlayer(match, h.seat, h.name);
    // Every race gets a freshly generated layout of this floor's theme.
    const floor = layout = generateFloor(currentFloor(match), (rng() * 2 ** 31) >>> 0);
    raceSeats = Object.keys(match.players).map(Number).sort((a, b) => a - b);
    race = createRace(floor, raceSeats.map(seat => ({ seat, owned: match.players[seat].owned })));
    for (const [seat, b] of bots) b.brain = createBot(seat, b.skill, rng);
    raceOverAt = null;
    rec = []; recT = -1; hitStop = 0; photo = null;

    renderer.setFloor(floor);
    renderer.setPlanes(raceSeats.map(seat => ({ seat, owned: match.players[seat].owned, rank: rankOf(match.players[seat].career).level })));
    hud.setRace(floor, raceSeats.map(seat => ({ seat, name: nameOf(seat), rank: rankOf(match.players[seat].career).title, best: match.players[seat].best[floor.id] ?? 0 })), `Race ${legOf(match)}/${RACES_PER_FLOOR}`);

    const ms = match.round === 0 ? INTRO_FIRST_MS : INTRO_MS;
    startsAt = Date.now() + ms;
    setPhase('intro');
    broadcastPhase();
    sfx.elevator();
    hud.showIntro({
      floor, round: match.round, rounds: match.floors.length, leg: legOf(match), legs: RACES_PER_FLOOR,
      players: raceSeats.map(seat => ({ seat, name: nameOf(seat), rank: rankOf(match.players[seat].career).title })), startsAt: () => startsAt,
    }, label => {
      if (label === 'GO') { sfx.go(); hud.flash('go'); renderer.punch(10); renderer.shake(0.25); }
      else sfx.tick();
    });
    hud.setHint(match.round > 0 ? 'Enter to skip' : '');
    scheduleGo();
    sendMeAll();
  }

  let goTimer = null;
  function scheduleGo() {
    clearTimeout(goTimer);
    goTimer = later(Math.max(0, startsAt - Date.now()), beginRace);
  }

  function skip() {
    if (phase === 'intro' && match.round > 0 && startsAt - Date.now() > 3100) {
      startsAt = Date.now() + 3000;
      broadcastPhase();
      scheduleGo();
    } else if (phase === 'results') {
      clearTimers(); afterResults();
    }
  }

  function beginRace() {
    setPhase('race');
    hud.showRace();
    hud.setHint('');
    broadcastPhase();
    // Bots wind up and throw after a short human-looking delay
    for (const [seat, b] of bots) {
      later(b.brain.throwAt * 1000, () => {
        if (phase !== 'race') return;
        const p = race.planes.find(q => q.seat === seat);
        const aim = botAim(b.brain, race.floor, p);
        aimPlane(race, seat, aim);
        later(500, () => phase === 'race' && throwPlane(race, seat, aim));
      });
    }
  }

  /* ------------------------------------------------------------ tick --- */
  let acc = 0, meAcc = 0, hitStop = 0;
  // Recent race history for the photo-finish replay (30 snapshots a second)
  let rec = [], recT = -1;
  function record() {
    if (race.t - recT < 1 / 30) return;
    recT = race.t;
    rec.push({ t: race.t, p: race.planes.map(q => [q.x, q.y, q.z, q.yaw, q.pitch, q.roll, q.state, q.crumpled, q.hp]) });
    if (rec.length > 30 * 30) rec.shift();
  }
  function ghostAt(t) {
    // Interpolate the recording at time t into a race-shaped object for the renderer
    let i = rec.findIndex(f => f.t >= t);
    if (i < 0) i = rec.length - 1;
    const b = rec[i], a = rec[Math.max(0, i - 1)];
    const k = b.t === a.t ? 1 : Math.max(0, Math.min(1, (t - a.t) / (b.t - a.t)));
    const L = (u, v) => u + (v - u) * k;
    return {
      ...race, t,
      planes: race.planes.map((q, j) => {
        const A = a.p[j], B = b.p[j];
        return { ...q, x: L(A[0], B[0]), y: L(A[1], B[1]), z: L(A[2], B[2]), yaw: L(A[3], B[3]), pitch: L(A[4], B[4]), roll: L(A[5], B[5]), state: B[6], crumpled: B[7], v: 12 };
      }),
    };
  }
  let photo = null;
  // Announce lead changes, but not every time two planes swap noses mid-air
  let lastLeadCall = 0;
  hud.setLeadChange(seat => {
    if (phase !== 'race' || race.t - lastLeadCall < 3 || race.t < 2) return;
    lastLeadCall = race.t;
    hud.banner(`${nameOf(seat)} takes the lead`, 1400);
  });

  function tick(dt) {
    if (phase === 'race' && race && hitStop > 0) { hitStop -= dt; dt *= 0.05; }
    if (phase === 'race' && race) {
      acc += Math.min(dt, 0.1);
      while (acc >= SIM.dt) {
        for (const [seat, b] of bots) {
          const p = race.planes.find(q => q.seat === seat);
          if (p && p.state === 'fly') { const s = botSteer(b.brain, race, p); steer(race, seat, s.x, s.y); }
        }
        stepRace(race);
        record();
        acc -= SIM.dt;
      }
      drainEvents();
      // Wind rises with the fastest plane in the air (yours, in solo)
      const flying = race.planes.filter(q => q.state === 'fly' && (!solo || q.seat === 0));
      setWind(flying.length ? (Math.max(...flying.map(q => q.v)) - 6) / 18 : 0);
      meAcc += dt;
      if (meAcc > 0.12) { meAcc = 0; sendMeAll(); }
      if (race.over && raceOverAt == null) {
        raceOverAt = performance.now();
        setWind(0);
        later(1600, finishRace);
      }
    }
    if (phase === 'shop') hud.shopTimer((startsAt - Date.now()) / 1000);

    if (phase === 'photo' && photo) {
      photo.clock = Math.min(photo.end, photo.clock + dt * photo.speed);
      renderer.frame(dt, { mode: 'photo', race: ghostAt(photo.clock), pair: photo.pair });
      if (photo.clock >= photo.end && !photo.revealed) {
        photo.revealed = true;
        sfx.shutter();
        renderer.setSepia(1);
        hud.photoReveal(photo.a, photo.b, photo.margin);
        later(2600, () => { renderer.setSepia(0); hud.photoEnd(); photo = null; endRace(); });
      }
      return;
    }

    const view = phase === 'intro'
      ? { mode: 'intro', race, introT: 1 - Math.max(0, (startsAt - Date.now() - 3000)) / ((match.round === 0 ? INTRO_FIRST_MS : INTRO_MS) - 3000) }
      : phase === 'shop' || phase === 'final'
        ? { mode: 'showcase', race, seats: raceSeats }
        : { mode: 'race', race, focus: solo ? 0 : null };
    if (phase !== 'lobby') {
      renderer.frame(dt, view);
      if (phase === 'race') hud.update(race, renderer.project, Object.fromEntries(humans().map(h => [h.seat, h])));
    }
  }

  function drainEvents() {
    for (const e of race.events.splice(0)) {
      const p = race.planes.find(q => q.seat === e.seat);
      const col = colorFor(e.seat);
      switch (e.name) {
        case 'throw':
          sfx.throw(e.boost);
          sendTo(e.seat, 'fx', { kind: 'throw' });
          break;
        case 'hit': {
          sfx.thud();
          renderer.shake(Math.min(0.5, e.dmg / 50));
          renderer.burst(e.x, e.y, e.z, col, 10, 4);
          renderer.hitPlane(e.seat);
          // Hit-stop: a big smack freezes the action for a beat
          if (e.dmg >= 15) { hitStop = Math.min(0.12, 0.04 + e.dmg / 400); renderer.punch(-4); }
          if (e.dmg >= 25 && (!solo || e.seat === 0)) hud.flash('hit');
          const s = renderer.project(e.x, e.y, e.z);
          if (s.visible) hud.floater(s.x, s.y, `-${e.dmg}`, 'dmg');
          hud.racerHit(e.seat);
          sendTo(e.seat, 'fx', { kind: 'hit', dmg: e.dmg });
          break;
        }
        case 'clip': {
          const chain = hud.combo(e.seat, race.t);
          sfx.ding(chain);
          const c = race.clips[e.i];
          const s = renderer.project(c.x, c.y, c.z);
          if (s.visible) hud.floater(s.x, s.y, chain > 1 ? `+${e.n}  x${chain}` : `+${e.n}`, chain > 2 ? 'combo big' : chain > 1 ? 'combo' : '');
          renderer.burst(c.x, c.y, c.z, '#c3cad1', 6 + chain * 2, 2.5 + chain * 0.4);
          if (c.big) { renderer.confetti(c.x, c.y, c.z, ['#c3cad1', '#e0a526', '#f6efdc'], 24); renderer.punch(3); }
          sendTo(e.seat, 'fx', { kind: 'clip', n: e.n, chain });
          break;
        }
        case 'crumple':
          sfx.crumple();
          renderer.burst(e.x, e.y, e.z, col, 34, 6);
          renderer.shake(0.5);
          hitStop = 0.15;
          hud.banner(`${nameOf(e.seat)} crumpled`);
          sendTo(e.seat, 'fx', { kind: 'crumple' });
          break;
        case 'timeout':
          hud.banner(`${nameOf(e.seat)} ran out of air`);
          break;
        case 'gust':
          sfx.gust(e.dir);
          if (p) renderer.gust(p.x, p.y, p.z, e.dir);
          if (!solo || e.seat === 0) renderer.punch(e.dir === 'down' ? 5 : 3);
          sendTo(e.seat, 'fx', { kind: 'gust' });
          break;
        case 'touch':
          sfx.land();
          if (p) renderer.burst(p.x, p.y, p.z, '#e9dcbc', 9, 2);
          break;
        case 'close': {
          if (race.t < 1.5) break;
          sfx.close();
          const s = renderer.project(e.x, e.y + 1, e.z);
          if (s.visible) hud.floater(s.x, s.y, 'Close call!', 'close');
          if (!solo || e.seat === 0) renderer.punch(4);
          sendTo(e.seat, 'fx', { kind: 'close' });
          break;
        }
        case 'landed':
          if (e.zone) {
            sfx.zone(e.zone.tier);
            hud.banner(`${nameOf(e.seat)}: ${e.zone.label} +${e.zone.pay}`);
            if (p) {
              // Bigger party for farther zones
              renderer.confetti(p.x, p.y + 0.3, p.z, [colorFor(e.seat), TIER_COLORS[e.zone.tier], '#f6efdc'], 16 + e.zone.tier * 10);
              renderer.ring(p.x, p.y - 0.1, p.z, TIER_COLORS[e.zone.tier], 4 + e.zone.tier * 2);
              if (e.zone.tier >= 3) { renderer.shake(0.3); renderer.punch(6); }
              const s = renderer.project(p.x, p.y + 1.5, p.z);
              if (s.visible) hud.floater(s.x, s.y, `+${e.zone.pay}`, e.zone.tier >= 3 ? 'combo big' : 'combo');
            }
          }
          sendTo(e.seat, 'landed', { zone: e.zone, crumpled: e.crumpled });
          break;
      }
    }
  }

  function sendMeAll() {
    if (!match) return;
    for (const h of humans()) {
      const pl = match.players[h.seat];
      if (!pl) continue;
      const p = race?.planes.find(q => q.seat === h.seat);
      sendTo(h.seat, 'me', {
        seat: h.seat, name: pl.name, clips: pl.clips, points: pl.points, owned: pl.owned,
        state: p?.state ?? 'none', hp: p ? Math.round(p.hp) : 0, maxHp: p?.maxHp ?? 100,
        run: p?.clips ?? 0, crumpled: !!p?.crumpled, zone: p?.zone ?? null,
        dist: p ? Math.round(p.z) : 0, best: Math.round(pl.best[currentFloor(match).id] ?? 0),
        rank: rankOf(pl.career),
      });
    }
  }

  function broadcastPhase() {
    const f = layout || currentFloor(match);
    const next = match.floors[match.round + 1];
    broadcast('phase', {
      phase, round: match.round, rounds: match.floors.length, leg: legOf(match), legs: RACES_PER_FLOOR,
      floor: { number: f.number, name: f.name, stakes: f.stakes },
      next: next ? { number: next.number, name: next.name, leg: legOf(match, match.round + 1) } : null,
      inMs: Math.max(0, startsAt - Date.now()),
      players: raceSeats.map(seat => ({ seat, name: nameOf(seat) })),
      rows: phase === 'results' ? lastRows : phase === 'final' ? finalRows : null,
      upgrades: phase === 'shop' ? UPGRADES.map(u => ({ id: u.id })) : null,
    });
  }

  /* --------------------------------------------------------- results --- */
  // Close finish between the top two? Replay it in slow motion first.
  function finishRace() {
    const st = standings(race);
    const [a, b] = st;
    const close = a && b && !a.crumpled && !b.crumpled && a.zone && b.zone &&
      a.zone.tier === b.zone.tier && Math.abs(a.dist - b.dist) < 8 && rec.length > 30;
    if (!close) return endRace();
    const land = Math.max(a.landedAt ?? race.t, b.landedAt ?? race.t);
    const start = Math.max(rec[0].t, land - 2.4);
    photo = {
      pair: [a.seat, b.seat], clock: start, end: Math.min(rec[rec.length - 1].t, land + 0.5), speed: 0.4,
      a: { seat: a.seat, name: nameOf(a.seat) }, b: { seat: b.seat, name: nameOf(b.seat) }, margin: Math.abs(a.dist - b.dist),
    };
    setPhase('photo');
    broadcastPhase();
    hud.photoStart(photo.a, photo.b);
    sfx.drumroll((photo.end - photo.clock) / photo.speed);
    renderer.setSepia(0.35);
  }

  function endRace() {
    const rows = payout(match, standings(race));
    lastRows = rows;
    setPhase('results');
    sfx.fanfare();
    hud.results(rows, layout, isLastRound(match), legOf(match), RACES_PER_FLOOR);
    const promos = rows.filter(r => r.promoted);
    if (promos.length) later(1800, () => { sfx.fanfare(); hud.banner(promos.map(r => `${r.name} promoted to ${r.promoted}`).join(' · '), 3500);
      if (promos.length === 1) later(3600, () => hud.banner(promos[0].unlock, 3000)); });
    hud.setHint('Enter to skip');
    broadcastPhase();
    sendMeAll();
    later(RESULTS_MS, afterResults);
  }

  function afterResults() {
    if (isLastRound(match)) return showFinal();
    openShop();
  }

  /* ------------------------------------------------------------ shop --- */
  function openShop() {
    setPhase('shop');
    shopDone = new Set();
    for (const [seat, b] of bots) {
      const pl = match.players[seat];
      for (const id of botShop(b.brain, pl.clips, pl.owned, rankOf(pl.career).level)) buy(match, seat, id);
      shopDone.add(seat);
    }
    startsAt = Date.now() + SHOP_MS;
    renderer.setPlanes(raceSeats.map(seat => ({ seat, owned: match.players[seat].owned, rank: rankOf(match.players[seat].career).level })));
    hud.setHint('');
    renderShop();
    broadcastPhase();
    sendMeAll();
    later(SHOP_MS, nextRound);
  }

  function renderShop() {
    const next = match.floors[match.round + 1];
    hud.shop({
      next, nextLeg: legOf(match, match.round + 1), legs: RACES_PER_FLOOR,
      players: raceSeats.map(seat => {
        const pl = match.players[seat];
        return { seat, name: pl.name, clips: pl.clips, owned: pl.owned, done: shopDone.has(seat) };
      }),
    });
  }

  function checkShopDone() {
    const live = humans().filter(h => h.connected && match.players[h.seat]);
    if (live.every(h => shopDone.has(h.seat))) { clearTimers(); later(700, nextRound); }
  }

  function nextRound() {
    if (phase !== 'shop') return;
    match.round++;
    startRound();
  }

  /* ----------------------------------------------------------- final --- */
  function showFinal() {
    finalRows = finalStandings(match);
    setPhase('final');
    sfx.fanfare();
    hud.setHint('');
    renderer.setPlanes(raceSeats.map(seat => ({ seat, owned: match.players[seat].owned, rank: rankOf(match.players[seat].career).level })));
    hud.final(finalRows, {
      soloMenu: solo,
      onAgain: () => { if (solo) start(roundsWanted); else onExit?.('lobby'); },
      onMenu: () => onExit?.('menu'),
    });
    broadcastPhase();
  }

  /* ---------------------------------------------------------- inputs --- */
  function onInput(seat, m) {
    if (!m || typeof m !== 'object' || !match) return;
    if (phase === 'race' && race) {
      if (m.k === 'aim') aimPlane(race, seat, m);
      else if (m.k === 'throw') throwPlane(race, seat, m);
      else if (m.k === 'stick') steer(race, seat, m.x, m.y);
    } else if (phase === 'shop') {
      if (m.k === 'buy') {
        const r = buy(match, seat, String(m.id));
        if (r.ok) {
          sfx.buy();
          sendTo(seat, 'fx', { kind: 'bought', id: m.id });
          renderer.setPlanes(raceSeats.map(s => ({ seat: s, owned: match.players[s].owned, rank: rankOf(match.players[s].career).level })));
        } else sendTo(seat, 'fx', { kind: 'nope', reason: r.reason });
        renderShop();
        sendMeAll();
      } else if (m.k === 'done') {
        shopDone.add(seat);
        renderShop();
        checkShopDone();
      } else if (m.k === 'undone') {
        shopDone.delete(seat);
        renderShop();
      }
    }
  }

  // A phone that reconnects mid-game gets the current phase and its own state.
  function onHello(seat) {
    if (!match || phase === 'lobby') return;
    broadcastPhase();
    sendMeAll();
    if (phase === 'shop') renderShop();
  }

  function stop() { clearTimers(); setPhase('lobby'); broadcast('phase', { phase: 'lobby' }); }

  return { start, tick, onInput, onHello, skip, stop, get phase() { return phase; } };
}
