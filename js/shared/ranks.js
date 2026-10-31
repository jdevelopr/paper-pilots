// ranks.js: the career ladder, shared by the host (rules, visuals) and the
// phone (shop locks, progress bar).
//
// Career ladder. Every clip a pilot earns in a match counts toward promotion.
// Each rung costs roughly 1.6x the one before, so the first promotions come
// quickly and the top is a real achievement. In simulated 5-floor matches,
// solid computer pilots finish around Supervisor/Manager (130-290 clips);
// Director and above take consistently landing far zones, and CEO needs a
// near-perfect run on the high-paying upper floors.
export const RANKS = [
  { title: 'Intern', at: 0 }, { title: 'Temp', at: 30 }, { title: 'Associate', at: 80 },
  { title: 'Supervisor', at: 160 }, { title: 'Manager', at: 280 }, { title: 'Director', at: 450 },
  { title: 'VP', at: 700 }, { title: 'CEO', at: 1000 },
];
export function rankOf(career = 0) {
  let i = 0;
  while (i + 1 < RANKS.length && career >= RANKS[i + 1].at) i++;
  const next = RANKS[i + 1];
  return { level: i, title: RANKS[i].title, next: next ? next.title : null, toNext: next ? next.at - career : 0,
    progress: next ? (career - RANKS[i].at) / (next.at - RANKS[i].at) : 1 };
}

// Rank levels by name, for readable requirements.
export const RANK = Object.fromEntries(RANKS.map((r, i) => [r.title, i]));

// What each promotion unlocks. Shown when someone is promoted and in the shop.
//   Upgrade levels: III needs Supervisor, IV needs Manager, V needs Director.
//   Specialty keystones need Associate; their branch upgrades need Supervisor.
//   Extras need Temp.
//   Every title also changes the paper your plane is folded from.
export const RANK_UNLOCKS = [
  'Plain copy paper',
  'Extras unlocked · Lined notebook paper',
  'Specialty paths unlocked · Graph paper',
  'Level III upgrades and branch upgrades unlocked · Legal pad',
  'Level IV upgrades unlocked · Kraft paper',
  'Level V upgrades unlocked · Blueprint paper',
  'Silver foil paper',
  'Gold foil paper',
];
