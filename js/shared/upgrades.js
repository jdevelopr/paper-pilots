// Upgrades as a loadout. Shared by the host (stats, rules, visuals) and the
// player's controller (shop UI).
//
// The plane has five slots: Paper, Fold, Nose, Tail and Gadget. Each slot has
// a free stock part and three parts you can buy. A part goes up to Mk III
// (Mk II needs Associate rank, Mk III needs Supervisor). Bought parts stay in
// your inventory for the rest of the match, so you can swap back to one for
// free between races. Only the parts you have equipped do anything.
//
// A player has:
//   parts:   { partId: level }          everything bought this match
//   loadout: { slotId: partId }         what's equipped (missing = stock)
//   owned:   ['cardstock', 'cardstock', 'magnet', ...]
//            the equipped parts, one entry per level. The sim (statsFor) and
//            the renderer (the plane's look) read this list.

import { RANK, RANKS } from './ranks.js';

export const MAX_LEVEL = 3;
export const ROMAN = ['', 'I', 'II', 'III'];
export const MK = lv => `Mk ${ROMAN[lv]}`;

// Price of each level relative to the part's base price.
const COST_STEPS = [1, 2.2, 4];
// Rank needed to buy each level (1-based).
const LEVEL_RANK = [0, 0, RANK.Associate, RANK.Supervisor];

const mul = (k, vals) => (s, i) => { s[k] *= vals[i]; };
const add = (k, vals) => (s, i) => { s[k] += vals[i]; };
const both = (...fns) => (s, i) => fns.forEach(f => f(s, i));
// Per-level values stack: Mk II applies step 0 then step 1.

export const SLOTS = [
  { id: 'paper', name: 'Paper', stock: 'Printer Paper' },
  { id: 'fold', name: 'Fold', stock: 'Classic Dart' },
  { id: 'nose', name: 'Nose', stock: 'Bare Nose' },
  { id: 'tail', name: 'Tail', stock: 'Plain Tail' },
  { id: 'gadget', name: 'Gadget', stock: 'No Gadget' },
];
export const SLOT_BY_ID = Object.fromEntries(SLOTS.map(s => [s.id, s]));

export const UPGRADES = [
  /* ------------------------------------------------------------- paper --- */
  { id: 'cardstock', slot: 'paper', name: 'Cardstock', base: 35,
    pro: 'Much more durability', con: 'Heavier, sinks faster',
    step: both(add('hp', [60, 50, 50]), add('weight', [0.25, 0.1, 0.1])) },
  { id: 'tissue', slot: 'paper', name: 'Tissue Paper', base: 38,
    pro: 'Floats much longer', con: 'Fragile',
    step: both(add('weight', [-0.2, -0.08, -0.07]), mul('sink', [0.86, 0.92, 0.92]), mul('dmg', [1.3, 1.08, 1.08])) },
  { id: 'glossy', slot: 'paper', name: 'Glossy Photo Paper', base: 35,
    pro: 'Keeps its speed', con: 'Slides far on landing',
    step: both(mul('drag', [0.7, 0.86, 0.88]), mul('slide', [1.7, 1.12, 1.1])) },

  /* -------------------------------------------------------------- fold --- */
  { id: 'widewings', slot: 'fold', name: 'Wide Glider', base: 42,
    pro: 'Glides much farther', con: 'Turns slower',
    step: both(mul('sink', [0.7, 0.86, 0.88]), mul('turn', [0.8, 0.94, 0.94])) },
  { id: 'needle', slot: 'fold', name: 'Needle Dart', base: 42,
    pro: 'Fast and slippery', con: 'Sinks a bit faster',
    step: both(mul('drag', [0.72, 0.86, 0.88]), mul('launch', [1.05, 1.03, 1.03]), mul('sink', [1.1, 1.02, 1.02])) },
  { id: 'stunt', slot: 'fold', name: 'Stunt Fold', base: 38,
    pro: 'Very sharp turns', con: 'More drag',
    step: both(mul('turn', [1.5, 1.2, 1.15]), mul('drag', [1.08, 1.02, 1.02])) },

  /* -------------------------------------------------------------- nose --- */
  { id: 'noseclip', slot: 'nose', name: 'Paper Clip Nose', base: 29,
    pro: 'Fans and wind barely push you', con: 'Slightly heavier',
    step: both(mul('wind', [0.4, 0.6, 0.5]), add('weight', [0.06, 0.02, 0.02])) },
  { id: 'pencil', slot: 'nose', name: 'Pencil Tip', base: 32,
    pro: 'Bounce off walls keeping speed', con: null,
    step: mul('bounce', [1.35, 1.15, 1.12]) },
  { id: 'magnet', slot: 'nose', name: 'Fridge Magnet', base: 29,
    pro: 'Pulls in paper clips from far away', con: null,
    step: both(mul('magnet', [2.4, 1.35, 1.3]), add('clipBonus', [0, 0, 1])) },

  /* -------------------------------------------------------------- tail --- */
  { id: 'flaps', slot: 'tail', name: 'Sticky Note Flaps', base: 29,
    pro: 'Sharper turns', con: 'A little drag',
    step: both(mul('turn', [1.35, 1.12, 1.1]), mul('drag', [1.05, 1.01, 1.01])) },
  { id: 'binder', slot: 'tail', name: 'Binder Clip Brake', base: 26,
    pro: 'Stops dead on landing', con: null,
    step: mul('slide', [0.3, 0.5, 0.4]) },
  { id: 'skids', slot: 'tail', name: 'Eraser Skids', base: 26,
    pro: 'Hard landings don’t hurt', con: null,
    step: mul('landDmg', [0.4, 0.4, 0.2]) },

  /* ------------------------------------------------------------ gadget --- */
  { id: 'rubberband', slot: 'gadget', name: 'Rubber Band Launcher', base: 32,
    pro: 'Much harder launch', con: null,
    step: mul('launch', [1.12, 1.07, 1.07]) },
  { id: 'afterburner', slot: 'gadget', name: 'Afterburner Doodle', base: 38,
    pro: 'Tricks give a burst of speed', con: null,
    step: add('trickBoost', [2.5, 1.5, 1.5]) },
  { id: 'tape', slot: 'gadget', name: 'Packing Tape', base: 32,
    pro: 'Takes much less damage', con: null,
    step: mul('dmg', [0.6, 0.78, 0.8]) },
].map(u => ({ ...u, costs: COST_STEPS.map(k => Math.round(u.base * k)), cost: u.base }));

export const UPGRADE_BY_ID = Object.fromEntries(UPGRADES.map(u => [u.id, u]));

export const levelOf = (owned = [], id) => owned.reduce((n, x) => n + (x === id), 0);

/* ------------------------------------------------------------ loadout --- */

// The equipped parts as the sim/renderer list (one entry per level).
export function equippedList(parts = {}, loadout = {}) {
  const out = [];
  for (const s of SLOTS) {
    const id = loadout[s.id];
    if (id && parts[id]) for (let i = 0; i < Math.min(MAX_LEVEL, parts[id]); i++) out.push(id);
  }
  return out;
}

// Can this part be bought (or levelled up) right now?
//   { state: 'open'|'maxed'|'needs', level, cost, reason, rankGate }
export function partState(parts = {}, id, rank = Infinity) {
  const u = UPGRADE_BY_ID[id];
  if (!u) return { state: 'needs', level: 0, reason: 'Unknown part' };
  const lv = parts[id] || 0;
  if (lv >= MAX_LEVEL) return { state: 'maxed', level: lv };
  const need = LEVEL_RANK[lv + 1] || 0;
  if (rank < need) return { state: 'needs', level: lv, rankGate: need, reason: `${MK(lv + 1)} needs ${RANKS[need].title} rank` };
  return { state: 'open', level: lv, cost: u.costs[lv] };
}

/* -------------------------------------------------------------- stats --- */

export function baseStats() {
  return {
    hp: 100, weight: 1, launch: 1, drag: 1, sink: 1, turn: 1, slide: 1, wind: 1, dmg: 1, magnet: 1,
    lift: 1, bounce: 1, stallDrop: 1, clipBonus: 0, landDmg: 1, trickBoost: 0,
  };
}

export function statsFor(owned = []) {
  const s = baseStats();
  for (const u of UPGRADES) {
    const lv = Math.min(MAX_LEVEL, levelOf(owned, u.id));
    for (let i = 0; i < lv; i++) u.step(s, i);
  }
  s.weight = Math.max(0.5, s.weight);
  return s;
}

// 0..1 bars for the shop's stat readout. Purely presentational.
export function statBars(owned = []) {
  const s = statsFor(owned);
  const clamp = v => Math.max(0.04, Math.min(1, v));
  return {
    Launch: clamp((s.launch - 0.7) / 0.9),
    Speed: clamp((1.6 - s.drag) / 1.2),
    Glide: clamp((1.6 - s.sink * (0.7 + 0.3 * s.weight)) / 1.3),
    Turning: clamp(s.turn / 2.6),
    Toughness: clamp((s.hp / s.dmg) / 600),
    Landing: clamp(1 - Math.log2(s.slide * 1.2) / 4),
  };
}
