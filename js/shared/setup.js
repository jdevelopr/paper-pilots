// setup.js: the match setup picker used by the host lobby and the solo form.
// Pick which floors to play (in building order) and how many races per floor.
// The choice is remembered on this device.

import { FLOORS } from '../game/floors.js';

const KEY = 'matchSetup';
export const RACE_CHOICES = [1, 2, 3, 4, 5];

export function loadSetup() {
  try {
    const s = JSON.parse(localStorage.getItem(KEY));
    const floors = (s?.floors || []).filter(id => FLOORS.some(f => f.id === id));
    if (floors.length && RACE_CHOICES.includes(s.races)) return { floors, races: s.races };
  } catch {}
  return { floors: FLOORS.map(f => f.id), races: 3 };
}

export function mountSetup(el, name) {
  const cur = loadSetup();
  el.innerHTML = `
    <fieldset class="seg floors-pick">
      <legend>Floors</legend>
      ${FLOORS.map(f => `<label title="${f.name}"><input type="checkbox" name="${name}-fl" value="${f.id}" ${cur.floors.includes(f.id) ? 'checked' : ''}><span><b>${f.number}</b>${f.name}</span></label>`).join('')}
    </fieldset>
    <fieldset class="seg">
      <legend>Races per floor</legend>
      ${RACE_CHOICES.map(n => `<label><input type="radio" name="${name}-races" value="${n}" ${n === cur.races ? 'checked' : ''}><span>${n}</span></label>`).join('')}
    </fieldset>
    <p class="setup-sum"></p>`;
  const read = () => ({
    floors: [...el.querySelectorAll(`input[name="${name}-fl"]:checked`)].map(i => i.value),
    races: +(el.querySelector(`input[name="${name}-races"]:checked`)?.value || 3),
  });
  const sum = () => {
    const s = read();
    el.querySelector('.setup-sum').textContent = `${s.floors.length} floor${s.floors.length === 1 ? '' : 's'} × ${s.races} = ${s.floors.length * s.races} race${s.floors.length * s.races === 1 ? '' : 's'}`;
    localStorage.setItem(KEY, JSON.stringify(s));
  };
  el.addEventListener('change', e => {
    // At least one floor has to stay picked
    if (e.target.name === `${name}-fl` && !read().floors.length) e.target.checked = true;
    sum();
  });
  sum();
  return { read };
}
