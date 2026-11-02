// stickers.js: the sticker book. Stickers are cosmetic only: you earn them for
// feats (milestones), and stick up to 12 anywhere on your plane.
//
// The book lives on the player's own device (localStorage), so it follows you
// from match to match and room to room. The host sends each player a summary
// of every race they fly ('stats'); the device adds it up and unlocks stickers.
// The plane's sticker layout is sent to the host, which shows it to everyone.

import { TRICKS } from '../game/sim.js';

export const MAX_ON_PLANE = 12;
export const STICKER_SIZE = 0.36;    // base size on the plane, in plane units

const K = '#2c2416';   // ink
const s = (body) => body.replace(/INK/g, K);

// Each sticker: art (SVG markup in a 64x64 box), the feat that earns it, and how
// to measure progress. `stat` is a running total kept in the book; `need` is the
// amount that unlocks it. starter stickers are yours from the start.
export const STICKERS = [
  { id: 'smile', name: 'Smiley', hint: 'Yours from the start', starter: true,
    art: s('<circle cx="32" cy="32" r="22" fill="#f2c94c" stroke="INK" stroke-width="3"/><circle cx="24" cy="27" r="3" fill="INK"/><circle cx="40" cy="27" r="3" fill="INK"/><path d="M21 37q11 11 22 0" fill="none" stroke="INK" stroke-width="3" stroke-linecap="round"/>') },
  { id: 'heart', name: 'Heart', hint: 'Yours from the start', starter: true,
    art: s('<path d="M32 52S11 39 11 24a10 10 0 0 1 21-5 10 10 0 0 1 21 5c0 15-21 28-21 28z" fill="#e2462e" stroke="INK" stroke-width="3" stroke-linejoin="round"/><path d="M19 23a5 5 0 0 1 6-5" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round"/>') },
  { id: 'wings', name: 'Pilot Wings', hint: 'Finish your first race', stat: 'races', need: 1,
    art: s('<path d="M32 26l-24-6 6 7-4 1 8 6 14 1zM32 26l24-6-6 7 4 1-8 6-14 1z" fill="#e0a526" stroke="INK" stroke-width="2.5" stroke-linejoin="round"/><circle cx="32" cy="31" r="7" fill="#1e4d6b" stroke="INK" stroke-width="2.5"/><path d="M29 31l2 2 4-4" fill="none" stroke="#fff" stroke-width="2.5" stroke-linecap="round"/>') },
  { id: 'veteran', name: 'Frequent Flyer', hint: 'Finish 25 races', stat: 'races', need: 25,
    art: s('<rect x="10" y="16" width="44" height="30" rx="5" fill="#8fd0ea" stroke="INK" stroke-width="3"/><path d="M10 26h44" stroke="INK" stroke-width="3"/><path d="M18 37h14M18 41h9" stroke="INK" stroke-width="2.5" stroke-linecap="round"/><path d="M40 34l9 4-9 4 2-4z" fill="#fff" stroke="INK" stroke-width="2" stroke-linejoin="round"/>') },
  { id: 'star', name: 'Gold Star', hint: 'Land a bullseye', stat: 'bullseyes', need: 1,
    art: s('<path d="M32 8l7 15 16 2-12 11 3 16-14-8-14 8 3-16L9 25l16-2z" fill="#f2c94c" stroke="INK" stroke-width="3" stroke-linejoin="round"/><path d="M27 22l3-6" stroke="#fff" stroke-width="3" stroke-linecap="round"/>') },
  { id: 'target', name: 'Sharpshooter', hint: 'Land 10 bullseyes', stat: 'bullseyes', need: 10,
    art: s('<circle cx="32" cy="32" r="22" fill="#fff" stroke="INK" stroke-width="3"/><circle cx="32" cy="32" r="15" fill="#c1440e" stroke="INK" stroke-width="2.5"/><circle cx="32" cy="32" r="8" fill="#fff" stroke="INK" stroke-width="2.5"/><circle cx="32" cy="32" r="3" fill="#c1440e"/><path d="M32 32l18-18M44 12l6 2 2 6" fill="none" stroke="INK" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>') },
  { id: 'clip', name: 'Paper Clip', hint: 'Collect 100 paper clips', stat: 'clips', need: 100,
    art: s('<path d="M26 44V18a6 6 0 0 1 12 0v28a10 10 0 0 1-20 0V22" fill="none" stroke="#9aa5ad" stroke-width="7" stroke-linecap="round"/><path d="M26 44V18a6 6 0 0 1 12 0v28a10 10 0 0 1-20 0V22" fill="none" stroke="#dfe5ea" stroke-width="3" stroke-linecap="round"/>') },
  { id: 'hoard', name: 'Clip Hoarder', hint: 'Collect 1,000 paper clips', stat: 'clips', need: 1000,
    art: s('<path d="M14 50l8-20h20l8 20z" fill="#d9c39a" stroke="INK" stroke-width="3" stroke-linejoin="round"/><path d="M22 30c0-8 4-14 10-14s10 6 10 14" fill="none" stroke="#9aa5ad" stroke-width="4"/><path d="M27 30c0-6 2-10 5-10s5 4 5 10" fill="none" stroke="#c3cad1" stroke-width="3"/><path d="M20 42h24" stroke="INK" stroke-width="2.5" stroke-linecap="round"/>') },
  { id: 'duct', name: 'Duct Rat', hint: 'Take a duct shortcut', stat: 'ducts', need: 1,
    art: s('<rect x="8" y="22" width="40" height="20" fill="#b9c1c9" stroke="INK" stroke-width="3"/><path d="M16 22v20M26 22v20M36 22v20" stroke="#8a949c" stroke-width="2"/><ellipse cx="50" cy="32" rx="7" ry="11" fill="#5b6266" stroke="INK" stroke-width="3"/><circle cx="50" cy="30" r="2" fill="#f2c94c"/><circle cx="54" cy="30" r="2" fill="#f2c94c"/>') },
  { id: 'window', name: 'Window Washer', hint: 'Take a window shortcut', stat: 'windows', need: 1,
    art: s('<rect x="12" y="10" width="40" height="44" fill="#bfe0ea" stroke="INK" stroke-width="3"/><path d="M32 10v44M12 32h40" stroke="INK" stroke-width="3"/><path d="M17 26l7-10M38 48l8-11" stroke="#fff" stroke-width="3" stroke-linecap="round"/><path d="M40 20l12 4-12 4z" fill="#f6efdc" stroke="INK" stroke-width="2" stroke-linejoin="round"/>') },
  { id: 'coffee', name: 'Coffee Break', hint: 'Finish a race on the Break Room', stat: 'f_breakroom', need: 1,
    art: s('<path d="M14 24h30v16a12 12 0 0 1-12 12h-6a12 12 0 0 1-12-12z" fill="#fff" stroke="INK" stroke-width="3"/><path d="M44 28h4a6 6 0 0 1 0 12h-5" fill="none" stroke="INK" stroke-width="3"/><path d="M17 29h24" stroke="#8b5a2b" stroke-width="4"/><path d="M24 18q-3-4 0-8M32 18q-3-4 0-8" fill="none" stroke="INK" stroke-width="2.5" stroke-linecap="round"/>') },
  { id: 'plug', name: 'Plugged In', hint: 'Land on a zone in the Server Room', stat: 'z_servers', need: 1,
    art: s('<rect x="18" y="20" width="28" height="22" rx="4" fill="#6fe08a" stroke="INK" stroke-width="3"/><path d="M26 20v-9M38 20v-9" stroke="INK" stroke-width="4" stroke-linecap="round"/><path d="M32 42v12" stroke="INK" stroke-width="4" stroke-linecap="round"/><path d="M30 26l-4 7h6l-4 7" fill="none" stroke="#fff" stroke-width="2.5" stroke-linejoin="round"/>') },
  { id: 'tie', name: 'Corner Office', hint: 'Land on a zone in the Executive Suite', stat: 'z_executive', need: 1,
    art: s('<path d="M26 10h12l-3 8h-6z" fill="#8b3a2e" stroke="INK" stroke-width="3" stroke-linejoin="round"/><path d="M29 18h6l7 26-10 10-10-10z" fill="#c1440e" stroke="INK" stroke-width="3" stroke-linejoin="round"/><path d="M27 30l10-4M25 40l14-6" stroke="#f2c94c" stroke-width="2.5"/>') },
  { id: 'pigeon', name: 'Park Pigeon', hint: 'Fly down into the Rooftop park', stat: 'park', need: 1,
    art: s('<ellipse cx="30" cy="36" rx="16" ry="11" fill="#a3a8b2" stroke="INK" stroke-width="3"/><circle cx="44" cy="24" r="8" fill="#8a8f9a" stroke="INK" stroke-width="3"/><path d="M51 23l6 2-6 2" fill="#e0a526" stroke="INK" stroke-width="2" stroke-linejoin="round"/><circle cx="45" cy="22" r="1.8" fill="INK"/><path d="M20 33q8 6 16 0" fill="none" stroke="#6b7280" stroke-width="3"/><path d="M26 47v6M34 47v6" stroke="#e0a526" stroke-width="3" stroke-linecap="round"/>') },
  { id: 'leaf', name: 'Clean Through', hint: 'Cross the Rooftop park without touching a tree or bird', stat: 'parkClean', need: 1,
    art: s('<path d="M14 50C14 24 30 12 52 12c0 24-14 38-38 38z" fill="#6d9445" stroke="INK" stroke-width="3" stroke-linejoin="round"/><path d="M14 50L42 22M26 38l-1-9M34 30l-1-8M30 34l9 1M38 26l8 1" fill="none" stroke="#3f6b35" stroke-width="2.5" stroke-linecap="round"/>') },
  { id: 'swirl', name: 'Ring Leader', hint: 'Fly through 10 wind rings', stat: 'rings', need: 10,
    art: s('<circle cx="32" cy="32" r="21" fill="none" stroke="#8fd0ea" stroke-width="8"/><circle cx="32" cy="32" r="21" fill="none" stroke="INK" stroke-width="2.5" stroke-dasharray="10 6"/><path d="M14 34q10-8 18 0t18 0" fill="none" stroke="INK" stroke-width="3" stroke-linecap="round"/>') },
  { id: 'goldring', name: 'Gold Hoop', hint: 'Fly through a gold side ring', stat: 'goldRings', need: 1,
    art: s('<circle cx="32" cy="32" r="20" fill="none" stroke="#f2c94c" stroke-width="9"/><circle cx="32" cy="32" r="24.5" fill="none" stroke="INK" stroke-width="2.5"/><circle cx="32" cy="32" r="15.5" fill="none" stroke="INK" stroke-width="2.5"/><path d="M20 22l4 3M44 42l-4-3" stroke="#fff" stroke-width="3" stroke-linecap="round"/>') },
  { id: 'cloud', name: 'Tailwind', hint: 'Ride 5 tailwind streams', stat: 'streams', need: 5,
    art: s('<path d="M18 44a10 10 0 0 1 1-20 13 13 0 0 1 25-2 9 9 0 0 1 3 22z" fill="#fff" stroke="INK" stroke-width="3" stroke-linejoin="round"/><path d="M6 52h22q6 0 6-5M10 58h28" fill="none" stroke="#8fd0ea" stroke-width="3.5" stroke-linecap="round"/>') },
  { id: 'flame', name: 'On Fire', hint: 'Build a trick chain to x5', stat: 'chain5', need: 1,
    art: s('<path d="M32 56c-12 0-18-8-18-17 0-10 8-14 8-24 6 4 8 9 8 13 3-3 4-8 3-14 10 6 17 15 17 25 0 9-6 17-18 17z" fill="#f08a2c" stroke="INK" stroke-width="3" stroke-linejoin="round"/><path d="M32 54c-6 0-9-4-9-9 0-5 5-8 6-13 5 4 12 7 12 13 0 5-3 9-9 9z" fill="#f2c94c"/>') },
  { id: 'bolt', name: 'Speed Demon', hint: 'Hit top speed 5 times', stat: 'speed', need: 5,
    art: s('<path d="M36 6L14 36h14l-6 22 24-32H32z" fill="#f2c94c" stroke="INK" stroke-width="3" stroke-linejoin="round"/>') },
  { id: 'loop', name: 'Loop-de-Loop', hint: 'Fly a Full Circle', stat: 'circles', need: 1,
    art: s('<path d="M8 46c14 0 28-4 28-18a10 10 0 0 0-20 0c0 14 18 18 40 18" fill="none" stroke="#1e4d6b" stroke-width="6" stroke-linecap="round"/><path d="M8 46c14 0 28-4 28-18a10 10 0 0 0-20 0c0 14 18 18 40 18" fill="none" stroke="#8fd0ea" stroke-width="2" stroke-linecap="round"/><path d="M50 40l7 6-8 4" fill="none" stroke="INK" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>') },
  { id: 'bandage', name: 'Running on Fumes', hint: 'Land on a zone with a quarter of your health left', stat: 'clutch', need: 1,
    art: s('<rect x="8" y="22" width="48" height="20" rx="10" transform="rotate(-30 32 32)" fill="#e8b98a" stroke="INK" stroke-width="3"/><rect x="24" y="24" width="16" height="16" transform="rotate(-30 32 32)" fill="#f6dcc0" stroke="INK" stroke-width="2"/><circle cx="29" cy="31" r="1.4" fill="INK"/><circle cx="35" cy="33" r="1.4" fill="INK"/><circle cx="31" cy="36" r="1.4" fill="INK"/>') },
  { id: 'ball', name: 'Crumpled', hint: 'Crumple 10 times (it happens)', stat: 'crumples', need: 10,
    art: s('<path d="M32 10l10 5 9 1 3 10 4 9-6 7-2 10-10 2-9 4-8-5-10-2-3-10-4-8 6-8 2-9 9-2z" fill="#f6efdc" stroke="INK" stroke-width="3" stroke-linejoin="round"/><path d="M22 22l8 6 8-8M18 38l10-4 6 8 10-6M30 28l4 6" fill="none" stroke="#b9ad92" stroke-width="2.5" stroke-linecap="round"/>') },
  { id: 'trophy', name: 'Race Winner', hint: 'Win a race', stat: 'wins', need: 1,
    art: s('<path d="M20 10h24v14a12 12 0 0 1-24 0z" fill="#f2c94c" stroke="INK" stroke-width="3" stroke-linejoin="round"/><path d="M20 14h-8a8 8 0 0 0 9 12M44 14h8a8 8 0 0 1-9 12" fill="none" stroke="INK" stroke-width="3"/><path d="M28 36h8v8h-8z" fill="#e0a526" stroke="INK" stroke-width="2.5"/><rect x="20" y="44" width="24" height="8" rx="2" fill="#8b5a2b" stroke="INK" stroke-width="3"/>') },
  { id: 'crown', name: 'Champion', hint: 'Win a whole match', stat: 'matchWins', need: 1,
    art: s('<path d="M10 46l4-26 11 12 7-18 7 18 11-12 4 26z" fill="#f2c94c" stroke="INK" stroke-width="3" stroke-linejoin="round"/><rect x="10" y="46" width="44" height="7" fill="#e0a526" stroke="INK" stroke-width="3"/><circle cx="32" cy="36" r="4" fill="#e2462e" stroke="INK" stroke-width="2"/><circle cx="20" cy="40" r="2.5" fill="#1e4d6b"/><circle cx="44" cy="40" r="2.5" fill="#1e4d6b"/>') },
  { id: 'briefcase', name: 'Middle Manager', hint: 'Get promoted to Manager in a match', stat: 'manager', need: 1,
    art: s('<rect x="10" y="22" width="44" height="30" rx="4" fill="#8b5a2b" stroke="INK" stroke-width="3"/><path d="M24 22v-6h16v6" fill="none" stroke="INK" stroke-width="3"/><path d="M10 34h44" stroke="INK" stroke-width="3"/><rect x="28" y="30" width="8" height="8" fill="#f2c94c" stroke="INK" stroke-width="2"/>') },
  { id: 'ceo', name: 'Top Floor', hint: 'Reach CEO in a match', stat: 'ceo', need: 1,
    art: s('<rect x="18" y="10" width="28" height="44" fill="#1e4d6b" stroke="INK" stroke-width="3"/><path d="M24 18h5M35 18h5M24 26h5M35 26h5M24 34h5M35 34h5" stroke="#f2c94c" stroke-width="3"/><rect x="28" y="42" width="8" height="12" fill="#f6efdc" stroke="INK" stroke-width="2.5"/><path d="M32 10V3l8 3-8 3" fill="#e2462e" stroke="INK" stroke-width="2" stroke-linejoin="round"/>') },
];

// Trick stamps: one for every trick, earned the first time you pull it off.
// Until then the book only shows a riddle-ish hint.
const PLACE = '#8fd0ea', STYLE = '#f2c94c', LAND = '#ef9a7a', NEW = '#b8a6e6';
const TRICK_STAMPS = {
  close:    [STYLE, 'Fly past something with barely an inch to spare', '<path d="M32 18v15"/><circle cx="32" cy="42" r="2.2" fill="INK"/>'],
  doorway:  [PLACE, 'Slip under the top of a doorway', '<path d="M22 46V20h20v26"/><path d="M14 38h28M37 34l5 4-5 4"/>'],
  under:    [PLACE, 'Fly beneath a desk', '<path d="M16 26h32M20 26v18M44 26v18"/><path d="M14 38h28M37 34l5 4-5 4"/>'],
  drafts:   [PLACE, 'Ride two different vents in one flight', '<path d="M24 46V22M18 28l6-6 6 6M40 46V22M34 28l6-6 6 6"/>'],
  hallway:  [PLACE, 'Fly a whole hallway without touching a wall', '<path d="M16 18l10 10v8l-10 10M48 18L38 28v8l10 10M26 28h12M26 36h12"/>'],
  bullseye: [LAND, 'Land dead centre on a target', '<circle cx="32" cy="32" r="12"/><circle cx="32" cy="32" r="5"/><circle cx="32" cy="32" r="1.5" fill="INK"/>'],
  perch:    [LAND, 'Come to rest on top of the furniture', '<rect x="22" y="32" width="20" height="14"/><path d="M19 27l15-5-10 9z" fill="#fff"/>'],
  bank:     [LAND, 'Land on a zone right after a bump', '<path d="M44 18v28"/><path d="M18 22l22 10-22 10"/>'],
  clutch:   [LAND, 'Land on a zone when you are nearly crumpled', '<rect x="17" y="24" width="25" height="16" rx="2"/><path d="M42 29h4v6h-4"/><path d="M20 27h5v10h-5z" fill="#e2462e"/>'],
  window:   [PLACE, 'Leave by one window and come back by another', '<rect x="20" y="18" width="24" height="28"/><path d="M32 18v28M20 32h24"/>'],
  duct:     [PLACE, 'Find a hidden duct and make it through', '<path d="M16 26h26a6 6 0 0 1 0 12H16"/><path d="M23 26v12M31 26v12"/>'],
  circle:   [STYLE, 'Turn all the way around without straightening out', '<path d="M44 30a12 12 0 1 1-4-8"/><path d="M40 15v8h8"/>'],
  ceiling:  [STYLE, 'Hug the ceiling for a while', '<path d="M14 20h36" stroke-width="4"/><path d="M18 29h24M37 25l5 4-5 4"/>'],
  carpet:   [STYLE, 'Skim the floor at speed', '<path d="M14 44h36" stroke-width="4"/><path d="M18 35h24M37 31l5 4-5 4"/>'],
  zigzag:   [STYLE, 'Flip your bank back and forth, fast', '<path d="M15 40l8-14 8 14 8-14 7 11"/>'],
  speed:    [STYLE, 'Hit top speed', '<path d="M35 15L22 34h9l-3 15 15-21h-9z" fill="#fff"/>'],
  stall:    [STYLE, 'Stall out, then dive back up to speed', '<path d="M18 22q14 0 14 10t14 12"/><path d="M41 44h6v-6"/>'],
  hang:     [STYLE, 'Stay in the air for a very long time', '<circle cx="32" cy="34" r="12"/><path d="M32 27v7l6 4M28 17h8"/>'],
  dodge:    [STYLE, 'Just miss something that moves', '<circle cx="32" cy="37" r="4" fill="INK"/><path d="M15 44q17-32 34 0"/><path d="M43 38l6 6-8 1"/>'],
  sweep:    [STYLE, 'Grab five clips in a flash', '<path d="M22 40V24a3 3 0 0 1 6 0v18a5 5 0 0 1-10 0V27M40 40V24a3 3 0 0 1 6 0v18a5 5 0 0 1-10 0V27"/>'],
  slip:     [STYLE, 'Tuck in behind another plane, then pass it', '<path d="M15 38l8-6-8-6M29 38l8-6-8-6M43 38l7-6-7-6"/>'],
  knife:    [NEW, 'Hold a full bank for a while', '<path d="M30 15v34"/><path d="M30 21l12 17H30" fill="#fff"/>'],
  nosedive: [NEW, 'Dive steeply, then pull up before the floor', '<path d="M22 15v21a10 10 0 0 0 20 0v-5"/><path d="M38 34l4-5 4 5"/>'],
  rocket:   [NEW, 'Point the nose up and climb hard', '<path d="M32 14c6 6 8 14 6 24H26c-2-10 0-18 6-24z" fill="#fff"/><path d="M26 38l-5 7h7M38 38l5 7h-7"/><circle cx="32" cy="27" r="3"/>'],
  elevator: [NEW, 'Stay in a vent until it carries you high', '<rect x="20" y="16" width="24" height="32"/><path d="M32 41V24M26 30l6-6 6 6"/>'],
  hoops:    [NEW, 'Thread three wind rings in one flight', '<circle cx="19" cy="32" r="6"/><circle cx="32" cy="32" r="6"/><circle cx="45" cy="32" r="6"/>'],
  windride: [NEW, 'Ride a tailwind stream from start to finish', '<path d="M14 26h22a5 5 0 1 0-5-5M14 34h28a5 5 0 1 1-5 5M14 42h12"/>'],
  edge:     [NEW, 'Slide off something and keep flying', '<path d="M14 30h18v18"/><path d="M27 24q11-6 19 6M44 25l2 6-6 1"/>'],
  quick:    [NEW, 'Throw hard the instant the race starts', '<circle cx="32" cy="35" r="12"/><path d="M32 35l5-6M29 18h6M32 18v5M44 22l3-3"/>'],
  feather:  [NEW, 'Touch down on a zone ever so gently', '<path d="M45 16C27 18 20 32 20 46c11-4 23-14 25-30z" fill="#fff"/><path d="M20 46l16-20"/>'],
  spotless: [NEW, 'Land on a zone without a scratch', '<path d="M30 15l3 10 10 3-10 3-3 10-3-10-10-3 10-3z" fill="#fff"/><path d="M44 37l1 4 4 1-4 1-1 4-1-4-4-1 4-1z" fill="#fff"/>'],
};
const stamp = (color, icon) => s(`<path d="M32 4l4 4 6-2 2 6 6 1-1 6 5 4-4 5 3 5-5 3 1 6-6 1-2 6-6-2-4 4-4-4-6 2-2-6-6-1 1-6-5-3 3-5-4-5 5-4-1-6 6-1 2-6 6 2z" fill="${color}" stroke="INK" stroke-width="2.5" stroke-linejoin="round"/>`
  + `<circle cx="32" cy="32" r="20" fill="#fffdf6" stroke="INK" stroke-width="2"/><g fill="none" stroke="INK" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">${icon}</g>`);
export function addTrickStamps(TRICKS) {
  for (const [id, t] of Object.entries(TRICKS)) {
    const d = TRICK_STAMPS[id];
    if (!d || STICKER_BY_ID[`t_${id}`]) continue;
    const st = { id: `t_${id}`, name: t.label, hint: d[1], stat: `trick_${id}`, need: 1, trick: true, art: stamp(d[0], d[2]) };
    STICKERS.push(st); STICKER_BY_ID[st.id] = st;
  }
}
export const STICKER_BY_ID = Object.fromEntries(STICKERS.map(st => [st.id, st]));

// A die-cut sticker: a white border and a soft ink edge around the art
export function stickerSvg(id, { px } = {}) {
  const st = STICKER_BY_ID[id];
  if (!st) return '';
  const size = px ? ` width="${px}" height="${px}"` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-6 -6 76 76"${size}><defs><filter id="cut-${id}" x="-20%" y="-20%" width="140%" height="140%">`
    + '<feMorphology in="SourceAlpha" operator="dilate" radius="4.5" result="d2"/><feFlood flood-color="#2c2416" flood-opacity="0.45"/><feComposite in2="d2" operator="in" result="edge"/>'
    + '<feMorphology in="SourceAlpha" operator="dilate" radius="3.5" result="d"/><feFlood flood-color="#ffffff"/><feComposite in2="d" operator="in" result="white"/>'
    + '<feMerge><feMergeNode in="edge"/><feMergeNode in="white"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>'
    + `<g filter="url(#cut-${id})">${st.art}</g></svg>`;
}

addTrickStamps(TRICKS);

/* ------------------------------------------------------------ the book --- */

const KEY = 'stickerbook';
const blank = () => ({ got: {}, stats: {}, placed: [], fresh: [] });
let book = null;
const listeners = new Set();

export function loadBook() {
  if (book) return book;
  try { book = { ...blank(), ...JSON.parse(localStorage.getItem(KEY) || '{}') }; } catch { book = blank(); }
  for (const st of STICKERS) if (st.starter) book.got[st.id] = true;
  // (re)check every milestone, so stickers added to the game later unlock from past progress
  for (const st of STICKERS) if (!st.starter && !book.got[st.id] && (book.stats[st.stat] || 0) >= st.need) { book.got[st.id] = true; book.fresh.push(st.id); }
  book.placed = cleanPlaced(book.placed);
  return book;
}
function save() {
  try { localStorage.setItem(KEY, JSON.stringify(book)); } catch {}
  for (const fn of listeners) fn(book);
}
export function onBookChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

const num = (v, a, b, d = 0) => (Number.isFinite(+v) ? Math.max(a, Math.min(b, +v)) : d);
// Keep a placed-stickers list safe to render: known ids, sane numbers, at most 12.
export function cleanPlaced(list) {
  if (!Array.isArray(list)) return [];
  return list.filter(p => p && STICKER_BY_ID[p.id] && Array.isArray(p.p) && Array.isArray(p.n)).slice(0, MAX_ON_PLANE).map(p => ({
    id: p.id,
    p: p.p.slice(0, 3).map(v => num(v, -3, 3)),
    n: p.n.slice(0, 3).map(v => num(v, -1, 1)),
    r: num(p.r, -7, 7), s: num(p.s, 0.5, 1.8, 1),
  }));
}
export function setPlaced(list) { loadBook(); book.placed = cleanPlaced(list); save(); }
export function placed() { return loadBook().placed; }

export function progressOf(id) {
  const st = STICKER_BY_ID[id], b = loadBook();
  if (st.starter) return { got: true, have: 1, need: 1 };
  return { got: !!b.got[id], have: Math.min(st.need, b.stats[st.stat] || 0), need: st.need };
}
export function markSeen() { loadBook(); if (book.fresh.length) { book.fresh = []; save(); } }

// Add one race's (or match's) summary to the book. Returns newly earned stickers.
export function recordStats(add) {
  loadBook();
  for (const [k, v] of Object.entries(add || {})) if (Number.isFinite(v) && v > 0) book.stats[k] = (book.stats[k] || 0) + v;
  const fresh = [];
  for (const st of STICKERS) {
    if (book.got[st.id] || st.starter) continue;
    if ((book.stats[st.stat] || 0) >= st.need) { book.got[st.id] = true; fresh.push(st); book.fresh.push(st.id); }
  }
  save();
  return fresh;
}

// Computer pilots wear a few stickers too
export function randomStickers(rng, n = 3) {
  const out = [];
  const spots = [[-0.42, 0.05, 0.25], [0.42, 0.05, 0.25], [-0.3, 0.06, 0.55], [0.3, 0.06, 0.55], [0, 0.07, 0.6]];
  for (let i = 0; i < n; i++) {
    const st = STICKERS[Math.floor(rng() * STICKERS.length)], sp = spots[Math.floor(rng() * spots.length)];
    out.push({ id: st.id, p: sp, n: [0, 1, 0], r: (rng() - 0.5) * 1.2, s: 0.8 + rng() * 0.5 });
  }
  return out;
}
