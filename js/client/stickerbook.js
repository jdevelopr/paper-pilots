// stickerbook.js: the sticker book overlay. Open it from the home screen, the
// phone lobby or the hangar. Pick a sticker you've earned, then tap your plane
// to stick it on. Tap a sticker on the plane to move it (drag), turn it, resize
// it or peel it off. Locked stickers show what earns them.

import { STICKERS, MAX_ON_PLANE, stickerSvg, loadBook, placed, setPlaced, progressOf, markSeen } from '../shared/stickers.js';
import { esc, toast, vibrate } from '../ui.js';

let el = null, preview = null, look = null, list = [], armed = null, sel = -1, drag = null, onClose = null;

const ICONS = {
  ccw: '<path d="M8 7H4V3M4.6 7.4A8 8 0 1 1 4 12" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>',
  cw: '<path d="M16 7h4V3M19.4 7.4A8 8 0 1 0 20 12" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>',
  minus: '<path d="M5 12h14" stroke="currentColor" stroke-width="3" stroke-linecap="round"/>',
  plus: '<path d="M5 12h14M12 5v14" stroke="currentColor" stroke-width="3" stroke-linecap="round"/>',
  peel: '<path d="M5 5h10l4 4v10H5z" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round"/><path d="M15 5v4h4M9 13l6 4M15 13l-6 4" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>',
};
const ico = k => `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[k]}</svg>`;

function build() {
  el = document.createElement('div');
  el.className = 'sb';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'true');
  el.setAttribute('aria-label', 'Sticker book');
  el.innerHTML = `
    <div class="sb-card note">
      <div class="sb-head"><h2>Sticker book</h2><span class="sb-count"></span><button class="btn small sb-close">Done</button></div>
      <div class="sb-stage">
        <canvas class="sb-canvas" aria-label="Your plane. Tap to place the chosen sticker, drag to spin"></canvas>
        <span class="sb-on"></span>
        <p class="sb-tip" aria-live="polite"></p>
        <div class="sb-tools" hidden>
          <button class="sb-t" data-a="ccw" aria-label="Turn left">${ico('ccw')}</button>
          <button class="sb-t" data-a="cw" aria-label="Turn right">${ico('cw')}</button>
          <button class="sb-t" data-a="minus" aria-label="Smaller">${ico('minus')}</button>
          <button class="sb-t" data-a="plus" aria-label="Bigger">${ico('plus')}</button>
          <button class="sb-t peel" data-a="peel" aria-label="Peel off">${ico('peel')}<span>Peel off</span></button>
        </div>
      </div>
      <div class="sb-grid" role="list"></div>
    </div>`;
  document.body.appendChild(el);
  el.querySelector('.sb-close').onclick = close;
  el.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });
  for (const b of el.querySelectorAll('.sb-t')) b.onclick = () => tool(b.dataset.a);
}

function paint() {
  const b = loadBook();
  const got = STICKERS.filter(s => progressOf(s.id).got).length;
  el.querySelector('.sb-count').textContent = `${got} of ${STICKERS.length} collected`;
  el.querySelector('.sb-on').textContent = `${list.length}/${MAX_ON_PLANE} on your plane`;
  el.querySelector('.sb-tools').hidden = sel < 0;
  el.querySelector('.sb-tip').textContent = armed ? 'Tap your plane to stick it on'
    : sel >= 0 ? 'Drag it to move it' : list.length ? 'Pick a sticker, or tap one on your plane' : 'Pick a sticker below';
  const grid = el.querySelector('.sb-grid');
  const firstTrick = STICKERS.find(s => s.trick)?.id;
  const tricksGot = STICKERS.filter(s => s.trick && progressOf(s.id).got).length, tricksAll = STICKERS.filter(s => s.trick).length;
  grid.innerHTML = '<h3 class="sb-sec">Stickers</h3>' + STICKERS.map(s => {
    const pr = progressOf(s.id);
    const fresh = b.fresh.includes(s.id);
    const head = s.id === firstTrick ? `<h3 class="sb-sec">Trick stamps <small>${tricksGot} of ${tricksAll} discovered</small></h3>` : '';
    return `${head}<button role="listitem" class="sb-cell${pr.got ? '' : ' locked'}${armed === s.id ? ' armed' : ''}" data-id="${s.id}"
      aria-label="${s.trick && !pr.got ? 'Undiscovered trick' : esc(s.name)}${pr.got ? '' : `, locked: ${esc(s.hint)}`}" aria-pressed="${armed === s.id}">
      <span class="sb-art">${stickerSvg(s.id)}</span>
      <span class="sb-name">${s.trick && !pr.got ? '???' : esc(s.name)}</span>
      ${pr.got ? '' : `<span class="sb-hint">${esc(s.hint)}${pr.need > 1 ? ` <b>${pr.have}/${pr.need}</b>` : ''}</span>`}
      ${fresh ? '<span class="sb-new">New!</span>' : ''}
    </button>`;
  }).join('');
  for (const c of grid.querySelectorAll('.sb-cell')) c.onclick = () => {
    const id = c.dataset.id;
    if (!progressOf(id).got) { toast(STICKERS.find(s => s.id === id).hint, 2200); return; }
    armed = armed === id ? null : id;
    select(-1);
    vibrate(8);
    paint();
  };
}

function show() {
  if (!preview || preview === 'loading') return;
  preview.set(look.seat, look.owned, look.rank, list);
  preview.select(sel);
}
function select(i) { sel = i; if (preview && preview !== 'loading') preview.select(i); }
function commit() { setPlaced(list); }

function tool(a) {
  const st = list[sel];
  if (!st) return;
  if (a === 'ccw') st.r += 0.3;
  else if (a === 'cw') st.r -= 0.3;
  else if (a === 'minus') st.s = Math.max(0.5, +(st.s - 0.15).toFixed(2));
  else if (a === 'plus') st.s = Math.min(1.8, +(st.s + 0.15).toFixed(2));
  else if (a === 'peel') { list.splice(sel, 1); select(-1); }
  vibrate(8);
  show(); commit(); paint();
}

// Pointer handling on the plane preview (returns true when it takes the gesture)
const interact = {
  down(e) {
    const h = preview.pick(e.clientX, e.clientY);
    if (!h) return false;
    if (armed && h.surf) {
      if (list.length >= MAX_ON_PLANE) { toast(`${MAX_ON_PLANE} stickers max. Peel one off first.`, 2400); return true; }
      list.push({ id: armed, p: h.surf.p, n: h.surf.n, r: (Math.random() - 0.5) * 0.5, s: 1 });
      armed = null;
      select(list.length - 1);
      drag = { i: sel };
      vibrate([10, 20, 14]);
      show(); paint();
      return true;
    }
    if (h.sticker >= 0) { select(h.sticker); drag = { i: h.sticker }; vibrate(6); paint(); return true; }
    if (sel >= 0) { select(-1); paint(); }
    return false;
  },
  move(e) {
    if (!drag) return false;
    const h = preview.pick(e.clientX, e.clientY);
    if (h?.surf && list[drag.i]) { list[drag.i].p = h.surf.p; list[drag.i].n = h.surf.n; show(); }
    return true;
  },
  up() { if (drag) { drag = null; commit(); } },
};

export function openStickerBook(planeLook, { onClosed } = {}) {
  if (!el) build();
  look = { seat: 0, owned: [], rank: 0, ...planeLook };
  list = placed().map(p => ({ ...p, p: [...p.p], n: [...p.n] }));
  armed = null; sel = -1; drag = null; onClose = onClosed || null;
  el.classList.add('on');
  document.body.classList.add('sb-open');
  paint();
  if (!preview) {
    preview = 'loading';
    import('../host/render3d.js').then(m => {
      preview = m.createPlanePreview(el.querySelector('.sb-canvas'), { reduceMotion: matchMedia('(prefers-reduced-motion: reduce)').matches });
      preview.setInteract(interact);
      preview.editing(true);
      show();
    }).catch(() => { preview = null; });
  } else { preview.editing(true); show(); preview.resize(); }
  setTimeout(() => el.querySelector('.sb-close').focus(), 50);
}

function close() {
  el.classList.remove('on');
  document.body.classList.remove('sb-open');
  markSeen();
  onClose?.();
}
