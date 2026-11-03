// rules.js: match-level rules (rounds, payouts, the shop). Pure, no DOM, no network.

import { UPGRADE_BY_ID, SLOT_BY_ID, partState, equippedList, MK, MAX_LEVEL } from '../shared/upgrades.js';
import { FLOORS, CUPS, floorPayMult } from './floors.js';

// Match points are each race's score (distance points + target points, see
// scoreRun in sim.js); finishing place just falls out of who scored most.
// Clips: 1.5 per distance point (scaled by floor) plus the target's pay,
// scaled by how far under par you landed, plus pickups, tricks and streaks.
export const DIST_CLIPS = 1.5;
// Race mode: clips for finishing place (scaled by floor like everything else)
export const RACE_PLACE_CLIPS = [14, 10, 7, 5, 3, 2, 1, 1];
export const SHOP_MS = 40000;

export const RACES_PER_FLOOR = 3;

// The career ladder lives in shared/ranks.js (the phone needs it too).
export { RANKS, rankOf } from '../shared/ranks.js';
import { rankOf, RANK_UNLOCKS } from '../shared/ranks.js';

// `opts.floors` lists the floor ids to play (always in building order) and
// `opts.races` how many races each floor gets. A plain number is the old
// shorthand: 3 = Lobby, Break Room, Rooftop; anything else = every floor.
// match.floors holds one entry per race.
// Race mode (`opts.mode === 'race'`): a cup, one race per floor, in the cup's
// own order. `opts.cup` is a cup id from CUPS, or 'custom' with `opts.floors`.
export function createMatch(opts = {}) {
  if (typeof opts === 'number') opts = { floors: opts >= 5 ? FLOORS.map(f => f.id) : [FLOORS[0].id, FLOORS[2].id, FLOORS[FLOORS.length - 1].id] };
  if (opts.mode === 'race') {
    const cup = CUPS.find(c => c.id === opts.cup);
    let ids = cup ? cup.floors : FLOORS.filter(f => (opts.floors ?? []).includes(f.id)).map(f => f.id);
    if (!ids.length) ids = CUPS[0].floors;
    return { mode: 'race', cup: cup ? cup.name : 'Custom Cup', round: 0, floors: ids.map(id => FLOORS.find(f => f.id === id)), racesPerFloor: 1, players: {} };
  }
  const races = Math.max(1, Math.min(5, Math.round(opts.races ?? RACES_PER_FLOOR)));
  let picked = FLOORS.filter(f => (opts.floors ?? []).includes(f.id));
  if (!picked.length) picked = FLOORS.slice();
  const floors = picked.flatMap(f => Array(races).fill(f));
  return { mode: 'golf', round: 0, floors, racesPerFloor: races, players: {} };
}

export function addPlayer(match, seat, name, bot = false) {
  if (!match.players[seat]) {
    match.players[seat] = { seat, name, bot, clips: 0, points: 0, owned: [], parts: {}, loadout: {}, wins: 0, history: [], career: 0, best: {}, zoneStreak: 0, cleanStreak: 0 };
  } else {
    match.players[seat].name = name;
  }
  return match.players[seat];
}

export const currentFloor = m => m.floors[m.round];
export const isLastRound = m => m.round >= m.floors.length - 1;
// Which race on the current floor this is (1-based), and of how many.
export const legOf = (m, round = m.round) => (round % (m.racesPerFloor || RACES_PER_FLOOR)) + 1;

// Turn race standings into clips and points. Returns rows in finishing order.
export function payout(match, standings) {
  const floor = currentFloor(match);
  const mult = floorPayMult(floor.number);
  const race = match.mode === 'race';
  const rows = standings.map((s, i) => {
    const pl = match.players[s.seat];
    const intact = !s.crumpled;
    const sc = s.score || { distPts: 0, targetPts: 0, total: 0, parFactor: 0 };
    // Race mode: no targets; finishing place pays clips instead
    const zone = race ? Math.round((RACE_PLACE_CLIPS[i] ?? 0) * mult) : intact && s.zone ? Math.round(s.zone.pay * sc.parFactor) : 0;
    const dist = Math.round(sc.distPts * DIST_CLIPS * mult);
    const points = sc.total;
    const pickup = s.clips;
    const tricks = s.trickClips || 0;
    // Streaks across races: landing in a zone again and again, and flying clean
    // (no damage at all). The bonus grows with the streak and resets on a miss.
    let streak = 0, zoneStreak = 0, cleanStreak = 0;
    if (pl) {
      pl.zoneStreak = !race && intact && s.zone ? (pl.zoneStreak || 0) + 1 : 0;
      pl.cleanStreak = s.clean ? (pl.cleanStreak || 0) + 1 : 0;
      zoneStreak = pl.zoneStreak; cleanStreak = pl.cleanStreak;
      if (zoneStreak >= 2) streak += Math.round(Math.min(10, 2 * (zoneStreak - 1)) * mult);
      if (cleanStreak >= 2) streak += Math.round(Math.min(8, 2 * (cleanStreak - 1)) * mult);
    }
    const earned = zone + dist + pickup + tricks + streak;
    let promoted = null, unlock = null, pb = false, best = 0;
    if (pl) {
      const before = rankOf(pl.career).level;
      pl.career += earned;
      const after = rankOf(pl.career);
      if (after.level > before) { promoted = after.title; unlock = RANK_UNLOCKS[after.level]; }
      // Personal best distance on this floor (intact landings only)
      // (race mode keeps its best finishing time per floor instead)
      const bk = race ? `race_${floor.id}` : floor.id;
      if (race) {
        const prevT = pl.best[bk] ?? 0;
        if (s.finishT != null && (!prevT || s.finishT < prevT)) { pb = prevT > 0; pl.best[bk] = s.finishT; }
      } else {
        const prev = pl.best[bk] ?? 0;
        if (intact && s.dist > prev) { pb = prev > 0; pl.best[bk] = s.dist; }
      }
      best = pl.best[bk] ?? 0;
      pl.clips += earned;
      pl.points += points;
      if (i === 0 && points > 0) pl.wins++;
      pl.history.push({ floor: currentFloor(match).id, place: i + 1, zone: s.zone?.label ?? null });
    }
    return {
      seat: s.seat, name: pl?.name ?? '?', place: i + 1,
      zone: s.zone?.label ?? null, ring: s.zone?.ringName ?? null, tier: s.zone?.tier ?? -1, crumpled: s.crumpled,
      dist: s.dist, earned: { zone, dist, pickup, tricks, streak, total: earned }, points,
      race, finished: !!s.finished, finishT: s.finishT ?? null,
      distPts: sc.distPts, targetPts: sc.targetPts, parFactor: sc.parFactor, flightT: sc.flightT, par: sc.par,
      trickList: s.tricks || [], zoneStreak, cleanStreak,
      totalPoints: pl?.points ?? 0, clips: pl?.clips ?? 0,
      rank: rankOf(pl?.career).title, promoted, unlock, pb, best: Math.round(best),
    };
  });
  return rows;
}

// Buy a part (it goes straight into its slot) or level up one you own.
export function buy(match, seat, id) {
  const pl = match.players[seat];
  const up = UPGRADE_BY_ID[id];
  if (!pl || !up) return { ok: false, reason: 'Unknown part' };
  const st = partState(pl.parts, id, rankOf(pl.career).level);
  if (st.state === 'maxed') return { ok: false, reason: `Already ${MK(MAX_LEVEL)}` };
  if (st.state !== 'open') return { ok: false, reason: st.reason };
  if (pl.clips < st.cost) return { ok: false, reason: 'Not enough clips' };
  pl.clips -= st.cost;
  pl.parts[id] = (pl.parts[id] || 0) + 1;
  pl.loadout[up.slot] = id;
  pl.owned = equippedList(pl.parts, pl.loadout);
  return { ok: true };
}

// Swap a slot to a part already in your inventory (free), or back to stock
// with id 'stock:<slot>'.
export function equip(match, seat, id) {
  const pl = match.players[seat];
  if (!pl) return { ok: false, reason: 'No player' };
  if (String(id).startsWith('stock:')) {
    const slot = String(id).slice(6);
    if (!SLOT_BY_ID[slot]) return { ok: false, reason: 'Unknown slot' };
    delete pl.loadout[slot];
  } else {
    const up = UPGRADE_BY_ID[id];
    if (!up || !pl.parts[id]) return { ok: false, reason: 'You don’t own that part' };
    pl.loadout[up.slot] = id;
  }
  pl.owned = equippedList(pl.parts, pl.loadout);
  return { ok: true };
}

export function finalStandings(match) {
  return Object.values(match.players)
    .sort((a, b) => (b.points - a.points) || (b.wins - a.wins) || (b.clips - a.clips))
    .map((p, i) => ({ seat: p.seat, name: p.name, place: i + 1, points: p.points, wins: p.wins, clips: p.clips, owned: p.owned, rank: rankOf(p.career).title }));
}
