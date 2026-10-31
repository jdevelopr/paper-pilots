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
import { sfx } from './audio.js';

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

    renderer.setFloor(floor);
    renderer.setPlanes(raceSeats.map(seat => ({ seat, owned: match.players[seat].owned })));
    hud.setRace(floor, raceSeats.map(seat => ({ seat, name: nameOf(seat), rank: rankOf(match.players[seat].career).title, best: match.players[seat].best[floor.id] ?? 0 })), `Race ${legOf(match)}/${RACES_PER_FLOOR}`);

    const ms = match.round === 0 ? INTRO_FIRST_MS : INTRO_MS;
    startsAt = Date.now() + ms;
    setPhase('intro');
    broadcastPhase();
    sfx.elevator();
    hud.showIntro({
      floor, round: match.round, rounds: match.floors.length, leg: legOf(match), legs: RACES_PER_FLOOR,
      players: raceSeats.map(seat => ({ seat, name: nameOf(seat), rank: rankOf(match.players[seat].career).title })), startsAt: () => startsAt,
    }, label => (label === 'GO' ? sfx.go() : sfx.tick()));
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
  let acc = 0, meAcc = 0;
  function tick(dt) {
    if (phase === 'race' && race) {
      acc += Math.min(dt, 0.1);
      while (acc >= SIM.dt) {
        for (const [seat, b] of bots) {
          const p = race.planes.find(q => q.seat === seat);
          if (p && p.state === 'fly') { const s = botSteer(b.brain, race, p); steer(race, seat, s.x, s.y); }
        }
        stepRace(race);
        acc -= SIM.dt;
      }
      drainEvents();
      meAcc += dt;
      if (meAcc > 0.12) { meAcc = 0; sendMeAll(); }
      if (race.over && raceOverAt == null) {
        raceOverAt = performance.now();
        later(1600, endRace);
      }
    }
    if (phase === 'shop') hud.shopTimer((startsAt - Date.now()) / 1000);

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
          const s = renderer.project(e.x, e.y, e.z);
          if (s.visible) hud.floater(s.x, s.y, `-${e.dmg}`, 'dmg');
          hud.racerHit(e.seat);
          sendTo(e.seat, 'fx', { kind: 'hit', dmg: e.dmg });
          break;
        }
        case 'clip': {
          sfx.ding();
          const c = race.clips[e.i];
          const s = renderer.project(c.x, c.y, c.z);
          if (s.visible) hud.floater(s.x, s.y, `+${e.n}`);
          renderer.burst(c.x, c.y, c.z, '#c3cad1', 6, 2.5);
          sendTo(e.seat, 'fx', { kind: 'clip', n: e.n });
          break;
        }
        case 'crumple':
          sfx.crumple();
          renderer.burst(e.x, e.y, e.z, col, 22, 5);
          renderer.shake(0.4);
          hud.banner(`${nameOf(e.seat)} crumpled`);
          sendTo(e.seat, 'fx', { kind: 'crumple' });
          break;
        case 'timeout':
          hud.banner(`${nameOf(e.seat)} ran out of air`);
          break;
        case 'touch':
          sfx.land();
          if (p) renderer.burst(p.x, p.y, p.z, '#e9dcbc', 5, 1.5);
          break;
        case 'landed':
          if (e.zone) {
            sfx.zone(e.zone.tier);
            hud.banner(`${nameOf(e.seat)}: ${e.zone.label} +${e.zone.pay}`);
            if (p) renderer.burst(p.x, p.y + 0.3, p.z, colorFor(e.seat), 16, 3.5);
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
  function endRace() {
    const rows = payout(match, standings(race));
    lastRows = rows;
    setPhase('results');
    sfx.fanfare();
    hud.results(rows, layout, isLastRound(match), legOf(match), RACES_PER_FLOOR);
    const promos = rows.filter(r => r.promoted);
    if (promos.length) later(1800, () => { sfx.fanfare(); hud.banner(promos.map(r => `${r.name} promoted to ${r.promoted}`).join(' · '), 3500); });
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
      for (const id of botShop(b.brain, pl.clips, pl.owned)) buy(match, seat, id);
      shopDone.add(seat);
    }
    startsAt = Date.now() + SHOP_MS;
    renderer.setPlanes(raceSeats.map(seat => ({ seat, owned: match.players[seat].owned })));
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
    renderer.setPlanes(raceSeats.map(seat => ({ seat, owned: match.players[seat].owned })));
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
          renderer.setPlanes(raceSeats.map(s => ({ seat: s, owned: match.players[s].owned })));
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
