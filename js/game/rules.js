// rules.js: match-level rules (rounds, payouts, the shop). Pure, no DOM, no network.

import { UPGRADE_BY_ID, upgradeState } from '../shared/upgrades.js';
import { FLOORS, floorPayMult } from './floors.js';

export const PLACE_CLIPS = [8, 5, 3, 1];
export const PLACE_POINTS = [10, 6, 3, 1];
export const SHOP_MS = 40000;

export const RACES_PER_FLOOR = 3;

// The career ladder lives in shared/ranks.js (the phone needs it too).
export { RANKS, rankOf } from '../shared/ranks.js';
import { rankOf, RANK_UNLOCKS } from '../shared/ranks.js';

// `opts.floors` lists the floor ids to play (always in building order) and
// `opts.races` how many races each floor gets. A plain number is the old
// shorthand: 3 = Lobby, Break Room, Rooftop; anything else = every floor.
// match.floors holds one entry per race.
export function createMatch(opts = {}) {
  if (typeof opts === 'number') opts = { floors: opts >= 5 ? FLOORS.map(f => f.id) : [FLOORS[0].id, FLOORS[2].id, FLOORS[FLOORS.length - 1].id] };
  const races = Math.max(1, Math.min(5, Math.round(opts.races ?? RACES_PER_FLOOR)));
  let picked = FLOORS.filter(f => (opts.floors ?? []).includes(f.id));
  if (!picked.length) picked = FLOORS.slice();
  const floors = picked.flatMap(f => Array(races).fill(f));
  return { round: 0, floors, racesPerFloor: races, players: {} };
}

export function addPlayer(match, seat, name, bot = false) {
  if (!match.players[seat]) {
    match.players[seat] = { seat, name, bot, clips: 0, points: 0, owned: [], wins: 0, history: [], career: 0, best: {}, zoneStreak: 0, cleanStreak: 0 };
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
  const rows = standings.map((s, i) => {
    const pl = match.players[s.seat];
    const intact = !s.crumpled;
    const zone = intact && s.zone ? s.zone.pay : 0;
    const place = intact ? Math.round((PLACE_CLIPS[i] ?? 0) * mult) : 0;
    const points = intact ? (PLACE_POINTS[i] ?? 0) : 0;
    const pickup = s.clips;
    const tricks = s.trickClips || 0;
    // Streaks across races: landing in a zone again and again, and flying clean
    // (no damage at all). The bonus grows with the streak and resets on a miss.
    let streak = 0, zoneStreak = 0, cleanStreak = 0;
    if (pl) {
      pl.zoneStreak = intact && s.zone ? (pl.zoneStreak || 0) + 1 : 0;
      pl.cleanStreak = s.clean ? (pl.cleanStreak || 0) + 1 : 0;
      zoneStreak = pl.zoneStreak; cleanStreak = pl.cleanStreak;
      if (zoneStreak >= 2) streak += Math.round(Math.min(10, 2 * (zoneStreak - 1)) * mult);
      if (cleanStreak >= 2) streak += Math.round(Math.min(8, 2 * (cleanStreak - 1)) * mult);
    }
    const earned = zone + place + pickup + tricks + streak;
    let promoted = null, unlock = null, pb = false, best = 0;
    if (pl) {
      const before = rankOf(pl.career).level;
      pl.career += earned;
      const after = rankOf(pl.career);
      if (after.level > before) { promoted = after.title; unlock = RANK_UNLOCKS[after.level]; }
      // Personal best distance on this floor (intact landings only)
      const prev = pl.best[floor.id] ?? 0;
      if (intact && s.dist > prev) { pb = prev > 0; pl.best[floor.id] = s.dist; }
      best = pl.best[floor.id] ?? 0;
      pl.clips += earned;
      pl.points += points;
      if (i === 0 && intact) pl.wins++;
      pl.history.push({ floor: currentFloor(match).id, place: i + 1, zone: s.zone?.label ?? null });
    }
    return {
      seat: s.seat, name: pl?.name ?? '?', place: i + 1,
      zone: s.zone?.label ?? null, ring: s.zone?.ringName ?? null, tier: s.zone?.tier ?? -1, crumpled: s.crumpled,
      dist: s.dist, earned: { zone, place, pickup, tricks, streak, total: earned }, points,
      trickList: s.tricks || [], zoneStreak, cleanStreak,
      totalPoints: pl?.points ?? 0, clips: pl?.clips ?? 0,
      rank: rankOf(pl?.career).title, promoted, unlock, pb, best: Math.round(best),
    };
  });
  return rows;
}

export function buy(match, seat, id) {
  const pl = match.players[seat];
  const up = UPGRADE_BY_ID[id];
  if (!pl || !up) return { ok: false, reason: 'Unknown upgrade' };
  const st = upgradeState(pl.owned, id, rankOf(pl.career).level);
  if (st.state === 'maxed') return { ok: false, reason: 'Already maxed out' };
  if (st.state !== 'open') return { ok: false, reason: st.reason };
  const cost = st.cost;
  if (pl.clips < cost) return { ok: false, reason: 'Not enough clips' };
  pl.clips -= cost;
  pl.owned.push(id);
  return { ok: true };
}

export function finalStandings(match) {
  return Object.values(match.players)
    .sort((a, b) => (b.points - a.points) || (b.wins - a.wins) || (b.clips - a.clips))
    .map((p, i) => ({ seat: p.seat, name: p.name, place: i + 1, points: p.points, wins: p.wins, clips: p.clips, owned: p.owned, rank: rankOf(p.career).title }));
}
