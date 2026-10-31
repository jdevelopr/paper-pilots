// Upgrade tree. Shared by the host (stats, rules, visuals) and the phone (shop UI).
//
// Every upgrade has MAX_LEVEL levels, bought one at a time. A player's `owned`
// list holds one entry per level bought, so ['tape', 'tape'] is Packing Tape II.
// Each level applies its own (usually smaller) step on top of the previous ones,
// and downsides stack too.
//
// The tree:
//   - `req`: upgrades (and levels) you must own before this one unlocks.
//   - `group`: exclusive choices. Owning any level of one upgrade in a group
//     locks the others in that group for the rest of the match.
//   Basics are open to everyone. Each Specialty (Glider / Dart / Tank) needs a
//   basic at level 2, and picking one locks the other two along with their
//   branch upgrades. Extras hang off particular basics.

import { RANKS, RANK } from './ranks.js';

export const MAX_LEVEL = 5;

// Price of each level relative to the base cost.
const COST_STEPS = [1, 1.8, 2.9, 4.4, 6.5];

const mul = (k, vals) => (s, i) => { s[k] *= vals[i]; };
const add = (k, vals) => (s, i) => { s[k] += vals[i]; };
const both = (...fns) => (s, i) => fns.forEach(f => f(s, i));

export const SECTIONS = [
  { id: 'basic', title: 'Basics' },
  { id: 'spec', title: 'Specialty · pick one' },
  { id: 'extra', title: 'Extras' },
];

export const UPGRADES = [
  /* ------------------------------------------------------------ basics --- */
  { id: 'cardstock', section: 'basic', name: 'Cardstock', base: 17,
    pro: 'More durability', con: 'Heavier, so it sinks faster',
    step: both(add('hp', [70, 60, 50, 40, 35]), add('weight', [0.3, 0.2, 0.2, 0.15, 0.15])) },
  { id: 'rubberband', section: 'basic', name: 'Rubber Band Launcher', base: 14,
    pro: 'Faster start', con: null,
    step: mul('launch', [1.1, 1.05, 1.04, 1.03, 1.03]) },
  { id: 'widewings', section: 'basic', name: 'Wide Wing Fold', base: 20,
    pro: 'Glides longer', con: 'Turns slower',
    step: both(mul('sink', [0.72, 0.86, 0.9, 0.93, 0.95]), mul('turn', [0.8, 0.9, 0.92, 0.94, 0.95])) },
  { id: 'glossy', section: 'basic', name: 'Glossy Paper', base: 14,
    pro: 'Less drag, keeps speed', con: 'Slides farther on landing',
    step: both(mul('drag', [0.68, 0.86, 0.9, 0.93, 0.95]), mul('slide', [1.7, 1.3, 1.2, 1.1, 1.1])) },
  { id: 'binder', section: 'basic', name: 'Binder Clip Brake', base: 8,
    pro: 'Sticks the landing', con: null,
    step: mul('slide', [0.25, 0.6, 0.6, 0.7, 0.7]) },
  { id: 'flaps', section: 'basic', name: 'Sticky Note Flaps', base: 11,
    pro: 'Sharper turns', con: 'A little more drag',
    step: both(mul('turn', [1.45, 1.2, 1.15, 1.1, 1.08]), mul('drag', [1.08, 1.05, 1.04, 1.03, 1.03])) },
  { id: 'noseclip', section: 'basic', name: 'Nose Clip', base: 11,
    pro: 'Fans push you less', con: 'Slightly heavier',
    step: both(mul('wind', [0.4, 0.6, 0.6, 0.7, 0.7]), add('weight', [0.1, 0.05, 0.05, 0.05, 0.05])) },
  { id: 'tape', section: 'basic', name: 'Packing Tape', base: 13,
    pro: 'Takes less damage', con: null,
    step: mul('dmg', [0.6, 0.8, 0.85, 0.88, 0.9]) },
  { id: 'magnet', section: 'basic', name: 'Fridge Magnet', base: 10,
    pro: 'Pulls in paper clips', con: null,
    step: mul('magnet', [2.4, 1.4, 1.3, 1.2, 1.15]) },
  { id: 'afterburner', section: 'basic', name: 'Afterburner Doodle', base: 15,
    pro: 'Tricks give a burst of speed', con: null,
    step: add('trickBoost', [2.5, 0.75, 0.75, 0.75, 0.75]) },

  /* ------------------------------------------- specialties (exclusive) --- */
  { id: 'swallowtail', section: 'spec', name: 'Swallowtail Fold', base: 25, group: 'spec', path: 'Glider',
    req: [['widewings', 2]],
    pro: 'Floats: much slower sink', con: 'Lower top speed',
    step: both(mul('sink', [0.8, 0.9, 0.92, 0.94, 0.95]), mul('drag', [1.1, 1.04, 1.03, 1.02, 1.02])) },
  { id: 'thermal', section: 'spec', name: 'Thermal Sense', base: 20, path: 'Glider', parent: 'swallowtail',
    req: [['swallowtail', 1]],
    pro: 'Vents lift you higher', con: null,
    step: mul('lift', [1.3, 1.15, 1.1, 1.08, 1.06]) },
  { id: 'featherweight', section: 'spec', name: 'Tissue Paper', base: 22, path: 'Glider', parent: 'swallowtail',
    req: [['swallowtail', 2]],
    pro: 'Much lighter', con: 'Fragile',
    step: both(add('weight', [-0.15, -0.1, -0.08, -0.06, -0.05]), mul('dmg', [1.2, 1.08, 1.06, 1.05, 1.05])) },

  { id: 'dart', section: 'spec', name: 'Dart Fold', base: 25, group: 'spec', path: 'Dart',
    req: [['rubberband', 2]],
    pro: 'Slices through the air', con: 'Sinks a bit faster',
    step: both(mul('drag', [0.72, 0.88, 0.9, 0.93, 0.95]), mul('sink', [1.08, 1.03, 1.03, 1.02, 1.02])) },
  { id: 'pencilnose', section: 'spec', name: 'Pencil Nose', base: 20, path: 'Dart', parent: 'dart',
    req: [['dart', 1]],
    pro: 'Bounces off walls keeping speed', con: null,
    step: mul('bounce', [1.3, 1.12, 1.1, 1.08, 1.06]) },
  { id: 'jetstream', section: 'spec', name: 'Jet Stream Crease', base: 22, path: 'Dart', parent: 'dart',
    req: [['dart', 2]],
    pro: 'Even harder launch', con: 'Turns slower',
    step: both(mul('launch', [1.08, 1.04, 1.03, 1.03, 1.02]), mul('turn', [0.94, 0.97, 0.98, 0.98, 0.98])) },

  { id: 'laminated', section: 'spec', name: 'Laminated', base: 25, group: 'spec', path: 'Tank',
    req: [['cardstock', 2], ['tape', 1]],
    pro: 'Huge durability', con: 'Heavier',
    step: both(add('hp', [120, 80, 60, 50, 40]), add('weight', [0.15, 0.1, 0.1, 0.08, 0.08])) },
  { id: 'bumpers', section: 'spec', name: 'Eraser Bumpers', base: 20, path: 'Tank', parent: 'laminated',
    req: [['laminated', 1]],
    pro: 'Shrugs off hits', con: null,
    step: both(mul('dmg', [0.7, 0.85, 0.88, 0.9, 0.92]), mul('bounce', [1.15, 1.06, 1.05, 1.04, 1.03])) },
  { id: 'paperweight', section: 'spec', name: 'Paperweight Drop', base: 22, path: 'Tank', parent: 'laminated',
    req: [['laminated', 2]],
    pro: 'Drop like a stone when you stall', con: null,
    step: mul('stallDrop', [1.5, 1.2, 1.15, 1.1, 1.08]) },

  /* ------------------------------------------------------------ extras --- */
  { id: 'rudder', section: 'extra', name: 'Highlighter Rudder', base: 17,
    req: [['flaps', 2]],
    pro: 'Holds a tight turn at speed', con: null,
    step: mul('turn', [1.15, 1.08, 1.06, 1.05, 1.04]) },
  { id: 'collector', section: 'extra', name: 'Clip Collector', base: 17,
    req: [['magnet', 2]],
    pro: 'Extra clip per pickup', con: null,
    step: add('clipBonus', [1, 0, 1, 0, 1]) },
  { id: 'skids', section: 'extra', name: 'Eraser Skids', base: 14,
    req: [['binder', 1]],
    pro: 'Hard landings don’t hurt', con: null,
    step: mul('landDmg', [0.5, 0.7, 0.7, 0.8, 0.8]) },
].map(u => ({ ...u, req: u.req || [], costs: COST_STEPS.map(k => Math.round(u.base * k)), cost: u.base }));

export const UPGRADE_BY_ID = Object.fromEntries(UPGRADES.map(u => [u.id, u]));

export const levelOf = (owned = [], id) => owned.reduce((n, x) => n + (x === id), 0);

export const ROMAN = ['', 'I', 'II', 'III', 'IV', 'V'];

// Why an upgrade can or can't be bought right now. Shared by the host's rules,
// the bots and the phone shop, so they always agree.
//   { state: 'open'|'maxed'|'needs'|'lockedOut', cost, reason }
// Promotion gates: the title needed to buy a given level (1-based) of an upgrade.
const LEVEL_RANK = [0, 0, 0, RANK.Supervisor, RANK.Manager, RANK.Director];
function rankNeeded(u, nextLevel) {
  let need = LEVEL_RANK[nextLevel] || 0;
  if (u.section === 'extra') need = Math.max(need, RANK.Temp);
  if (u.section === 'spec') need = Math.max(need, u.parent ? RANK.Supervisor : RANK.Associate);
  return need;
}

// `rank` is the buyer's career level (see ranks.js). Leave it out to ignore
// promotion gates (e.g. when only checking the tree structure).
export function upgradeState(owned = [], id, rank = Infinity) {
  const u = UPGRADE_BY_ID[id];
  if (!u) return { state: 'lockedOut', reason: 'Unknown upgrade' };
  const lv = levelOf(owned, id);
  if (lv >= MAX_LEVEL) return { state: 'maxed', level: lv };
  // Locked out by an exclusive choice: a sibling in the same group, or (for a
  // branch upgrade) a different specialty.
  const groupOf = x => x.group || (x.parent ? UPGRADE_BY_ID[x.parent].group : null);
  const grp = groupOf(u);
  if (grp && lv === 0) {
    const rival = UPGRADES.find(o => o.id !== id && o.group === grp && levelOf(owned, o.id) > 0 && o.id !== u.parent);
    if (rival) return { state: 'lockedOut', level: lv, reason: `Locked: you chose ${rival.name}` };
  }
  const missing = u.req.find(([rid, rl]) => levelOf(owned, rid) < rl);
  if (missing) return { state: 'needs', level: lv, reason: `Needs ${UPGRADE_BY_ID[missing[0]].name} ${ROMAN[missing[1]]}` };
  const need = rankNeeded(u, lv + 1);
  if (rank < need) return { state: 'needs', level: lv, rankGate: need, reason: `${lv ? `Level ${ROMAN[lv + 1]} needs` : 'Needs'} ${RANKS[need].title} rank` };
  return { state: 'open', level: lv, cost: u.costs[lv] };
}

// Cost of the next level, or null when it can't be bought.
export function nextCost(owned, id, rank = Infinity) {
  const s = upgradeState(owned, id, rank);
  return s.state === 'open' ? s.cost : null;
}

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
  const clamp = v => Math.max(0.05, Math.min(1, v));
  return {
    Launch: clamp((s.launch - 0.6) / 1.1),
    Glide: clamp((1.6 - s.sink * (0.7 + 0.3 * s.weight)) / 1.4),
    Toughness: clamp((s.hp / s.dmg) / 1100),
    Handling: clamp(s.turn / 3),
  };
}
