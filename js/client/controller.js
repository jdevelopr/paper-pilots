// controller.js: the player's controller. On a phone it fills the screen; in solo
// mode it docks in the corner of the desktop. It holds no game state of its own:
// it renders whatever the host last said and sends intent back.
//
// Touch: pull back on the pad to throw (slingshot), joystick to fly.
// Keyboard: arrows aim, up/down angle, hold Space to throw; WASD/arrows to fly.

import { esc, clipIcon, planeIcon, vibrate, keepAwake } from '../ui.js';
import { colorFor } from '../shared/colors.js';
import { RANK_UNLOCKS } from '../shared/ranks.js';
import { recordStats, placed, onBookChange } from '../shared/stickers.js';
import { openStickerBook } from './stickerbook.js';
import { statBars, MAX_LEVEL, MK, UPGRADES, UPGRADE_BY_ID, SLOTS, SLOT_BY_ID, partState, equippedList, metalOf } from '../shared/upgrades.js';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const ITEM_NAMES = { donut: 'Donut: thrust', card: 'Index Card: invincible', glue: 'Glue Bottle: clip magnet', chipclip: 'Chip Bag Clip: clips +2' };

export function mountController(root, link, { solo = false, onAgain = null, onMenu = null } = {}) {
  root.innerHTML = `
    <div class="cv" data-v="wait"><div class="cfill"><div><h3 class="w-t">Watch the screen</h3></div></div></div>
    <div class="cv" data-v="intro"><div class="cfill"><div><div class="csub i-floor"></div><h3 class="i-name"></h3><div class="cbig i-count"></div></div></div></div>
    <div class="cv" data-v="aim">
      <div class="aim-count" aria-live="assertive"></div>
      <div class="chead"><span class="cname"></span><span class="cclips">${clipIcon}<span class="n">0</span></span></div>
      <div class="aim">
        <div class="angle"><span class="ang-v">12°</span><input class="vrange" type="range" min="0" max="34" step="1" value="12" aria-label="Throw angle"><span>Angle</span></div>
        <div class="pad" aria-label="Pull back and let go to throw">
          <div class="pw"><i></i></div>
          <svg class="band" aria-hidden="true"><line class="b1" stroke="#2c2416" stroke-width="3"/><line class="b2" stroke="#2c2416" stroke-width="3"/></svg>
          <svg class="pplane" viewBox="0 0 64 64" aria-hidden="true"><use href="#i-plane"/></svg>
          <div class="padlbl">Pull back, let go</div>
        </div>
      </div>
    </div>
    <div class="cv" data-v="fly">
      <div class="chead"><span class="cname"></span><span class="cclips">${clipIcon}<span class="n">0</span></span></div>
      <div class="fly">
        <div class="hpbar"><i></i></div>
        <div class="stick" aria-label="Steer: drag up to climb, down to dive, left and right to turn">
          <svg class="arrows" viewBox="0 0 100 100" aria-hidden="true"><path d="M50 7l-7 8h14zM50 93l-7-8h14zM7 50l8-7v14zM93 50l-8-7v14z"/></svg>
          <span class="lbl u">climb</span><span class="lbl d">dive</span><div class="thumb"></div></div>
      </div>
    </div>
    <div class="cv" data-v="landed">
      <div class="chead"><span class="cname"></span><span class="cclips">${clipIcon}<span class="n">0</span></span></div>
      <div class="landed-card"><div class="zl"></div><div class="zp"></div><div class="zb"></div></div>
    </div>
    <div class="cv" data-v="results">
      <div class="chead"><span class="cname"></span><span class="cclips">${clipIcon}<span class="n">0</span></span></div>
      <div class="cfill r-fill"><div><div class="cbig r-place"></div><h3 class="r-zone"></h3><div class="csub r-brk"></div><div class="r-promo"></div></div></div>
      <div class="crank"><span class="ck-t"></span><i><b></b></i></div>
    </div>
    <div class="cv" data-v="shop">
      <div class="chead"><span class="cname"></span><span class="hg-title">Hangar</span><button class="btn small hg-stk" aria-label="Sticker book">Stickers</button><span class="ctimer"></span><span class="cclips">${clipIcon}<span class="n">0</span></span></div>
      <div class="crank"><span class="ck-t"></span><i><b></b></i></div>
      <div class="hangar">
        <div class="hg-stage"><canvas class="hg-canvas" aria-label="Your plane, drag to spin"></canvas><span class="hg-tip">Drag to spin</span><span class="hg-build"></span></div>
        <div class="hg-slots" role="tablist" aria-label="Plane slots"></div>
        <div class="hg-side">
          <div class="stats"></div>
          <h4 class="hg-slotname"></h4>
          <div class="shoplist"></div>
        </div>
      </div>
      <button class="btn primary s-done">Done</button>
    </div>
    <div class="cv" data-v="final">
      <div class="cfill f-fill"><div><div class="csub">Final</div><div class="cbig f-place"></div><h3 class="f-pts"></h3></div></div>
      <div class="f-btns" ${onAgain ? '' : 'hidden'}><button class="btn ghost f-menu">Menu</button><button class="btn primary f-again">Play again</button></div>
    </div>`;

  const q = s => root.querySelector(s);
  const qa = s => [...root.querySelectorAll(s)];
  let view = null;
  let phase = { phase: 'lobby' };
  let me = { seat: link.seat ?? 0, name: '', clips: 0, owned: [], state: 'none', hp: 100, maxHp: 100 };
  let phaseAt = 0;      // local time the last phase message arrived
  let landed = null;
  let enabled = false;  // no input until the host says the race is on

  function setView(v) {
    if (v === view) return;
    view = v;
    root.dataset.view = v;   // lets solo mode tuck the panel away mid-flight
    qa('.cv').forEach(el => el.classList.toggle('on', el.dataset.v === v));
    if (v === 'aim') resetAim();
    if (v === 'fly') resetStick();
  }

  function paintHeader() {
    const c = colorFor(me.seat);
    root.style.setProperty('--c', c);
    qa('.cname').forEach(el => { el.textContent = me.name; el.style.setProperty('--c', c); });
    qa('.cclips .n').forEach(el => {
      const v = String(phase.phase === 'race' ? me.run ?? 0 : me.clips);
      if (el.textContent !== v) {
        el.textContent = v;
        const p = el.parentElement; p.classList.remove('bump'); void p.offsetWidth; p.classList.add('bump');
      }
    });
  }

  // Get set: for the last few seconds of the countdown your slingshot is live,
  // so you can line up and pull back, then let go on "GO!".
  const GETSET_MS = 3600;
  const goAt = () => phaseAt + (phase.inMs ?? 0);
  const getSet = () => phase.phase === 'intro' && goAt() - performance.now() <= GETSET_MS;
  let pendingThrow = null;

  function decide() {
    const ph = phase.phase;
    enabled = ph === 'race';
    if (ph === 'intro') return setView(getSet() ? 'aim' : 'intro');
    if (ph === 'race') {
      if (me.state === 'held') return setView('aim');
      if (me.state === 'fly' || me.state === 'slide' || me.state === 'fall') return setView('fly');
      if (me.state === 'landed') return setView('landed');
      return setView('wait');
    }
    q('.w-t').textContent = document.body.classList.contains('pv') ? 'Get ready' : 'Watch the screen';
    if (ph === 'results') return setView('results');
    if (ph === 'shop') return setView('shop');
    if (ph === 'final') return setView('final');
    setView('wait');
  }

  /* ------------------------------------------------------------ intro --- */
  let introRaf = 0, lastCount = null;
  function runIntro() {
    cancelAnimationFrame(introRaf);
    q('.i-floor').textContent = `Floor ${phase.floor.label ?? phase.floor.number} · Race ${phase.leg ?? 1} of ${phase.legs ?? 1}`;
    q('.i-name').textContent = phase.floor.name;
    const endAt = phaseAt + phase.inMs;
    const cnt = q('.i-count'), big = q('.aim-count');
    const step = () => {
      const left = endAt - performance.now();
      if (phase.phase === 'intro' && view === 'intro' && getSet()) decide();
      const label = left <= 0 ? 'GO!' : left <= 3000 ? String(Math.ceil(left / 1000)) : left <= GETSET_MS ? 'Get set' : '';
      if (label !== lastCount) {
        lastCount = label;
        for (const el of [cnt, big]) {
          el.textContent = label;
          el.classList.toggle('go', label === 'GO!');
          el.classList.toggle('set', label === 'Get set');
          el.classList.remove('tick'); void el.offsetWidth; if (label) el.classList.add('tick');
        }
        if (label && label !== 'Get set') vibrate(label === 'GO!' ? [40, 30, 60] : 12);
        if (label === 'GO!') setTimeout(() => { if (big.textContent === 'GO!') big.textContent = ''; }, 900);
      }
      if (phase.phase === 'intro' || left > -1000) introRaf = requestAnimationFrame(step);
    };
    step();
  }

  /* -------------------------------------------------------------- aim --- */
  const pad = q('.pad'), pplane = q('.pplane'), pw = q('.pw i'), b1 = q('.b1'), b2 = q('.b2');
  const range = q('.vrange'), angV = q('.ang-v');
  const aim = { yaw: 0, pitch: 12 * Math.PI / 180, power: 0 };
  let aimSentAt = 0, dragging = null;

  function resetAim() { aim.power = 0; dragging = null; drawAim(); }
  range.addEventListener('input', () => {
    aim.pitch = +range.value * Math.PI / 180;
    angV.textContent = `${range.value}°`;
    sendAim();
  });

  function drawAim() {
    const r = pad.getBoundingClientRect();
    const w = r.width || 240, h = r.height || 300;
    const ox = w / 2, oy = h * 0.42;
    const px = ox + (-aim.yaw / 0.45) * w * 0.22 * aim.power * 1.4;
    const py = oy + aim.power * h * 0.36;
    pplane.style.transform = `translate(${px - ox}px, ${py - oy}px) rotate(${-45 + aim.yaw * 90}deg)`;
    pw.style.transform = `scaleX(${aim.power})`;
    const posts = [[w * 0.2, h * 0.38], [w * 0.8, h * 0.38]];
    [b1, b2].forEach((ln, i) => {
      ln.setAttribute('x1', posts[i][0]); ln.setAttribute('y1', posts[i][1]);
      ln.setAttribute('x2', px); ln.setAttribute('y2', py);
      ln.style.opacity = aim.power > 0.02 ? 1 : 0.25;
    });
  }

  function sendAim(force) {
    const now = performance.now();
    if (!force && now - aimSentAt < 66) return;
    aimSentAt = now;
    if (enabled || getSet()) link.input({ k: 'aim', yaw: +aim.yaw.toFixed(3), pitch: +aim.pitch.toFixed(3), power: +aim.power.toFixed(3) });
  }

  function doThrow() {
    if (!enabled && getSet()) {
      if (aim.power < 0.08) { resetAim(); sendAim(true); return; }
      if (goAt() - performance.now() < 350) {
        // let go right on the beat: it flies the moment the race starts
        pendingThrow = { yaw: +aim.yaw.toFixed(3), pitch: +aim.pitch.toFixed(3), power: +aim.power.toFixed(3) };
        return;
      }
      phoneToast('Wait for GO!');
      vibrate([60, 40, 60]);
      resetAim(); sendAim(true);
      return;
    }
    if (!enabled || me.state !== 'held') return;
    if (aim.power < 0.08) { resetAim(); sendAim(true); return; }
    link.input({ k: 'throw', yaw: +aim.yaw.toFixed(3), pitch: +aim.pitch.toFixed(3), power: +aim.power.toFixed(3) });
    vibrate([15, 30, 25]);
    me.state = 'fly';          // optimistic: switch to the stick immediately
    decide();
  }

  pad.addEventListener('pointerdown', e => {
    e.preventDefault();
    pad.setPointerCapture(e.pointerId);
    dragging = { x: e.clientX, y: e.clientY, id: e.pointerId };
    vibrate(8);
  });
  pad.addEventListener('pointermove', e => {
    if (!dragging || e.pointerId !== dragging.id) return;
    const r = pad.getBoundingClientRect();
    const dy = e.clientY - dragging.y, dx = e.clientX - dragging.x;
    aim.power = clamp(dy / (r.height * 0.45), 0, 1);
    aim.yaw = clamp(-dx / (r.width * 0.5), -1, 1) * 0.45;
    drawAim(); sendAim();
  });
  const release = e => {
    if (!dragging || e.pointerId !== dragging.id) return;
    dragging = null;
    if (e.type === 'pointercancel') { resetAim(); sendAim(true); return; }
    doThrow();
  };
  pad.addEventListener('pointerup', release);
  pad.addEventListener('pointercancel', release);

  /* ------------------------------------------------------------ stick --- */
  const stick = q('.stick'), thumb = q('.thumb'), hpbar = q('.hpbar i');
  const st = { x: 0, y: 0 };
  let stickPtr = null, stickSentAt = 0, sentX = 0, sentY = 0;

  function resetStick() { st.x = 0; st.y = 0; drawStick(); sendStick(true); }
  function drawStick() {
    const r = stick.getBoundingClientRect();
    const R = (r.width || 260) * 0.33;
    thumb.style.transform = `translate(${st.x * R}px, ${-st.y * R}px)`;
  }
  function sendStick(force) {
    const now = performance.now();
    if (!force && now - stickSentAt < 50) return;
    if (!force && Math.abs(st.x - sentX) < 0.02 && Math.abs(st.y - sentY) < 0.02) return;
    stickSentAt = now; sentX = st.x; sentY = st.y;
    if (enabled) link.input({ k: 'stick', x: +st.x.toFixed(2), y: +st.y.toFixed(2) });
  }
  function stickFrom(e) {
    const r = stick.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const R = r.width * 0.33;
    let x = (e.clientX - cx) / R, y = -(e.clientY - cy) / R;
    let m = Math.hypot(x, y);
    if (m > 1) { x /= m; y /= m; m = 1; }
    const dead = 0.12;
    if (m < dead) { x = 0; y = 0; } else { const k = (m - dead) / (1 - dead) / m; x *= k; y *= k; }
    st.x = clamp(x, -1, 1); st.y = clamp(y, -1, 1);
    drawStick(); sendStick();
  }
  // The whole fly area is the touch zone (in landscape that's the left side of
  // the screen), so your thumb doesn't have to land exactly on the stick.
  const flyZone = q('.fly');
  flyZone.addEventListener('pointerdown', e => { e.preventDefault(); flyZone.setPointerCapture(e.pointerId); stickPtr = e.pointerId; stick.classList.add('held'); stickFrom(e); vibrate(6); });
  flyZone.addEventListener('pointermove', e => { if (e.pointerId === stickPtr) stickFrom(e); });
  const stickUp = e => { if (e.pointerId !== stickPtr) return; stickPtr = null; stick.classList.remove('held'); st.x = 0; st.y = 0; drawStick(); sendStick(true); };
  flyZone.addEventListener('pointerup', stickUp);
  flyZone.addEventListener('pointercancel', stickUp);

  /* --------------------------------------------------------- keyboard --- */
  const keys = new Set();
  let charging = false, chargeStart = 0;
  const isTyping = () => ['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName) && document.activeElement.type !== 'range';
  window.addEventListener('keydown', e => {
    if (isTyping()) return;
    const k = e.key.toLowerCase();
    if (['arrowup', 'arrowdown', 'arrowleft', 'arrowright', ' '].includes(k)) e.preventDefault();
    if (view === 'aim' && k === ' ' && !e.repeat) { charging = true; chargeStart = performance.now(); }
    keys.add(k);
  });
  window.addEventListener('keyup', e => {
    const k = e.key.toLowerCase();
    keys.delete(k);
    if (k === ' ' && charging) { charging = false; doThrow(); }
  });
  window.addEventListener('blur', () => { keys.clear(); charging = false; });

  let lastKb = performance.now(), kbActive = false;
  function kbLoop(now) {
    const dt = Math.min(0.05, (now - lastKb) / 1000);
    lastKb = now;
    const L = keys.has('arrowleft') || keys.has('a'), R = keys.has('arrowright') || keys.has('d');
    const U = keys.has('arrowup') || keys.has('w'), D = keys.has('arrowdown') || keys.has('s');
    if (view === 'aim') {
      let changed = false;
      if (L || R) { aim.yaw = clamp(aim.yaw + (R ? -1 : 1) * 0.6 * dt * (L && R ? 0 : 1), -0.45, 0.45); changed = true; }
      if (U || D) {
        const v = clamp(+range.value + (U ? 1 : -1) * 30 * dt, 0, 34);
        range.value = v; aim.pitch = v * Math.PI / 180; angV.textContent = `${Math.round(v)}°`; changed = true;
      }
      if (charging) { aim.power = clamp((now - chargeStart) / 1100, 0, 1); changed = true; }
      if (changed) { drawAim(); sendAim(); }
    } else if (view === 'fly' && stickPtr == null) {
      const tx = (R ? 1 : 0) - (L ? 1 : 0), ty = (U ? 1 : 0) - (D ? 1 : 0);
      if (tx || ty || kbActive) {
        kbActive = !!(tx || ty) || Math.abs(st.x) > 0.01 || Math.abs(st.y) > 0.01;
        const a = 1 - Math.exp(-10 * dt);
        st.x += (tx - st.x) * a; st.y += (ty - st.y) * a;
        if (!tx && !ty && Math.abs(st.x) < 0.03 && Math.abs(st.y) < 0.03) { st.x = 0; st.y = 0; }
        drawStick(); sendStick();
      }
    }
    requestAnimationFrame(kbLoop);
  }
  requestAnimationFrame(kbLoop);

  /* ------------------------------------------------------------- shop --- */
  const list = q('.shoplist'), doneBtn = q('.s-done'), stats = q('.stats');
  let shopDone = false, lastShopKey = '';
  // The shop is the plane's loadout: five slots, each with a free stock part
  // and three parts to buy. Bought parts stay in your inventory, so swapping
  // back is free. Each row says what tapping it does and how your stats move.
  const BAR_KEYS = ['Launch', 'Speed', 'Glide', 'Turning', 'Toughness', 'Landing'];
  function deltaText(before, after) {
    const out = [];
    for (const k of BAR_KEYS) {
      const d = after[k] - before[k];
      if (Math.abs(d) < 0.025) continue;
      const n = Math.min(3, Math.ceil(Math.abs(d) / 0.08));
      out.push(`<span class="${d > 0 ? 'up' : 'dn'}">${k} ${(d > 0 ? '▲' : '▼').repeat(n)}</span>`);
    }
    return out.join(' ');
  }
  // Level pips: Mk I-III fill green, Mk IV silver, Mk V gold
  const pipsHtml = lv => `<span class="pips">${Array.from({ length: MAX_LEVEL }, (_, k) => `<i class="${[k < lv ? 'on' : '', k === 3 ? 'p4' : k === 4 ? 'p5' : ''].join(' ').trim()}"></i>`).join('')}</span>`;
  const metalClass = lv => { const m = metalOf(lv); return m ? ` m-${m}` : ''; };
  // What tapping a row would do, and the loadout afterwards
  function actionFor(id) {
    const parts = me.parts || {}, loadout = me.loadout || {};
    if (id.startsWith('stock:')) {
      const slot = id.slice(6);
      const on = !loadout[slot];
      const lo = { ...loadout }; delete lo[slot];
      return { kind: on ? 'on' : 'equip', after: equippedList(parts, lo) };
    }
    const u = UPGRADE_BY_ID[id], lv = parts[id] || 0, equipped = loadout[u.slot] === id;
    if (lv && !equipped) return { kind: 'equip', after: equippedList(parts, { ...loadout, [u.slot]: id }) };
    const st = partState(parts, id, me.rank?.level ?? 0);
    if (st.state === 'maxed') return { kind: 'maxed', after: me.owned };
    if (st.state !== 'open') return { kind: 'locked', reason: st.reason, after: me.owned };
    return { kind: lv ? 'upgrade' : 'buy', cost: st.cost, next: lv + 1, after: equippedList({ ...parts, [id]: lv + 1 }, { ...loadout, [u.slot]: id }) };
  }
  // The hangar: a big turning model of your plane, five slot cards, and the
  // parts for whichever slot you've picked.
  let selSlot = 'paper', preview = null, previewOwned = null;
  const slotsEl = q('.hg-slots'), canvas = q('.hg-canvas');
  function ensurePreview() {
    if (preview) return;
    preview = 'loading';
    import('../host/render3d.js').then(m => {
      preview = m.createPlanePreview(canvas, { reduceMotion: matchMedia('(prefers-reduced-motion: reduce)').matches });
      paintPreview();
    }).catch(() => { preview = null; });
  }
  function paintPreview() {
    if (preview && preview !== 'loading') preview.set(me.seat, previewOwned || me.owned || [], me.rank?.level ?? 0, placed());
  }
  function renderSlots() {
    slotsEl.innerHTML = SLOTS.map(sl => {
      const id = me.loadout?.[sl.id], u = id && UPGRADE_BY_ID[id], lv = u ? (me.parts?.[id] || 1) : 0;
      const pips = u ? pipsHtml(lv) : '';
      const inv = UPGRADES.filter(x => x.slot === sl.id && me.parts?.[x.id]).length;
      return `<button class="hg-slot${sl.id === selSlot ? ' sel' : ''}${u ? ' fitted' : ''}${metalClass(lv)}" role="tab" aria-selected="${sl.id === selSlot}" data-slot="${sl.id}">
        <span class="sl-n">${esc(sl.name)}</span><span class="sl-p">${esc(u ? u.name : sl.stock)}</span>${pips}${inv > (u ? 1 : 0) ? `<span class="sl-inv">${inv} owned</span>` : ''}</button>`;
    }).join('');
    for (const b of slotsEl.querySelectorAll('.hg-slot')) b.onclick = () => {
      if (selSlot === b.dataset.slot) return;
      selSlot = b.dataset.slot; vibrate(8);
      list.innerHTML = ''; renderShop(true);
    };
  }
  function renderShop(force) {
    const key = JSON.stringify([me.clips, me.parts, me.loadout, me.rank?.level, selSlot]);
    if (!force && key === lastShopKey) return;
    lastShopKey = key;
    ensurePreview();
    previewOwned = null; paintPreview();
    const now = statBars(me.owned);
    stats.innerHTML = BAR_KEYS.map(k => `<span>${k}</span><i><b style="transform:scaleX(${now[k].toFixed(2)})"></b></i>`).join('');
    const fold = UPGRADE_BY_ID[me.loadout?.fold];
    q('.hg-build').textContent = fold ? `${fold.name} build` : 'Stock plane';
    renderSlots();
    const sl = SLOT_BY_ID[selSlot];
    q('.hg-slotname').textContent = `${sl.name} parts`;
    if (!list.children.length) {
      [`stock:${sl.id}`, ...UPGRADES.filter(u => u.slot === sl.id).map(u => u.id)].forEach((id, i) => {
        const el = document.createElement('button');
        el.className = 'upg';
        el.dataset.id = id;
        el.style.setProperty('--i', i);
        el.onclick = () => {
          if (el.disabled) return;
          const a = actionFor(id);
          vibrate(10);
          if (a.kind === 'equip') link.input({ k: 'equip', id });
          else if (a.kind === 'buy' || a.kind === 'upgrade') link.input({ k: 'buy', id });
        };
        // Hover (or keyboard focus) a row to see the plane with that part on
        const show = () => { const a = actionFor(id); if (a.after) { previewOwned = a.after; paintPreview(); } };
        const hide = () => { previewOwned = null; paintPreview(); };
        el.addEventListener('pointerenter', e => { if (e.pointerType === 'mouse') show(); });
        el.addEventListener('pointerleave', hide);
        el.addEventListener('focus', show);
        el.addEventListener('blur', hide);
        list.appendChild(el);
      });
    }
    for (const el of list.querySelectorAll('.upg')) {
      const id = el.dataset.id, stock = id.startsWith('stock:');
      const u = stock ? null : UPGRADE_BY_ID[id];
      const lv = stock ? 0 : (me.parts?.[id] || 0);
      const a = actionFor(id);
      const on = stock ? a.kind === 'on' : me.loadout?.[u.slot] === id;
      const afford = (a.kind === 'buy' || a.kind === 'upgrade') ? me.clips >= a.cost : a.kind === 'equip';
      el.classList.toggle('owned', on);
      el.classList.toggle('inv', !on && lv > 0);
      el.classList.toggle('locked', a.kind === 'locked' && !on);
      el.classList.toggle('m-silver', metalOf(lv) === 'silver');
      el.classList.toggle('m-gold', metalOf(lv) === 'gold');
      el.disabled = !afford;
      const pips = stock ? '' : pipsHtml(lv);
      const right = a.kind === 'buy' || a.kind === 'upgrade' ? `<small>${a.kind === 'buy' ? 'Buy' : MK(a.next)}</small>${a.cost}${clipIcon}`
        : a.kind === 'equip' ? '<small>Equip</small>'
        : a.kind === 'locked' ? '<svg aria-hidden="true" class="lock"><use href="#i-lock"/></svg>'
        : on ? '<svg aria-hidden="true"><use href="#i-check"/></svg>' : '';
      const name = stock ? sl.stock : `${u.name}${lv ? ` <span class="mk${metalClass(lv)}">${MK(lv)}</span>` : ''}`;
      const desc = stock ? '<span class="why">Stock part, free</span>'
        : a.kind === 'locked' ? `<b>${esc(u.pro)}</b> · <span class="why">${esc(a.reason)}</span>`
        : `<b>${esc(u.pro)}</b>${u.con ? ` · <em>${esc(u.con)}</em>` : ''}`;
      // The Mk V perk: shown once you're working toward it, lit up once you have it
      const perk = !stock && u.perk && lv >= 3 ? `<span class="perk${lv >= MAX_LEVEL ? ' got' : ''}">${esc(u.perk)}</span>` : '';
      const delta = (a.kind === 'buy' || a.kind === 'upgrade' || a.kind === 'equip') ? deltaText(now, statBars(a.after)) : '';
      el.setAttribute('aria-label', `${stock ? sl.stock : u.name}${lv ? `, ${MK(lv)}` : ''}${on ? ', equipped' : ''}${a.kind === 'locked' ? `, ${a.reason}` : ''}`);
      el.innerHTML = `<span class="un">${name}${pips}</span>
        <span class="uc">${right}</span>
        <span class="ud">${desc}${perk}${delta ? `<span class="delta">${delta}</span>` : ''}</span>`;
    }
  }

  doneBtn.onclick = () => {
    shopDone = !shopDone;
    doneBtn.textContent = shopDone ? 'Back to shop' : 'Done';
    list.style.opacity = shopDone ? 0.5 : 1;
    link.input({ k: shopDone ? 'done' : 'undone' });
    vibrate(12);
  };
  let shopRaf = 0;
  function shopTimer() {
    cancelAnimationFrame(shopRaf);
    const endAt = phaseAt + phase.inMs;
    const t = q('.ctimer');
    const step = () => {
      t.textContent = `${Math.max(0, Math.ceil((endAt - performance.now()) / 1000))}s`;
      if (phase.phase === 'shop') shopRaf = requestAnimationFrame(step);
    };
    step();
  }

  /* -------------------------------------------------------- messages --- */
  function paintLanded() {
    const card = q('.landed-card');
    const z = landed?.zone ?? me.zone;
    const crumpled = landed?.crumpled ?? me.crumpled;
    card.classList.toggle('miss', !z);
    card.style.background = z ? 'var(--paper)' : '';
    q('.zl').innerHTML = crumpled ? 'Crumpled' : z ? `${esc(z.label)}<small>${esc(z.ringName || '')}</small>` : 'Missed';
    q('.zp').innerHTML = z ? `+${z.pay}${clipIcon}` : '';
    const zb = q('.zb');
    const newBest = !crumpled && me.best > 0 && me.dist > me.best;
    zb.classList.toggle('pb', newBest);
    zb.textContent = crumpled ? '' : newBest ? `New best · ${me.dist} ft` : me.best ? `${me.dist} ft · best ${Math.max(me.best, me.dist)} ft` : `${me.dist} ft`;
  }

  // Career ladder: current title, the next one, and a bar toward it.
  function paintRank() {
    const rk = me.rank;
    if (!rk) return;
    qa('.crank').forEach(el => {
      el.querySelector('.ck-t').textContent = rk.next ? `${rk.title} · ${rk.toNext} clips to ${rk.next}` : `${rk.title} · top of the org chart`;
      let nx = el.querySelector('.ck-n');
      if (!nx) { nx = document.createElement('small'); nx.className = 'ck-n'; el.appendChild(nx); }
      nx.textContent = rk.next ? `Next: ${RANK_UNLOCKS[rk.level + 1]}` : '';
      el.querySelector('b').style.transform = `scaleX(${Math.max(0.03, Math.min(1, rk.progress))})`;
    });
  }

  function paintResults() {
    const row = (phase.rows || []).find(r => r.seat === me.seat);
    if (!row) return;
    const ord = ['1st', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th'];
    q('.r-place').textContent = ord[row.place - 1];
    q('.r-zone').textContent = `+${row.earned.total} clips · +${row.points} ${row.points === 1 ? 'pt' : 'pts'}`;
    const extras = [`Distance ${row.distPts ?? 0}`, row.zone && !row.crumpled ? `Target ${row.targetPts ?? 0} (${row.flightT}s, par ${row.par}s)` : '', row.pb ? 'New best' : '', row.earned.tricks ? `Tricks +${row.earned.tricks}` : '', row.zoneStreak >= 2 ? `Zone streak x${row.zoneStreak}` : '', row.cleanStreak >= 2 ? `Clean streak x${row.cleanStreak}` : ''].filter(Boolean);
    q('.r-brk').textContent = [row.crumpled ? 'Crumpled' : row.zone ? `${row.zone}${row.ring ? ` (${row.ring})` : ''}` : 'Missed the zones', ...extras].join(' · ');
    q('.r-promo').innerHTML = row.promoted ? `Promoted to ${esc(row.promoted)}<small>${esc(row.unlock || '')}</small>` : '';
    if (row.promoted) vibrate([30, 60, 30, 60, 120]);
  }
  function paintFinal() {
    const row = (phase.rows || []).find(r => r.seat === me.seat);
    if (!row) return;
    const ord = ['1st', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th'];
    q('.f-place').textContent = ord[row.place - 1];
    q('.f-pts').textContent = `${row.points} ${row.points === 1 ? 'pt' : 'pts'}`;
  }

  // Stickers: tell the host what's on our plane (on every phase, so a
  // reconnect or a new room always has it), and whenever the book changes
  const sendStickers = () => link.input({ k: 'stickers', list: placed() });
  onBookChange(() => { sendStickers(); paintPreview(); });
  if (solo) sendStickers();
  q('.hg-stk').onclick = () => { vibrate(8); openStickerBook({ seat: me.seat, owned: me.owned || [], rank: me.rank?.level ?? 0 }); };

  link.on('event', msg => {
    const d = msg.data;
    if (msg.name === 'fx' && d?.kind === 'stats') {
      for (const st of recordStats(d.s)) {
        setTimeout(() => { phoneToast(`New sticker: ${st.name}!`); vibrate([20, 40, 20, 40, 60]); }, 600);
      }
      return;
    }
    switch (msg.name) {
      case 'phase': {
        const prev = phase.phase;
        if (prev !== d.phase) sendStickers();
        phase = d;
        phaseAt = performance.now();
        if (d.phase === 'intro') { lastCount = null; landed = null; runIntro(); keepAwake(); }
        if (d.phase === 'shop') {
          if (prev !== 'shop') { shopDone = false; doneBtn.textContent = 'Done'; list.style.opacity = 1; list.innerHTML = ''; }
          renderShop(true); shopTimer();
        }
        if (d.phase === 'results') paintResults();
        if (d.phase === 'final') paintFinal();
        if (d.phase !== 'intro' && d.phase !== 'race') pendingThrow = null;
        decide();
        if (d.phase === 'race' && pendingThrow) {
          link.input({ k: 'throw', ...pendingThrow });
          pendingThrow = null;
          vibrate([15, 30, 25]);
          me.state = 'fly'; decide();
        }
        break;
      }
      case 'me': {
        // Ignore a stale 'held' that arrives right after we threw
        if (view === 'fly' && d.state === 'held') d.state = 'fly';
        me = d;
        paintHeader();
        paintRank();
        hpbar.style.transform = `scaleX(${clamp(d.hp / d.maxHp, 0, 1)})`;
        hpbar.classList.toggle('low', d.hp / d.maxHp < 0.35);
        if (phase.phase === 'shop') renderShop();
        if (d.state === 'landed') paintLanded();
        decide();
        break;
      }
      case 'landed':
        landed = d;
        paintLanded();
        vibrate(d.zone ? [20, 40, 20, 40, 60] : [60]);
        break;
      case 'fx':
        if (['hit', 'clip', 'gust'].includes(d.kind)) phoneFlash(d.kind);
        if (d.kind === 'boost') { phoneFlash('gust'); vibrate(d.ring ? [10, 20, 30] : [8, 16, 8]); }
        if (d.kind === 'trick') { phoneToast(`${d.label} +${d.clips}${d.mult > 1 ? ` x${d.mult}` : ''}${d.boost ? ' · Boost!' : ''}`); phoneFlash('clip'); vibrate([12, 30, 12, 30, 20 + d.mult * 10]); }
        if (d.kind === 'chainbreak') phoneToast(`Chain broken`);
        if (d.kind === 'item') { phoneToast(`${ITEM_NAMES[d.item] || 'Item'}!`); vibrate([12, 30, 12, 30, 40]); }
        if (d.kind === 'toast') { phoneToast(d.text); vibrate([10, 20, 10]); }
        if (d.kind === 'clip' && d.chain > 1) phoneToast(`x${d.chain}`);
        if (d.kind === 'close') vibrate([10, 25, 10]);
        if (d.kind === 'hit') { vibrate(Math.min(80, 20 + d.dmg * 2)); const h = q('.hpbar'); h.classList.remove('shake'); void h.offsetWidth; h.classList.add('shake'); }
        else if (d.kind === 'clip') vibrate(8);
        else if (d.kind === 'gust') vibrate([6, 20, 6]);
        else if (d.kind === 'crumple') vibrate([80, 40, 80]);
        else if (d.kind === 'bought') {
          vibrate([10, 30, 10]);
          setTimeout(() => { const el = list.querySelector(`[data-id="${d.id}"]`); el?.classList.add('bought'); }, 30);
        }
        break;
    }
  });

  // Quick full-screen pulses on the phone so you feel hits and pickups
  // without looking down.
  function phoneFlash(kind) {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const f = document.createElement('div');
    f.className = `pflash ${kind}`;
    root.appendChild(f);
    setTimeout(() => f.remove(), 500);
  }
  function phoneToast(text) {
    const t = document.createElement('div');
    t.className = 'ptoast';
    t.textContent = text;
    root.appendChild(t);
    setTimeout(() => t.remove(), 1000);
  }

  // Solo on a phone has no host screen, so the final card carries the menu
  if (onAgain) { q('.f-again').onclick = () => onAgain(); q('.f-menu').onclick = () => onMenu?.(); }

  paintHeader();
  setView('wait');
  window.addEventListener('resize', () => { drawAim(); drawStick(); });
  return { get phase() { return phase.phase; } };
}
