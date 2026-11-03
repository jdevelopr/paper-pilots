// setup.js: the match setup picker used by the host lobby and the solo form.
// Golf: pick which floors to play (in building order) and how many races per
// floor. Race: pick a cup (a fixed set of floors, one race each) or Custom,
// which shows the floor checkboxes. The choice is remembered on this device.

import { FLOORS, CUPS } from '../game/floors.js';

const KEY = 'matchSetup';
export const RACE_CHOICES = [1, 2, 3, 4, 5];
export const MODES = [['golf', 'Golf'], ['race', 'Race']];

export function loadSetup() {
  const def = { mode: 'golf', floors: FLOORS.map(f => f.id), races: 3, cup: CUPS[0].id };
  try {
    const s = JSON.parse(localStorage.getItem(KEY));
    const floors = (s?.floors || []).filter(id => FLOORS.some(f => f.id === id));
    return {
      mode: s?.mode === 'race' ? 'race' : 'golf',
      floors: floors.length ? floors : def.floors,
      races: RACE_CHOICES.includes(s?.races) ? s.races : def.races,
      cup: s?.cup === 'custom' || CUPS.some(c => c.id === s?.cup) ? s.cup : def.cup,
    };
  } catch {}
  return def;
}

export function mountSetup(el, name) {
  const cur = loadSetup();
  el.innerHTML = `
    <fieldset class="seg mode-pick">
      <legend>Mode</legend>
      ${MODES.map(([v, t]) => `<label><input type="radio" name="${name}-mode" value="${v}" ${cur.mode === v ? 'checked' : ''}><span>${t}</span></label>`).join('')}
    </fieldset>
    <p class="mode-desc"></p>
    <fieldset class="seg cup-pick">
      <legend>Cup</legend>
      ${CUPS.map(c => `<label title="${c.floors.map(id => FLOORS.find(f => f.id === id).name).join(', ')}"><input type="radio" name="${name}-cup" value="${c.id}" ${cur.cup === c.id ? 'checked' : ''}><span>${c.name}</span></label>`).join('')}
      <label><input type="radio" name="${name}-cup" value="custom" ${cur.cup === 'custom' ? 'checked' : ''}><span>Custom</span></label>
    </fieldset>
    <fieldset class="seg floors-pick">
      <legend>Floors</legend>
      ${FLOORS.map(f => `<label title="${f.name}"><input type="checkbox" name="${name}-fl" value="${f.id}" ${cur.floors.includes(f.id) ? 'checked' : ''}><span><b>${f.label ?? f.number}</b>${f.name}</span></label>`).join('')}
    </fieldset>
    <fieldset class="seg races-pick">
      <legend>Races per floor</legend>
      ${RACE_CHOICES.map(n => `<label><input type="radio" name="${name}-races" value="${n}" ${n === cur.races ? 'checked' : ''}><span>${n}</span></label>`).join('')}
    </fieldset>
    <p class="setup-sum"></p>`;
  const read = () => ({
    mode: el.querySelector(`input[name="${name}-mode"]:checked`)?.value || 'golf',
    cup: el.querySelector(`input[name="${name}-cup"]:checked`)?.value || CUPS[0].id,
    floors: [...el.querySelectorAll(`input[name="${name}-fl"]:checked`)].map(i => i.value),
    races: +(el.querySelector(`input[name="${name}-races"]:checked`)?.value || 3),
  });
  const sum = () => {
    const s = read(), race = s.mode === 'race';
    const custom = race && s.cup === 'custom';
    el.querySelector('.cup-pick').hidden = !race;
    el.querySelector('.floors-pick').hidden = race && !custom;
    el.querySelector('.races-pick').hidden = race;
    el.querySelector('.mode-desc').textContent = race
      ? 'Race to the finish arch. First across wins; crash and the janitor puts you back.'
      : 'Throw for distance and land on the targets. Farther targets pay more.';
    let txt;
    if (race) {
      const cup = CUPS.find(c => c.id === s.cup);
      const ids = cup ? cup.floors : s.floors;
      txt = `${cup ? cup.name : 'Custom Cup'}: ${ids.map(id => FLOORS.find(f => f.id === id).name).join(', ')} · ${ids.length} race${ids.length === 1 ? '' : 's'}`;
    } else txt = `${s.floors.length} floor${s.floors.length === 1 ? '' : 's'} × ${s.races} = ${s.floors.length * s.races} race${s.floors.length * s.races === 1 ? '' : 's'}`;
    el.querySelector('.setup-sum').textContent = txt;
    try { localStorage.setItem(KEY, JSON.stringify(s)); } catch {}
  };
  el.addEventListener('change', e => {
    // At least one floor has to stay picked
    if (e.target.name === `${name}-fl` && !read().floors.length) e.target.checked = true;
    sum();
  });
  sum();
  return { read };
}
