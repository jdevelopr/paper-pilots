// rules.js: match-level rules (rounds, payouts, the shop). Pure, no DOM, no network.

import { UPGRADE_BY_ID, nextCost } from '../shared/upgrades.js';
import { FLOORS } from './floors.js';

export const PLACE_CLIPS = [8, 5, 3, 1];
export const PLACE_POINTS = [10, 6, 3, 1];
export const SHOP_MS = 40000;

export const RACES_PER_FLOOR = 3;

// `rounds` is the number of floors. Each floor is raced RACES_PER_FLOOR times,
// so match.floors holds one entry per race.
export function createMatch(rounds = 5) {
  const picked = rounds >= 5 ? FLOORS.slice() : [FLOORS[0], FLOORS[2], FLOORS[4]];
  const floors = picked.flatMap(f => Array(RACES_PER_FLOOR).fill(f));
  return { round: 0, floors, players: {} };
}

export function addPlayer(match, seat, name, bot = false) {
  if (!match.players[seat]) {
    match.players[seat] = { seat, name, bot, clips: 0, points: 0, owned: [], wins: 0, history: [] };
  } else {
    match.players[seat].name = name;
  }
  return match.players[seat];
}

export const currentFloor = m => m.floors[m.round];
export const isLastRound = m => m.round >= m.floors.length - 1;
// Which race on the current floor this is (1-based), and of how many.
export const legOf = (m, round = m.round) => (round % RACES_PER_FLOOR) + 1;

// Turn race standings into clips and points. Returns rows in finishing order.
export function payout(match, standings) {
  const rows = standings.map((s, i) => {
    const pl = match.players[s.seat];
    const intact = !s.crumpled;
    const zone = intact && s.zone ? s.zone.pay : 0;
    const place = intact ? (PLACE_CLIPS[i] ?? 0) : 0;
    const points = intact ? (PLACE_POINTS[i] ?? 0) : 0;
    const pickup = s.clips;
    const earned = zone + place + pickup;
    if (pl) {
      pl.clips += earned;
      pl.points += points;
      if (i === 0 && intact) pl.wins++;
      pl.history.push({ floor: currentFloor(match).id, place: i + 1, zone: s.zone?.label ?? null });
    }
    return {
      seat: s.seat, name: pl?.name ?? '?', place: i + 1,
      zone: s.zone?.label ?? null, tier: s.zone?.tier ?? -1, crumpled: s.crumpled,
      dist: s.dist, earned: { zone, place, pickup, total: earned }, points,
      totalPoints: pl?.points ?? 0, clips: pl?.clips ?? 0,
    };
  });
  return rows;
}

export function buy(match, seat, id) {
  const pl = match.players[seat];
  const up = UPGRADE_BY_ID[id];
  if (!pl || !up) return { ok: false, reason: 'Unknown upgrade' };
  const cost = nextCost(pl.owned, id);
  if (cost == null) return { ok: false, reason: 'Already maxed out' };
  if (pl.clips < cost) return { ok: false, reason: 'Not enough clips' };
  pl.clips -= cost;
  pl.owned.push(id);
  return { ok: true };
}

export function finalStandings(match) {
  return Object.values(match.players)
    .sort((a, b) => (b.points - a.points) || (b.wins - a.wins) || (b.clips - a.clips))
    .map((p, i) => ({ seat: p.seat, name: p.name, place: i + 1, points: p.points, wins: p.wins, clips: p.clips, owned: p.owned }));
}
