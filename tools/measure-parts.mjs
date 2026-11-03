// tools/measure-parts.mjs: measure what each part is worth, per floor and mode,
// at Mk I / III / V, and write js/game/part-values.js (used by botPlanShop).
//   node tools/measure-parts.mjs race   then   node tools/measure-parts.mjs golf
// Each run takes a few minutes. Rerun after big physics or floor changes.
const R = new URL('../js/', import.meta.url).href;
const S = await import(R + 'game/sim.js');
const { createBot, botAim, botSteer, mulberry32 } = await import(R + 'game/bot.js');
const { makeFloor, FLOORS } = await import(R + 'game/floors.js');
const { UPGRADES } = await import(R + 'shared/upgrades.js');
const fs = await import('fs');
const mode = process.argv[2] === 'golf' ? 'golf' : 'race', seeds = mode === 'race' ? [11, 23] : [11, 23, 37, 51];
function fly(owned, f, seed) {
  const floor = makeFloor(f, seed, mode);
  const race = S.createRace(floor, [{ seat: 0, owned }]);
  const b = createBot(0, 0.9, mulberry32(seed)); b.race = mode === 'race';
  race.t = 0.05; S.throwPlane(race, 0, botAim(b, floor, race.planes[0]));
  let i = 0, crumples = 0;
  while (!race.over && i++ < 60 * 300) {
    const p = race.planes[0];
    if (p.state === 'fly') { const s = botSteer(b, race, p); S.steer(race, 0, s.x, s.y); }
    S.stepRace(race);
    for (const e of race.events) if (e.name === 'crumple') crumples++;
    race.events.length = 0;
  }
  const p = race.planes[0];
  if (mode === 'race') return { v: p.finished ? p.finishedAt : race.timeLimit + 20, crumples };
  const st = S.standings(race)[0];
  return { v: st.score.total + (st.clips + st.trickClips) * 0.05, crumples };
}
const out = { mode, floors: {}, base: {} };
for (const f of FLOORS) {
  const base = seeds.map(s => fly([], f, s));
  out.base[f.id] = base.reduce((a, r) => a + r.v, 0) / seeds.length;
  out.floors[f.id] = {};
  for (const u of UPGRADES) {
    out.floors[f.id][u.id] = [1, 3, 5].map(lv => {
      const rs = seeds.map(s => fly(Array(lv).fill(u.id), f, s));
      const avg = rs.reduce((a, r) => a + r.v, 0) / seeds.length;
      // value: race = seconds saved; golf = points gained
      return +(mode === 'race' ? out.base[f.id] - avg : avg - out.base[f.id]).toFixed(2);
    });
  }
  console.log(mode, f.id, 'done');
}
// Blend each floor half-and-half with the all-floor average (less noise), and
// write it into part-values.js alongside the other mode's numbers.
const file = new URL('../js/game/part-values.js', import.meta.url);
const { PART_VALUE } = await import(file.href);
const fl = Object.keys(out.floors), ids = Object.keys(out.floors[fl[0]]);
const avg = Object.fromEntries(ids.map(id => [id, [0, 1, 2].map(i => fl.reduce((a, f) => a + out.floors[f][id][i], 0) / fl.length)]));
PART_VALUE[mode] = Object.fromEntries(fl.map(f => [f, Object.fromEntries(ids.map(id => [id, [0, 1, 2].map(i => +(0.5 * out.floors[f][id][i] + 0.5 * avg[id][i]).toFixed(2))]))]));
const head = fs.readFileSync(file, 'utf8').split('export const PART_VALUE')[0];
fs.writeFileSync(file, head + 'export const PART_VALUE = ' + JSON.stringify(PART_VALUE) + ';\n');
