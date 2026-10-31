// Upgrade catalogue. Shared by the host (stats, visuals) and the phone (shop UI).
//
// Every upgrade has MAX_LEVEL levels, bought one at a time. A player's `owned`
// list holds one entry per level bought, so ['tape', 'tape'] is Packing Tape
// level 2. Each level applies its own (usually smaller) step on top of the
// previous ones, and the trade-offs stack too, so maxing one thing out has a cost.

export const MAX_LEVEL = 3;

// Price of level 1, 2, 3 relative to the base cost.
const COST_STEPS = [1, 1.6, 2.3];

const mul = (k, vals) => (s, i) => { s[k] *= vals[i]; };
const add = (k, vals) => (s, i) => { s[k] += vals[i]; };
const both = (...fns) => (s, i) => fns.forEach(f => f(s, i));

export const UPGRADES = [
  {
    id: 'cardstock', name: 'Cardstock', base: 12,
    pro: 'More durability', con: 'Heavier, so it sinks faster',
    step: both(add('hp', [70, 60, 50]), add('weight', [0.3, 0.2, 0.2])),
  },
  {
    id: 'rubberband', name: 'Rubber Band Launcher', base: 10,
    pro: 'Faster start', con: null,
    step: mul('launch', [1.1, 1.05, 1.04]),
  },
  {
    id: 'widewings', name: 'Wide Wing Fold', base: 14,
    pro: 'Glides longer', con: 'Turns slower',
    step: both(mul('sink', [0.72, 0.86, 0.9]), mul('turn', [0.8, 0.9, 0.9])),
  },
  {
    id: 'glossy', name: 'Glossy Paper', base: 10,
    pro: 'Less drag, keeps speed', con: 'Slides farther on landing',
    step: both(mul('drag', [0.68, 0.86, 0.9]), mul('slide', [1.7, 1.3, 1.2])),
  },
  {
    id: 'flaps', name: 'Sticky Note Flaps', base: 8,
    pro: 'Sharper turns', con: 'A little more drag',
    step: both(mul('turn', [1.45, 1.2, 1.15]), mul('drag', [1.08, 1.05, 1.05])),
  },
  {
    id: 'noseclip', name: 'Nose Clip', base: 8,
    pro: 'Fans push you less', con: 'Slightly heavier',
    step: both(mul('wind', [0.4, 0.6, 0.5]), add('weight', [0.1, 0.05, 0.05])),
  },
  {
    id: 'tape', name: 'Packing Tape', base: 9,
    pro: 'Takes less damage', con: null,
    step: mul('dmg', [0.6, 0.8, 0.8]),
  },
  {
    id: 'magnet', name: 'Fridge Magnet', base: 7,
    pro: 'Pulls in paper clips', con: null,
    step: mul('magnet', [2.4, 1.4, 1.3]),
  },
  {
    id: 'binder', name: 'Binder Clip Brake', base: 6,
    pro: 'Sticks the landing', con: null,
    step: mul('slide', [0.25, 0.6, 0.5]),
  },
].map(u => ({ ...u, costs: COST_STEPS.map(k => Math.round(u.base * k)), cost: u.base }));

export const UPGRADE_BY_ID = Object.fromEntries(UPGRADES.map(u => [u.id, u]));

export const levelOf = (owned = [], id) => owned.reduce((n, x) => n + (x === id), 0);

// Cost of the next level, or null when maxed out.
export function nextCost(owned, id) {
  const lv = levelOf(owned, id);
  return lv >= MAX_LEVEL ? null : UPGRADE_BY_ID[id].costs[lv];
}

export const ROMAN = ['', 'I', 'II', 'III'];

export function baseStats() {
  return { hp: 100, weight: 1, launch: 1, drag: 1, sink: 1, turn: 1, slide: 1, wind: 1, dmg: 1, magnet: 1 };
}

export function statsFor(owned = []) {
  const s = baseStats();
  for (const u of UPGRADES) {
    const lv = Math.min(MAX_LEVEL, levelOf(owned, u.id));
    for (let i = 0; i < lv; i++) u.step(s, i);
  }
  return s;
}

// 0..1 bars for the shop's stat readout. Purely presentational.
export function statBars(owned = []) {
  const s = statsFor(owned);
  const clamp = v => Math.max(0.05, Math.min(1, v));
  return {
    Launch: clamp((s.launch - 0.6) / 1.0),
    Glide: clamp((1.6 - s.sink * (0.7 + 0.3 * s.weight)) / 1.3),
    Toughness: clamp((s.hp / s.dmg) / 600),
    Handling: clamp(s.turn / 2.2),
  };
}
