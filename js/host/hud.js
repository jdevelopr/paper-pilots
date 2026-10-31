// hud.js: DOM overlays on the host's shared screen. Big shapes, high contrast,
// readable from the couch. Everything here is driven by the flow; no game rules.

import { esc, clipIcon, planeIcon, reduceMotion } from '../ui.js';
import { colorFor, TIER_COLORS } from '../shared/colors.js';
import { SIM } from '../game/sim.js';
import { UPGRADE_BY_ID } from '../shared/upgrades.js';

const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

export function createHud(root) {
  root.innerHTML = `
    <div class="hud-race" hidden>
      <div class="racers"></div>
      <div class="hud-top"><div class="hud-chip hud-floor"></div><div class="hud-chip hud-timer"></div></div>
      <div class="progress"></div>
      <div class="tags"></div>
    </div>
    <div class="floaters"></div>
    <div class="overlay intro" hidden></div>
    <div class="overlay board-wrap" hidden></div>
    <div class="banner-wrap"></div>
    <div class="hint"></div>`;
  const q = s => root.querySelector(s);
  const race = q('.hud-race'), racersEl = q('.racers'), floorEl = q('.hud-floor'), timerEl = q('.hud-timer');
  const progress = q('.progress'), tags = q('.tags'), floaters = q('.floaters');
  const intro = q('.intro'), boardWrap = q('.board-wrap'), bannerWrap = q('.banner-wrap'), hint = q('.hint');

  let racerEls = new Map(), tagEls = new Map(), pipEls = new Map();
  let floor = null;
  const shownClips = new Map();

  function setRace(f, players, roundLabel) {
    floor = f;
    floorEl.textContent = `Floor ${f.number} · ${f.name}`;
    racersEl.innerHTML = ''; tags.innerHTML = ''; progress.innerHTML = '';
    racerEls = new Map(); tagEls = new Map(); pipEls = new Map();
    // Course strip: zone ticks along the length, pips for each plane.
    for (const zn of f.zones) {
      const z = document.createElement('div');
      z.className = 'zt';
      z.style.left = `${((zn.z - zn.d / 2) / f.length) * 100}%`;
      z.style.width = `${Math.max(1.2, (zn.d / f.length) * 100)}%`;
      z.style.background = TIER_COLORS[zn.tier];
      progress.appendChild(z);
    }
    players.forEach((p, i) => {
      const el = document.createElement('div');
      el.className = 'racer';
      el.style.setProperty('--c', colorFor(p.seat));
      el.style.setProperty('--i', i);
      el.innerHTML = `<span class="sw"></span><div><div class="nm">${esc(p.name)}</div><div class="sub">Aiming</div><div class="hp"><i></i></div></div><div class="cl">${clipIcon}<span>0</span></div>`;
      racersEl.appendChild(el);
      racerEls.set(p.seat, el);
      shownClips.set(p.seat, 0);

      const tag = document.createElement('div');
      tag.className = 'tag';
      tag.style.setProperty('--c', colorFor(p.seat));
      tag.textContent = p.name;
      tags.appendChild(tag);
      tagEls.set(p.seat, tag);

      const pip = document.createElement('div');
      pip.className = 'pip';
      pip.style.color = colorFor(p.seat);
      pip.innerHTML = planeIcon;
      progress.appendChild(pip);
      pipEls.set(p.seat, pip);
    });
    race.hidden = false;
  }

  const STATE_LABEL = { held: 'Aiming', fly: 'Flying', slide: 'Sliding', fall: 'Falling' };

  function update(raceState, project, players) {
    if (!raceState || !floor) return;
    const left = Math.max(0, SIM.raceTime - raceState.t);
    timerEl.textContent = raceState.over ? '' : `${Math.ceil(left)}`;
    timerEl.hidden = raceState.over;
    timerEl.classList.toggle('low', left < 8 && !raceState.over);
    for (const p of raceState.planes) {
      const el = racerEls.get(p.seat);
      if (!el) continue;
      const hp = el.querySelector('.hp i');
      hp.style.transform = `scaleX(${p.hp / p.maxHp})`;
      hp.classList.toggle('low', p.hp / p.maxHp < 0.35);
      let sub = STATE_LABEL[p.state] || '';
      if (p.state === 'landed') sub = p.crumpled ? 'Crumpled' : p.zone ? `${p.zone.label} +${p.zone.pay}` : 'Missed';
      el.querySelector('.sub').textContent = sub;
      const shown = shownClips.get(p.seat);
      if (shown !== p.clips) {
        shownClips.set(p.seat, p.clips);
        el.querySelector('.cl span').textContent = p.clips;
      }
      el.classList.toggle('gone', players?.[p.seat]?.connected === false);

      const tag = tagEls.get(p.seat);
      const s = project(p.x, p.y + 0.9, p.z);
      tag.style.display = s.visible ? '' : 'none';
      tag.style.transform = `translate(${s.x}px, ${s.y}px) translate(-50%, -100%)`;

      const pip = pipEls.get(p.seat);
      pip.style.left = `${Math.max(0, Math.min(100, (p.z / floor.length) * 100))}%`;
    }
  }

  function racerHit(seat) {
    const el = racerEls.get(seat);
    if (!el) return;
    el.classList.remove('hit'); void el.offsetWidth; el.classList.add('hit');
  }

  function floater(x, y, text, cls = '') {
    const f = document.createElement('div');
    f.className = `floater ${cls}`;
    f.textContent = text;
    f.style.left = `${x}px`; f.style.top = `${y}px`;
    floaters.appendChild(f);
    setTimeout(() => f.remove(), 1200);
  }

  let bannerTimer = null;
  function banner(text, ms = 1800) {
    bannerWrap.innerHTML = `<div class="banner hud-chip">${esc(text)}</div>`;
    clearTimeout(bannerTimer);
    bannerTimer = setTimeout(() => (bannerWrap.innerHTML = ''), ms);
  }

  /* ------------------------------------------------------------ intro --- */
  let countRaf = 0;
  function showIntro({ floor: f, round, rounds, players, startsAt }, onTick) {
    cancelAnimationFrame(countRaf);
    race.hidden = true;
    boardWrap.hidden = true;
    intro.hidden = false;
    intro.innerHTML = `
      <div class="elevator">
        <div class="disp"><svg aria-hidden="true"><use href="#i-up"/></svg><span>${f.number}</span></div>
        <div class="fname">${esc(f.name)}</div>
        <div class="stakes">${esc(f.stakes)} · Round ${round + 1} of ${rounds}</div>
        <div class="callin">${players.map((p, i) => `<span style="--c:${colorFor(p.seat)};--i:${i}">${esc(p.name)}</span>`).join('')}</div>
      </div>
      <div class="count" hidden></div>`;
    const panel = intro.querySelector('.elevator'), count = intro.querySelector('.count');
    let last = null;
    const tick = () => {
      const left = startsAt() - Date.now();
      if (left <= 3000 && !panel.hidden) { panel.hidden = true; count.hidden = false; }
      const label = left <= 0 ? 'GO' : left <= 3000 ? String(Math.ceil(left / 1000)) : null;
      if (label && label !== last) {
        last = label;
        count.textContent = label;
        count.classList.remove('tick'); void count.offsetWidth; count.classList.add('tick');
        onTick?.(label);
      }
      if (left <= -500) { intro.hidden = true; return; }
      countRaf = requestAnimationFrame(tick);
    };
    tick();
  }

  /* ---------------------------------------------------------- boards --- */
  function showBoard(html) {
    race.hidden = true;
    intro.hidden = true;
    boardWrap.hidden = false;
    boardWrap.innerHTML = `<div class="board note">${html}</div>`;
    return boardWrap.firstElementChild;
  }

  function results(rows, f, isLast) {
    const html = `
      <h2>Floor ${f.number} results <small>${isLast ? 'Final floor' : 'Shop next'}</small></h2>
      <div class="rows">${rows.map((r, i) => `
        <div class="rrow" style="--c:${colorFor(r.seat)};--i:${i}">
          <div class="pl">${r.place}</div>
          <div class="nm">${esc(r.name)}</div>
          <div class="zn">${r.crumpled ? 'Crumpled' : r.zone ? esc(r.zone) : `Missed (${Math.round(r.dist)} ft)`}
            <div class="brk">zone ${r.earned.zone} · place ${r.earned.place} · pickups ${r.earned.pickup}</div></div>
          <div class="earn">+<span data-to="${r.earned.total}">0</span>${clipIcon}</div>
          <div class="pts">${plural(r.totalPoints, 'pt')}</div>
        </div>`).join('')}</div>`;
    const el = showBoard(html);
    // Count each payout up rather than snapping it
    el.querySelectorAll('[data-to]').forEach((s, i) => {
      const to = +s.dataset.to;
      if (reduceMotion) { s.textContent = to; return; }
      const start = performance.now() + 400 + i * 140, dur = 700;
      const step = now => {
        const k = Math.max(0, Math.min(1, (now - start) / dur));
        s.textContent = Math.round(to * (1 - Math.pow(1 - k, 3)));
        if (k < 1) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });
  }

  function shop(state) {
    const html = `
      <h2>Supply closet <small class="shop-left"></small></h2>
      <div class="shopgrid">${state.players.map((p, i) => `
        <div class="shopcard ${p.done ? 'done' : ''}" data-seat="${p.seat}" style="--c:${colorFor(p.seat)};--i:${i}">
          <div class="nm">${esc(p.name)}</div>
          <div class="cl">${clipIcon}<span>${p.clips}</span></div>
          <div class="ups">${p.owned.map(id => `<span>${esc(UPGRADE_BY_ID[id]?.name ?? id)}</span>`).join('')}</div>
          <div class="state">${p.done ? 'Done' : 'Shopping'}</div>
        </div>`).join('')}</div>
      <div class="foot"><span>Next: Floor ${state.next.number} · ${esc(state.next.name)}</span></div>`;
    const existing = boardWrap.querySelector('.shopgrid');
    if (!existing || boardWrap.hidden) { showBoard(html); return; }
    // Patch in place so cards don't replay their entrance on every purchase
    for (const p of state.players) {
      const card = boardWrap.querySelector(`.shopcard[data-seat="${p.seat}"]`);
      if (!card) { showBoard(html); return; }
      card.classList.toggle('done', p.done);
      card.querySelector('.cl span').textContent = p.clips;
      card.querySelector('.state').textContent = p.done ? 'Done' : 'Shopping';
      const ups = card.querySelector('.ups');
      const have = [...ups.children].map(s => s.textContent);
      for (const id of p.owned) {
        const nm = UPGRADE_BY_ID[id]?.name ?? id;
        if (!have.includes(nm)) { const s = document.createElement('span'); s.textContent = nm; ups.appendChild(s); }
      }
    }
  }
  function shopTimer(sec) {
    const el = boardWrap.querySelector('.shop-left');
    if (el) el.textContent = `${Math.max(0, Math.ceil(sec))}s`;
  }

  function final(rows, { onAgain, onMenu, soloMenu }) {
    const order = [rows[1], rows[0], rows[2]].filter(Boolean);
    const heights = { 1: 150, 2: 110, 3: 80 };
    const html = `
      <h2>Employee of the month</h2>
      <div class="podium">${order.map(r => `
        <div class="step" style="--c:${colorFor(r.seat)};--d:${3 - r.place}">
          <div class="nm">${esc(r.name)}</div>
          <div class="pts">${plural(r.points, 'pt')} · ${plural(r.wins, 'win')}</div>
          <div class="blk" style="height:${heights[r.place]}px">${r.place}</div>
        </div>`).join('')}</div>
      ${rows.length > 3 ? `<div class="rows">${rows.slice(3).map((r, i) => `
        <div class="rrow" style="--c:${colorFor(r.seat)};--i:${i}"><div class="pl">${r.place}</div><div class="nm">${esc(r.name)}</div><div></div><div></div><div class="pts">${plural(r.points, 'pt')}</div></div>`).join('')}</div>` : ''}
      <div class="foot">
        ${soloMenu ? '<button class="btn ghost" data-a="menu">Menu</button>' : '<span></span>'}
        <button class="btn primary" data-a="again">Play again</button>
      </div>`;
    const el = showBoard(html);
    el.querySelector('[data-a=again]').onclick = onAgain;
    el.querySelector('[data-a=menu]')?.addEventListener('click', onMenu);
  }

  function hideBoards() { boardWrap.hidden = true; intro.hidden = true; }
  function showRace() { race.hidden = false; boardWrap.hidden = true; intro.hidden = true; }
  function setHint(t) { hint.textContent = t || ''; }

  return { setRace, update, racerHit, floater, banner, showIntro, results, shop, shopTimer, final, hideBoards, showRace, setHint };
}
