// flow.js: the host's round flow. Owns the match, runs the race simulation,
// talks to phones through `link` (net.js host or the solo local link), and tells
// the renderer and HUD what to show.
//
//   intro -> race -> results -> shop -> intro (next floor) ... -> final

import { createRace, aimPlane, throwPlane, steer, stepRace, standings, SIM, ITEMS, itemReady } from '../game/sim.js';
import { createMatch, addPlayer, currentFloor, isLastRound, payout, buy, equip, finalStandings, SHOP_MS, legOf, rankOf } from '../game/rules.js';
import { createBot, botAim, botSteer, botShop, mulberry32 } from '../game/bot.js';
import { generateFloor } from '../game/floors.js';
import { UPGRADES } from '../shared/upgrades.js';
import { colorFor } from '../shared/colors.js';
import { sfx, setWind } from './audio.js';
import { TIER_COLORS } from '../shared/colors.js';
import { cleanPlaced, randomStickers } from '../shared/stickers.js';

const INTRO_FIRST_MS = 6500;
const INTRO_MS = 5000;
const RESULTS_MS = 7500;
const BOT_NAMES = ['Dot Matrix', 'Ms. Memo', 'Stapler', 'Intern Ivy'];

export function createFlow({ link, renderer, hud, solo = false, botCount = 0, onExit, stickers = new Map() }) {
  let match = null;
  let phase = 'lobby';
  let race = null;
  let layout = null;             // the generated floor for the current race
  let raceSeats = [];
  let bots = new Map();          // seat -> bot brain
  let timers = [];
  let startsAt = 0;              // local ms timestamp for intro end / shop end
  let setupWanted = {};
  let shopDone = new Set();
  let lastRows = null, finalRows = null;
  let raceOverAt = null;
  const rng = mulberry32((Date.now() ^ 0x5eed) >>> 0);
  // Stickers each player has stuck on their plane (cosmetic; sent by their device)
  const stickersBy = stickers;
  // What each pilot did this race, for their sticker book
  let raceStats = new Map();
  const bump = (seat, k, n = 1) => { const st = raceStats.get(seat) || {}; st[k] = (st[k] || 0) + n; raceStats.set(seat, st); };

  const later = (ms, fn) => { const t = setTimeout(fn, ms); timers.push(t); return t; };
  const clearTimers = () => { timers.forEach(clearTimeout); timers = []; };

  const humans = () => link.players.map(p => ({ seat: p.seat, name: p.name, connected: p.connected }));
  const nameOf = seat => match?.players[seat]?.name ?? '?';
  const sendTo = (seat, name, data) => link.sendTo(seat, { t: 'event', name, data });
  const broadcast = (name, data) => link.event(name, data);

  function setPhase(p) { phase = p; link.setPhase(p); }

  const planeLooks = () => raceSeats.map(seat => ({ seat, owned: match.players[seat].owned, rank: rankOf(match.players[seat].career).level, stickers: stickersBy.get(seat) || [] }));

  /* ---------------------------------------------------------- start --- */
  function start(setup = {}) {
    clearTimers();
    setupWanted = setup;
    renderer.setPodium(null);
    match = createMatch(setup);
    bots = new Map();
    for (const h of humans()) addPlayer(match, h.seat, h.name);
    for (let i = 0; i < botCount; i++) {
      const seat = 1 + i;
      addPlayer(match, seat, BOT_NAMES[i], true);
      bots.set(seat, { skill: [0.55, 0.75, 0.9, 0.65][i] });
      stickersBy.set(seat, randomStickers(rng, 2 + Math.floor(rng() * 3)));
    }
    startRound();
  }

  function startRound() {
    clearTimers();
    // Anyone who joined since the last round gets a seat at the table now.
    for (const h of humans()) addPlayer(match, h.seat, h.name);
    // Every race gets a freshly generated layout of this floor's theme.
    const seed = (rng() * 2 ** 31) >>> 0;
    const floor = layout = generateFloor(currentFloor(match), seed);
    raceSeats = Object.keys(match.players).map(Number).sort((a, b) => a - b);
    race = createRace(floor, raceSeats.map(seat => ({ seat, owned: match.players[seat].owned })));
    for (const [seat, b] of bots) b.brain = createBot(seat, b.skill, rng);
    raceOverAt = null;
    hitStop = 0;
    raceStats = new Map();

    renderer.setFloor(floor);
    renderer.setPlanes(planeLooks());
    if (solo) hud.setMe(0);
    // Every player's own screen builds the exact same layout from the same seed
    lastLayout = {
      theme: floor.id, seed, label: `Race ${legOf(match)}/${match.racesPerFloor}`, first: match.round === 0,
      seats: raceSeats.map(seat => ({ seat, name: nameOf(seat), owned: match.players[seat].owned, rank: rankOf(match.players[seat].career).level, stickers: stickersBy.get(seat) || [] })),
    };
    if (!solo) broadcast('layout', lastLayout);
    hud.setRace(floor, raceSeats.map(seat => ({ seat, name: nameOf(seat), rank: rankOf(match.players[seat].career).title, best: match.players[seat].best[floor.id] ?? 0 })), `Race ${legOf(match)}/${match.racesPerFloor}`);

    const ms = match.round === 0 ? INTRO_FIRST_MS : INTRO_MS;
    startsAt = Date.now() + ms;
    setPhase('intro');
    broadcastPhase();
    sfx.elevator();
    hud.showIntro({
      floor, round: match.round, rounds: match.floors.length, leg: legOf(match), legs: match.racesPerFloor,
      players: raceSeats.map(seat => ({ seat, name: nameOf(seat), rank: rankOf(match.players[seat].career).title })), startsAt: () => startsAt,
    }, label => {
      if (label === 'GO!') { sfx.go(); hud.flash('go'); renderer.punch(10); renderer.shake(0.25); }
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
  let acc = 0, meAcc = 0, snapAcc = 0, hitStop = 0, lastLayout = null;
  // Race state for the players' own 3D views (15 a second; they interpolate)
  const r2 = v => Math.round(v * 100) / 100;
  const STATES = ['held', 'fly', 'slide', 'fall', 'landed'];
  function snapshot() {
    return {
      t: r2(race.t), tl: race.timeLimit, over: race.over,
      p: race.planes.map(q => [q.seat, r2(q.x), r2(q.y), r2(q.z), r2(q.yaw), r2(q.pitch), r2(q.roll), STATES.indexOf(q.state), q.crumpled ? 1 : 0,
        Math.round(q.hp), q.maxHp, r2(q.v), r2(q.aim.yaw), r2(q.aim.pitch), r2(q.aim.power), q.clips,
        q.zone ? { label: q.zone.label, pay: q.zone.pay, tier: q.zone.tier, ring: q.zone.ring, par: q.zone.par } : null, q.duct ?? -1, q.out ? 1 : 0,
        q.thrownAt == null ? -1 : r2(q.thrownAt), r2(q.fatigue || 0), q.landedAt == null ? -1 : r2(q.landedAt),
        Object.keys(ITEMS).map(k => Math.max(0, r2((q.buffs?.[k] ?? 0) - race.t)))]),
      c: race.clips.reduce((a, c, i) => (c.taken >= 0 && a.push(i), a), []),
      it: race.items.reduce((a, it, i) => (!itemReady(race, it) && a.push(i), a), []),
    };
  }
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
        acc -= SIM.dt;
      }
      drainEvents();
      // Wind rises with the fastest plane in the air (yours, in solo)
      const flying = race.planes.filter(q => q.state === 'fly' && (!solo || q.seat === 0));
      setWind(flying.length ? (Math.max(...flying.map(q => q.v)) - 6) / 18 : 0);
      meAcc += dt;
      if (meAcc > 0.12) { meAcc = 0; sendMeAll(); }
      snapAcc += dt;
      if (!solo && snapAcc > 1 / 15) { snapAcc = 0; broadcast('snap', snapshot()); }
      if (race.over && raceOverAt == null) {
        raceOverAt = performance.now();
        setWind(0);
        later(1600, endRace);
      }
    }
    if (phase === 'shop') hud.shopTimer((startsAt - Date.now()) / 1000);

    const view = phase === 'intro'
      ? { mode: 'intro', race, introT: 1 - Math.max(0, (startsAt - Date.now() - 3000)) / ((match.round === 0 ? INTRO_FIRST_MS : INTRO_MS) - 3000) }
      : phase === 'final'
        ? { mode: 'podium' }
      : phase === 'shop'
        ? { mode: 'showcase', race, seats: raceSeats }
        : { mode: 'race', race, focus: solo ? 0 : null };
    if (phase !== 'lobby') {
      renderer.frame(dt, view);
      if (phase === 'final') hud.finalTags(renderer.podiumTags());
      hud.setWatching(phase === 'race' ? renderer.watching : null);
      if (phase === 'race') hud.update(race, renderer.project, Object.fromEntries(humans().map(h => [h.seat, h])));
    }
  }

  // Sticker-book tallies for one race event
  function tally(e, p) {
    const pk = race.floor.gap?.park, inPark = pk && p && p.z > pk.dive0 && p.z < pk.lift0;
    switch (e.name) {
      case 'clip': bump(e.seat, 'clips', e.n || 1); break;
      case 'boost': if (e.kind === 'ring' || e.kind === 'stream') bump(e.seat, e.kind === 'ring' ? 'rings' : 'streams'); if (e.gold) bump(e.seat, 'goldRings'); break;
      case 'tree': bump(e.seat, 'parkHits'); break;
      case 'hit': if (inPark) bump(e.seat, 'parkHits'); break;
      case 'crumple': bump(e.seat, 'crumples'); break;
      case 'parkwind':
        if (e.phase === 'dive') bump(e.seat, 'park');
        else if (!(raceStats.get(e.seat)?.parkHits)) bump(e.seat, 'parkClean');
        break;
      case 'trick': {
        const k = { duct: 'ducts', window: 'windows', speed: 'speed', circle: 'circles', clutch: 'clutch' }[e.id];
        if (k) bump(e.seat, k);
        bump(e.seat, `trick_${e.id}`);
        if (e.mult >= 3) bump(e.seat, 'chain5');
        break;
      }
      case 'landed':
        if (e.zone && !e.crumpled) {
          if (e.zone.ring === 0) bump(e.seat, 'bullseyes');
          bump(e.seat, `z_${race.floor.id}`);
        }
        break;
    }
  }
  // At the end of a race, send each player their tally for their sticker book
  function sendStats(rows) {
    for (const h of humans()) {
      const st = { ...(raceStats.get(h.seat) || {}) };
      delete st.parkHits;
      // feats that count once per race
      for (const k of ['park', 'parkClean', 'chain5']) if (st[k]) st[k] = 1;
      const row = rows.find(r => r.seat === h.seat);
      if (row) {
        st.races = 1;
        st[`f_${race.floor.id}`] = 1;
        if (row.place === 1) st.wins = 1;
        const lv = rankOf(match.players[h.seat]?.career).level;
        if (lv >= 4) st.manager = 1;
        if (lv >= 7) st.ceo = 1;
      }
      sendTo(h.seat, 'fx', { kind: 'stats', s: st });
    }
  }

  function drainEvents() {
    for (const e of race.events.splice(0)) {
      const p = race.planes.find(q => q.seat === e.seat);
      const col = colorFor(e.seat);
      // In solo, only your own tricks and combos get callouts (the computer pilots' stay quiet)
      const mine = !solo || e.seat === 0;
      tally(e, p);
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
          const c = race.clips[e.i];
          renderer.burst(c.x, c.y, c.z, '#c3cad1', mine ? 6 + chain * 2 : 5, mine ? 2.5 + chain * 0.4 : 2.5);
          sendTo(e.seat, 'fx', { kind: 'clip', n: e.n, chain });
          if (!mine) break;
          sfx.ding(chain);
          const s = renderer.project(c.x, c.y, c.z);
          // the count pops up at the side of the screen; the clip itself still flies to your counter
          hud.clipCount(chain > 1 ? `+${e.n}  x${chain}` : `+${e.n}`, chain);
          if (s.visible) hud.clipFly(s, e.seat, e.n);
          if (c.big) { renderer.confetti(c.x, c.y, c.z, ['#c3cad1', '#e0a526', '#f6efdc'], 24); renderer.punch(3); }
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
        case 'boost':
          // Rooftop park: threaded a wind ring, or caught a tailwind stream
          sfx.gust('up');
          if (p) { renderer.gust(p.x, p.y, p.z, 'side'); renderer.burst(p.x, p.y, p.z, e.kind === 'ring' ? '#8fd0ea' : '#d8ecf4', 10, 3); }
          renderer.boost(e.seat, e.amount);
          if (!solo || e.seat === 0) renderer.punch(e.kind === 'ring' ? 5 : 3);
          sendTo(e.seat, 'fx', { kind: 'boost', amount: e.amount, ring: e.kind === 'ring' });
          break;
        case 'item': {
          // Grabbed a power-up: a pop of colour where it was, and a callout for its pilot
          renderer.itemPop(e.x, e.y, e.z, e.kind);
          sendTo(e.seat, 'fx', { kind: 'item', item: e.kind });
          if (!mine) break;
          sfx.zone(2);
          const s = renderer.project(e.x, e.y + 1, e.z);
          if (s.visible) hud.floater(s.x, s.y, `${ITEMS[e.kind].label}! ${ITEMS[e.kind].what}`, 'combo big');
          if (!solo || e.seat === 0) renderer.punch(4);
          break;
        }
        case 'tree':
          renderer.treeHit(e.x, e.y, e.z);
          sendTo(e.seat, 'fx', { kind: 'tree', x: e.x, y: e.y, z: e.z });
          break;
        case 'parkwind': {
          // Once per race for each phase: the big gust into the park, the updraft out
          race.parkBanner ??= {};
          if (!race.parkBanner[e.phase]) {
            race.parkBanner[e.phase] = true;
            hud.banner(e.phase === 'dive' ? 'Big gust! Down into the park' : 'Updraft! Back up to the roof', 1800);
          }
          sendTo(e.seat, 'fx', { kind: 'toast', text: e.phase === 'dive' ? 'Big gust! Dodge the trees' : 'Updraft! Hold on' });
          break;
        }
        case 'gust':
          sfx.gust(e.dir);
          if (p) renderer.gust(p.x, p.y, p.z, e.dir);
          if (!solo || e.seat === 0) renderer.punch(e.dir === 'down' ? 5 : 3);
          sendTo(e.seat, 'fx', { kind: 'gust' });
          break;
        case 'trick': {
          sendTo(e.seat, 'fx', { kind: 'trick', label: e.label, clips: e.clips, mult: e.mult, boost: e.boost });
          // an Afterburner kick still shows on the plane itself
          if (e.boost && p) { renderer.burst(p.x, p.y, p.z, '#f08a2c', 10 + Math.round(e.boost * 3), 3); renderer.boost(e.seat, e.boost); }
          if (!mine) break;
          // Big hand-lettered callout by the plane; the multiplier grows the stamp
          sfx.trick(e.mult);
          if (e.boost) sfx.gust('up');
          const s = renderer.project(e.x, e.y + 1.4, e.z);
          hud.trick(s.visible ? s : null, nameOf(e.seat), e.label, e.clips, e.mult, colorFor(e.seat));
          if (p) renderer.confetti(p.x, p.y, p.z, [colorFor(e.seat), '#f2c94c', '#f6efdc'], 6 + e.mult * 4);
          renderer.punch(2 + e.mult + (e.boost ? 2 + e.boost : 0));
          break;
        }
        case 'outside':
          sfx.gust('up'); hud.banner(`${nameOf(e.seat)} is out the window!`, 1600);
          if (!solo || e.seat === 0) renderer.punch(6);
          sendTo(e.seat, 'fx', { kind: 'toast', text: 'Out the window! Get back in!' });
          break;
        case 'inside':
          if (!e.back) { renderer.confetti(e.x, e.y, e.z, [colorFor(e.seat), '#cfe2ea', '#f6efdc'], 24); renderer.shake(0.2); }
          sendTo(e.seat, 'fx', { kind: 'toast', text: e.back ? 'Back inside' : 'Made it back in!' });
          break;
        case 'stuck':
          hud.banner(`${nameOf(e.seat)} is stuck outside!`, 2000);
          sendTo(e.seat, 'fx', { kind: 'toast', text: 'Stuck outside' });
          break;
        case 'ductin':
          sfx.gust('down'); hud.banner(`${nameOf(e.seat)} took the duct!`, 1600);
          if (!solo || e.seat === 0) renderer.punch(5);
          sendTo(e.seat, 'fx', { kind: 'toast', text: 'In the duct! Don\u2019t scrape!' });
          break;
        case 'ductout':
          sfx.gust('up'); renderer.burst(e.x, e.y, e.z, '#a7b0b6', 16, 4);
          if (!solo || e.seat === 0) renderer.punch(7);
          break;
        case 'chainbreak': {
          sendTo(e.seat, 'fx', { kind: 'chainbreak', chain: e.chain });
          if (!mine) break;
          const s = p ? renderer.project(p.x, p.y + 1, p.z) : null;
          if (s?.visible) hud.floater(s.x, s.y, `Chain broken (x${e.chain})`, 'dmg');
          break;
        }
        case 'touch':
          sfx.land();
          if (p) renderer.burst(p.x, p.y, p.z, '#e9dcbc', 9, 2);
          break;
        case 'close': {
          if (race.t < 1.5) break;
          sendTo(e.seat, 'fx', { kind: 'close' });
          if (!mine) break;
          sfx.close();
          renderer.punch(4);
          break;
        }
        case 'landed':
          if (e.zone) {
            sfx.zone(e.zone.tier);
            hud.banner(`${nameOf(e.seat)}: ${e.zone.label} · ${e.zone.ringName} +${e.zone.pay}`);
            if (p) {
              // Bigger party for farther zones
              renderer.confetti(p.x, p.y + 0.3, p.z, [colorFor(e.seat), TIER_COLORS[e.zone.tier], '#f6efdc'], 16 + e.zone.tier * 10);
              renderer.ring(p.x, p.y - 0.1, p.z, TIER_COLORS[e.zone.tier], 4 + e.zone.tier * 2 + (2 - e.zone.ring) * 3);
              if (e.zone.ring === 0) { renderer.shake(0.25); sfx.zone(4); }
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
        seat: h.seat, name: pl.name, clips: pl.clips, points: pl.points, owned: pl.owned, parts: pl.parts, loadout: pl.loadout,
        state: p?.state ?? 'none', hp: p ? Math.round(p.hp) : 0, maxHp: p?.maxHp ?? 100,
        run: (p?.clips ?? 0) + (p?.tr?.clips ?? 0), chain: p?.tr?.chain ?? 0, crumpled: !!p?.crumpled, zone: p?.zone ?? null,
        dist: p ? Math.round(p.z) : 0, best: Math.round(pl.best[currentFloor(match).id] ?? 0),
        rank: rankOf(pl.career),
      });
    }
  }

  function broadcastPhase() {
    const f = layout || currentFloor(match);
    const next = match.floors[match.round + 1];
    broadcast('phase', {
      phase, round: match.round, rounds: match.floors.length, leg: legOf(match), legs: match.racesPerFloor,
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
    if (!solo) broadcast('snap', snapshot());
    const rows = payout(match, standings(race));
    lastRows = rows;
    sendStats(rows);
    setPhase('results');
    sfx.fanfare();
    hud.results(rows, layout, isLastRound(match), legOf(match), match.racesPerFloor);
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
      for (const id of botShop(b.brain, pl.clips, pl.parts, rankOf(pl.career).level)) buy(match, seat, id);
      shopDone.add(seat);
    }
    startsAt = Date.now() + SHOP_MS;
    renderer.setPlanes(planeLooks());
    hud.setHint('');
    renderShop();
    broadcastPhase();
    sendMeAll();
    later(SHOP_MS, nextRound);
  }

  function renderShop() {
    const next = match.floors[match.round + 1];
    hud.shop({
      next, nextLeg: legOf(match, match.round + 1), legs: match.racesPerFloor,
      players: raceSeats.map(seat => {
        const pl = match.players[seat];
        return { seat, name: pl.name, clips: pl.clips, owned: pl.owned, parts: pl.parts, loadout: pl.loadout, done: shopDone.has(seat) };
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
    const champ = finalRows[0];
    if (champ && humans().some(h => h.seat === champ.seat)) sendTo(champ.seat, 'fx', { kind: 'stats', s: { matchWins: 1 } });
    setPhase('final');
    sfx.fanfare();
    hud.setHint('');
    renderer.setPlanes(planeLooks());
    const looks = new Map(planeLooks().map(l => [l.seat, l]));
    renderer.setPodium(finalRows.slice(0, 3).map(r => ({ seat: r.seat, ...(looks.get(r.seat) || { owned: r.owned || [] }) })));
    hud.final(finalRows, {
      soloMenu: solo,
      onAgain: () => { if (solo) start(setupWanted); else onExit?.('lobby'); },
      onMenu: () => onExit?.('menu'),
    });
    broadcastPhase();
  }

  /* ---------------------------------------------------------- inputs --- */
  function onInput(seat, m) {
    if (!m || typeof m !== 'object') return;
    if (m.k === 'stickers') {
      stickersBy.set(seat, cleanPlaced(m.list));
      // show it right away, unless a race is under way (then it shows next race)
      if (match && phase !== 'race' && raceSeats.includes(seat)) renderer.setPlanes(planeLooks());
      return;
    }
    if (!match) return;
    // Get set: during the countdown players can already line up their throw
    if (phase === 'intro' && race && m.k === 'aim') { aimPlane(race, seat, m); return; }
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
          renderer.setPlanes(planeLooks());
        } else sendTo(seat, 'fx', { kind: 'nope', reason: r.reason });
        renderShop();
        sendMeAll();
      } else if (m.k === 'equip') {
        const r = equip(match, seat, String(m.id));
        if (r.ok) {
          sfx.tick();
          sendTo(seat, 'fx', { kind: 'equipped', id: m.id });
          renderer.setPlanes(planeLooks());
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
    if (lastLayout) sendTo(seat, 'layout', lastLayout);
    if (race) sendTo(seat, 'snap', snapshot());
    broadcastPhase();
    sendMeAll();
    if (phase === 'shop') renderShop();
  }

  function stop() { clearTimers(); setPhase('lobby'); broadcast('phase', { phase: 'lobby' }); }

  return { start, tick, onInput, onHello, skip, stop, get phase() { return phase; } };
}
