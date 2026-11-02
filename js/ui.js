// ui.js: small DOM helpers shared by host and client screens.
import { colorFor } from './shared/colors.js';

export const $ = s => document.querySelector(s);
export const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

// One data-screen attribute on <body> drives which section is visible.
let leaving = null;
export async function show(name) {
  const body = document.body;
  if (body.dataset.screen === name) return;
  if (body.dataset.screen && body.dataset.screen !== 'boot' && !reduceMotion) {
    body.dataset.leaving = body.dataset.screen;
    const token = leaving = {};
    await new Promise(r => setTimeout(r, 170));
    if (leaving !== token) return;
    delete body.dataset.leaving;
  }
  body.dataset.screen = name;
}

let toastTimer = null;
export function toast(msg, ms = 2200) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('on'), ms);
}

export const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const clipIcon = '<svg aria-hidden="true"><use href="#i-clip"/></svg>';
export const planeIcon = '<svg aria-hidden="true"><use href="#i-plane"/></svg>';

// Roster as sticky notes pinned to the cork board. Keyed so existing notes keep
// their DOM (and don't replay the entrance) while new ones animate in.
export function renderRoster(players, max, meSeat = null) {
  const ul = $('#roster');
  const seen = new Set();
  players.forEach((p, i) => {
    const key = `s${p.seat}`;
    seen.add(key);
    let li = ul.querySelector(`[data-key="${key}"]`);
    if (!li) {
      li = document.createElement('li');
      li.dataset.key = key;
      li.className = 'sticky';
      li.style.setProperty('--i', i);
      li.style.setProperty('--r', `${[-3, 2, -1.5, 3, -2, 1][p.seat % 6]}deg`);
      li.innerHTML = `<svg class="pin" aria-hidden="true"><use href="#i-pin"/></svg><span class="nm"></span><span class="st"><svg class="check" aria-hidden="true"><use href="#i-check"/></svg><span class="tx"></span></span>`;
      ul.appendChild(li);
    }
    li.style.setProperty('--c', colorFor(p.seat));
    li.querySelector('.nm').textContent = p.name + (p.seat === meSeat ? ' (you)' : '');
    li.classList.toggle('ready', !!p.ready && p.connected);
    li.classList.toggle('gone', !p.connected);
    li.querySelector('.tx').textContent = !p.connected ? 'Reconnecting…' : p.ready ? 'Ready' : '';
  });
  for (const li of [...ul.querySelectorAll('[data-key]')]) if (!seen.has(li.dataset.key)) li.remove();
  // Dashed empty slots show how many more can join
  ul.querySelectorAll('.empty').forEach(e => e.remove());
  for (let i = players.length; i < max; i++) {
    const li = document.createElement('li');
    li.className = 'sticky empty';
    li.style.setProperty('--r', `${[2, -2, 1, -1][i % 4]}deg`);
    ul.appendChild(li);
  }
}

export function vibrate(p) { try { navigator.vibrate && navigator.vibrate(p); } catch {} }

let lock = null;
export async function keepAwake() {
  try { lock = await navigator.wakeLock.request('screen'); } catch {}
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && lock) keepAwake(); });

/* ---------------------------------------------------- player settings --- */
// Handedness (which side the joystick and slingshot sit on) and graphics
// quality, both remembered on this device.
const getPref = (k, d) => { try { return localStorage.getItem(k) || d; } catch { return d; } };
const setPref = (k, v) => { try { localStorage.setItem(k, v); } catch {} };
export const getHand = () => getPref('hand', 'right');
export function applyHand(h = getHand()) { document.body.classList.toggle('lefty', h === 'left'); }
applyHand();

const GFX = [['auto', 'Auto'], ['high', 'High'], ['medium', 'Medium'], ['low', 'Low'], ['lowest', 'Lowest']];
let prefN = 0;
// A little settings block: handedness (for players) and graphics
export function mountPrefs(el, { hand = true, gfx = true } = {}) {
  if (!el) return;
  const n = ++prefN, h = getHand(), g = getPref('gfx', 'auto');
  el.innerHTML = `${hand ? `<fieldset class="seg prefs-seg"><legend>Controls</legend>
      <label><input type="radio" name="hand${n}" value="right" ${h === 'right' ? 'checked' : ''}><span>Right-handed</span></label>
      <label><input type="radio" name="hand${n}" value="left" ${h === 'left' ? 'checked' : ''}><span>Left-handed</span></label></fieldset>` : ''}
    ${gfx ? `<fieldset class="seg prefs-seg"><legend>Graphics</legend>
      ${GFX.map(([v, t]) => `<label><input type="radio" name="gfx${n}" value="${v}" ${g === v ? 'checked' : ''}><span>${t}</span></label>`).join('')}</fieldset>` : ''}`;
  for (const r of el.querySelectorAll(`input[name="hand${n}"]`)) r.onchange = () => { setPref('hand', r.value); applyHand(r.value); vibrate(8); };
  for (const r of el.querySelectorAll(`input[name="gfx${n}"]`)) r.onchange = () => { setPref('gfx', r.value); window.__ppGfx?.(r.value); vibrate(8); };
}
