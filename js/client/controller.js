// controller.js: the player's controller. On a phone it fills the screen; in solo
// mode it docks in the corner of the desktop. It holds no game state of its own:
// it renders whatever the host last said and sends intent back.
//
// Touch: pull back on the pad to throw (slingshot), joystick to fly.
// Keyboard: arrows aim, up/down angle, hold Space to throw; WASD/arrows to fly.

import { esc, clipIcon, planeIcon, vibrate, keepAwake } from '../ui.js';
import { colorFor } from '../shared/colors.js';
import { RANK_UNLOCKS } from '../shared/ranks.js';
import { statBars, levelOf, MAX_LEVEL, UPGRADES, UPGRADE_BY_ID, SECTIONS, upgradeState } from '../shared/upgrades.js';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

export function mountController(root, link, { solo = false } = {}) {
  root.innerHTML = `
    <div class="cv" data-v="wait"><div class="cfill"><div><h3 class="w-t">Watch the screen</h3></div></div></div>
    <div class="cv" data-v="intro"><div class="cfill"><div><div class="csub i-floor"></div><h3 class="i-name"></h3><div class="cbig i-count"></div></div></div></div>
    <div class="cv" data-v="aim">
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
        <div class="stick" aria-label="Steer"><span class="lbl u">climb</span><span class="lbl d">dive</span><div class="thumb"></div></div>
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
      <div class="chead"><span class="cname"></span><span class="ctimer"></span><span class="cclips">${clipIcon}<span class="n">0</span></span></div>
      <div class="crank"><span class="ck-t"></span><i><b></b></i></div>
      <div class="stats"></div>
      <div class="shoplist"></div>
      <button class="btn primary s-done">Done</button>
    </div>
    <div class="cv" data-v="final">
      <div class="cfill f-fill"><div><div class="csub">Final</div><div class="cbig f-place"></div><h3 class="f-pts"></h3></div></div>
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

  function decide() {
    const ph = phase.phase;
    enabled = ph === 'race';
    if (ph === 'intro') return setView('intro');
    if (ph === 'race') {
      if (me.state === 'held') return setView('aim');
      if (me.state === 'fly' || me.state === 'slide' || me.state === 'fall') return setView('fly');
      if (me.state === 'landed') return setView('landed');
      return setView('wait');
    }
    if (ph === 'photo') { q('.w-t').textContent = 'Photo finish!'; return setView('wait'); }
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
    q('.i-floor').textContent = `Floor ${phase.floor.number} · Race ${phase.leg ?? 1} of ${phase.legs ?? 1}`;
    q('.i-name').textContent = phase.floor.name;
    const endAt = phaseAt + phase.inMs;
    const cnt = q('.i-count');
    const step = () => {
      const left = endAt - performance.now();
      const label = left <= 0 ? 'GO' : left <= 3000 ? String(Math.ceil(left / 1000)) : '';
      if (label !== lastCount) {
        lastCount = label;
        cnt.textContent = label;
        cnt.classList.remove('tick'); void cnt.offsetWidth; if (label) cnt.classList.add('tick');
        if (label) vibrate(label === 'GO' ? 40 : 12);
      }
      if (phase.phase === 'intro') introRaf = requestAnimationFrame(step);
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
    if (enabled) link.input({ k: 'aim', yaw: +aim.yaw.toFixed(3), pitch: +aim.pitch.toFixed(3), power: +aim.power.toFixed(3) });
  }

  function doThrow() {
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
  stick.addEventListener('pointerdown', e => { e.preventDefault(); stick.setPointerCapture(e.pointerId); stickPtr = e.pointerId; stickFrom(e); vibrate(6); });
  stick.addEventListener('pointermove', e => { if (e.pointerId === stickPtr) stickFrom(e); });
  const stickUp = e => { if (e.pointerId !== stickPtr) return; stickPtr = null; st.x = 0; st.y = 0; drawStick(); sendStick(true); };
  stick.addEventListener('pointerup', stickUp);
  stick.addEventListener('pointercancel', stickUp);

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
  // The shop is the upgrade tree: Basics, then the three specialty paths (pick
  // one, the others lock), then Extras. Every row shows why it's locked if it is.
  const PATH_NOTE = { Glider: 'Glider path', Dart: 'Dart path', Tank: 'Tank path' };
  function shopOrder() {
    const out = [];
    for (const sec of SECTIONS) {
      out.push({ head: sec.title, key: `h-${sec.id}` });
      for (const u of UPGRADES.filter(x => x.section === sec.id && !x.parent)) {
        if (u.path) out.push({ sub: PATH_NOTE[u.path], key: `p-${u.path}` });
        out.push({ u, depth: 0 });
        for (const c of UPGRADES.filter(x => x.parent === u.id)) out.push({ u: c, depth: 1 });
      }
    }
    return out;
  }
  function renderShop(force) {
    const key = JSON.stringify([me.clips, me.owned, me.rank?.level]);
    if (!force && key === lastShopKey) return;
    lastShopKey = key;
    const bars = statBars(me.owned);
    stats.innerHTML = Object.entries(bars).map(([k, v]) => `<span>${k}</span><i><b style="transform:scaleX(${v.toFixed(2)})"></b></i>`).join('');
    if (!list.children.length) {
      shopOrder().forEach((row, i) => {
        if (row.head || row.sub) {
          const h = document.createElement('div');
          h.className = row.head ? 'shead' : 'spath';
          h.textContent = row.head || row.sub;
          list.appendChild(h);
          return;
        }
        const u = row.u;
        const el = document.createElement('button');
        el.className = `upg${row.depth ? ' child' : ''}`;
        el.dataset.id = u.id;
        el.style.setProperty('--i', Math.min(i, 12));
        el.onclick = () => {
          if (el.disabled) return;
          vibrate(10);
          link.input({ k: 'buy', id: u.id });
        };
        list.appendChild(el);
      });
    }
    for (const el of list.querySelectorAll('.upg')) {
      const u = UPGRADE_BY_ID[el.dataset.id];
      const st = upgradeState(me.owned, u.id, me.rank?.level ?? 0);
      const lv = st.level ?? levelOf(me.owned, u.id);
      const maxed = st.state === 'maxed';
      const open = st.state === 'open';
      const afford = open && me.clips >= st.cost;
      el.classList.toggle('owned', maxed);
      el.classList.toggle('locked', st.state === 'needs');
      el.classList.toggle('lockedout', st.state === 'lockedOut');
      el.disabled = !afford;
      const pips = Array.from({ length: MAX_LEVEL }, (_, k) => `<i class="${k < lv ? 'on' : ''}"></i>`).join('');
      const right = maxed ? '<svg aria-hidden="true"><use href="#i-check"/></svg>'
        : open ? `${st.cost}${clipIcon}`
        : '<svg aria-hidden="true" class="lock"><use href="#i-lock"/></svg>';
      const desc = open || maxed
        ? `<b>${esc(u.pro)}</b>${u.con ? ` · <em>${esc(u.con)}</em>` : ''}`
        : `<span class="why">${esc(st.reason)}</span>`;
      el.setAttribute('aria-label', `${u.name}, level ${lv} of ${MAX_LEVEL}${open || maxed ? '' : `, ${st.reason}`}`);
      el.innerHTML = `<span class="un">${esc(u.name)}<span class="pips">${pips}</span></span>
        <span class="uc">${right}</span>
        <span class="ud">${desc}</span>`;
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
    const extras = [row.pb ? 'New best' : '', row.earned.tricks ? `Tricks +${row.earned.tricks}` : '', row.zoneStreak >= 2 ? `Zone streak x${row.zoneStreak}` : '', row.cleanStreak >= 2 ? `Clean streak x${row.cleanStreak}` : ''].filter(Boolean);
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

  link.on('event', msg => {
    const d = msg.data;
    switch (msg.name) {
      case 'phase': {
        const prev = phase.phase;
        phase = d;
        phaseAt = performance.now();
        if (d.phase === 'intro') { lastCount = null; landed = null; runIntro(); keepAwake(); }
        if (d.phase === 'shop') {
          if (prev !== 'shop') { shopDone = false; doneBtn.textContent = 'Done'; list.style.opacity = 1; list.innerHTML = ''; }
          renderShop(true); shopTimer();
        }
        if (d.phase === 'results') paintResults();
        if (d.phase === 'final') paintFinal();
        decide();
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
        if (d.kind === 'trick') { phoneToast(`${d.label} +${d.clips}${d.mult > 1 ? ` x${d.mult}` : ''}${d.boost ? ' · Boost!' : ''}`); phoneFlash('clip'); vibrate([12, 30, 12, 30, 20 + d.mult * 10]); }
        if (d.kind === 'chainbreak') phoneToast(`Chain broken`);
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

  paintHeader();
  setView('wait');
  window.addEventListener('resize', () => { drawAim(); drawStick(); });
  return { get phase() { return phase.phase; } };
}
