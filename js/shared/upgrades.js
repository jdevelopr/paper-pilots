// Upgrade catalogue. Shared by the host (stats, visuals) and the phone (shop UI).
// Every upgrade is a one-time purchase that permanently modifies the plane's stats.
// Most of them come with a trade-off, so there's no single "best" build.

export const UPGRADES = [
  {
    id: 'cardstock', name: 'Cardstock', cost: 12,
    pro: '+70 durability', con: 'Heavier, so it sinks faster',
    apply: s => { s.hp += 70; s.weight += 0.3; },
  },
  {
    id: 'rubberband', name: 'Rubber Band Launcher', cost: 10,
    pro: 'Faster start', con: null,
    apply: s => { s.launch *= 1.1; },
  },
  {
    id: 'widewings', name: 'Wide Wing Fold', cost: 14,
    pro: 'Glides much longer', con: 'Turns slower',
    apply: s => { s.sink *= 0.72; s.turn *= 0.8; },
  },
  {
    id: 'glossy', name: 'Glossy Paper', cost: 10,
    pro: 'Less drag, keeps speed', con: 'Slides farther on landing',
    apply: s => { s.drag *= 0.68; s.slide *= 1.7; },
  },
  {
    id: 'flaps', name: 'Sticky Note Flaps', cost: 8,
    pro: 'Sharper turns', con: 'A little more drag',
    apply: s => { s.turn *= 1.45; s.drag *= 1.08; },
  },
  {
    id: 'noseclip', name: 'Nose Clip', cost: 8,
    pro: 'Fans barely push you', con: 'Slightly heavier',
    apply: s => { s.wind *= 0.4; s.weight += 0.1; },
  },
  {
    id: 'tape', name: 'Packing Tape', cost: 9,
    pro: 'Takes 40% less damage', con: null,
    apply: s => { s.dmg *= 0.6; },
  },
  {
    id: 'magnet', name: 'Fridge Magnet', cost: 7,
    pro: 'Pulls in paper clips', con: null,
    apply: s => { s.magnet *= 2.4; },
  },
  {
    id: 'binder', name: 'Binder Clip Brake', cost: 6,
    pro: 'Sticks the landing', con: null,
    apply: s => { s.slide *= 0.25; },
  },
];

export const UPGRADE_BY_ID = Object.fromEntries(UPGRADES.map(u => [u.id, u]));

export function baseStats() {
  return { hp: 100, weight: 1, launch: 1, drag: 1, sink: 1, turn: 1, slide: 1, wind: 1, dmg: 1, magnet: 1 };
}

export function statsFor(owned = []) {
  const s = baseStats();
  for (const id of owned) UPGRADE_BY_ID[id]?.apply(s);
  return s;
}

// 0..1 bars for the shop's stat readout. Purely presentational.
export function statBars(owned = []) {
  const s = statsFor(owned);
  const clamp = v => Math.max(0.05, Math.min(1, v));
  return {
    Launch: clamp((s.launch - 0.6) / 1.0),
    Glide: clamp((1.6 - s.sink * (0.7 + 0.3 * s.weight)) / 1.2),
    Toughness: clamp((s.hp / s.dmg) / 340),
    Handling: clamp(s.turn / 1.6),
  };
}
