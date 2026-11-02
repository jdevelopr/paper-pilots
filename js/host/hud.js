// hud.js: DOM overlays on the host's shared screen. Big shapes, high contrast,
// readable from the couch. Everything here is driven by the flow; no game rules.

import { esc, clipIcon, planeIcon, reduceMotion } from '../ui.js';
import { colorFor, TIER_COLORS } from '../shared/colors.js';
import { SIM, scoreRun, ITEMS } from '../game/sim.js';
const ITEM_COLORS = { donut: '#f29bb8', card: '#8fd0ea', glue: '#f08a2c', chipclip: '#6fbf73' };
import { UPGRADE_BY_ID, SLOTS, MK } from '../shared/upgrades.js';

// A short "build" line from the loadout: the fold names the style
const pathOf = p => { const f = UPGRADE_BY_ID[p.loadout?.fold]; return f ? `${f.name} build` : ''; };

// One chip per upgrade, with its level: "Packing Tape II".
// One chip per equipped slot: "Cardstock Mk II"
const upChips = p => SLOTS.filter(sl => p.loadout?.[sl.id]).map(sl => { const id = p.loadout[sl.id]; return { id: sl.id, text: `${UPGRADE_BY_ID[id]?.name ?? id} ${MK(p.parts?.[id] || 1)}` }; });

const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

export function createHud(root) {
  root.innerHTML = `
    <div class="hud-race" hidden>
      <div class="racers"></div>
      <div class="hud-top"><div class="hud-chip hud-floor"></div><div class="hud-chip hud-timer"></div><div class="hud-chip hud-clips" hidden>${clipIcon}<span>0</span></div><div class="hud-chip hud-par" hidden></div></div>
      <div class="hud-tired" hidden>Keep moving forward!</div>
      <div class="hud-buffs"></div>
      <div class="progress"></div>
      <div class="tags"></div>
    </div>
    <div class="floaters"><div class="trick-rail" aria-live="polite"></div></div>
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
  // Your own clip counter (solo and player views), which collected clips fly into
  const myClips = q('.hud-clips'), myClipsN = myClips.querySelector('span');
  let meSeat = null, inFlight = 0;
  const setMe = seat => { meSeat = seat; myClips.hidden = seat == null; };
  const parEl = q('.hud-par'), tiredEl = q('.hud-tired'), buffsEl = q('.hud-buffs');
  // Active item bonuses on your plane, each with a draining bar
  function paintBuffs(p, t) {
    const live = Object.keys(ITEMS).filter(k => (p.buffs?.[k] ?? 0) > t && p.state !== 'landed');
    const key = live.join(',');
    if (buffsEl.dataset.key !== key) {
      buffsEl.dataset.key = key;
      buffsEl.innerHTML = live.map(k => `<div class="buff" data-k="${k}" style="--bc:${ITEM_COLORS[k]}"><b>${esc(ITEMS[k].label)}</b> ${esc(ITEMS[k].what)}<i><u></u></i></div>`).join('');
    }
    for (const el of buffsEl.children) {
      const k = el.dataset.k, left = (p.buffs[k] - t) / ITEMS[k].dur;
      el.querySelector('u').style.transform = `scaleX(${Math.max(0, Math.min(1, left)).toFixed(3)})`;
    }
  }
  // Par for the next target ahead of your plane: time left, or how far over you are
  function paintPar(p, t) {
    if (!floor || p.state === 'held' || p.state === 'landed' || p.crumpled || p.thrownAt == null) { parEl.hidden = true; return; }
    const next = [...floor.zones].sort((a, b) => a.z - b.z).find(zn => zn.z + zn.d / 2 > p.z);
    if (!next || next.par == null) { parEl.hidden = true; return; }
    const ft = t - p.thrownAt, left = next.par - ft;
    parEl.hidden = false;
    parEl.style.setProperty('--tc', TIER_COLORS[next.tier]);
    parEl.classList.toggle('over', left < 0);
    parEl.classList.toggle('gone', ft > next.par * 2);
    parEl.innerHTML = `<i></i>${esc(next.label)} <b>${ft > next.par * 2 ? 'no bonus' : left >= 0 ? `par ${left.toFixed(1)}s` : `+${(-left).toFixed(1)}s`}</b>`;
  }
  const shownClips = new Map();

  function setRace(f, players, roundLabel) {
    floor = f;
    floorEl.textContent = `Floor ${f.number} · ${f.name}${roundLabel ? ` · ${roundLabel}` : ''}`;
    racersEl.innerHTML = ''; tags.innerHTML = ''; progress.innerHTML = '';
    racerEls = new Map(); tagEls = new Map(); pipEls = new Map();
    inFlight = 0; myClipsN.textContent = '0';
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
      el.innerHTML = `<span class="pl"></span><span class="sw"></span><div><div class="nm">${esc(p.name)}</div><div class="sub">Aiming</div><div class="hp"><i></i></div></div><div class="cl">${clipIcon}<span>0</span></div>`;
      racersEl.appendChild(el);
      racerEls.set(p.seat, el);
      el.dataset.rank = p.rank || '';
      shownClips.set(p.seat, 0);

      const tag = document.createElement('div');
      tag.className = 'tag';
      tag.style.setProperty('--c', colorFor(p.seat));
      tag.innerHTML = `<svg class="crown" viewBox="0 0 24 16" aria-hidden="true"><path d="M2 14 L4 4 L9 9 L12 2 L15 9 L20 4 L22 14 Z" fill="#f2c94c" stroke="#2c2416" stroke-width="1.6" stroke-linejoin="round"/></svg>${esc(p.name)}`;
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
  const ORD = ['1st', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th'];
  let lastOrder = '';
  // Live running order by score (distance + target points). Cards slide
  // into place when positions change, and the leader's name tag wears a crown.
  function placeOrder(planes, t) {
    // the same score the results use: distance points plus par-scaled target points
    const sc = new Map(planes.map(p => [p, floor ? scoreRun(floor, p, t).total : 0]));
    return [...planes].sort((a, b) => (sc.get(b) - sc.get(a)) || (b.z - a.z));
  }

  function update(raceState, project, players) {
    if (!raceState || !floor) return;
    const left = Math.max(0, (raceState.timeLimit ?? SIM.raceTime) - raceState.t);
    timerEl.textContent = raceState.over ? '' : `${Math.ceil(left)}`;
    timerEl.hidden = raceState.over;
    timerEl.classList.toggle('low', left < 8 && !raceState.over);
    for (const p of raceState.planes) {
      if (p.seat === meSeat) {
        const v = String(Math.max(0, p.clips - inFlight));
        if (myClipsN.textContent !== v) myClipsN.textContent = v;
        paintPar(p, raceState.t);
        tiredEl.hidden = !(p.state === 'fly' && (p.fatigue || 0) > 0.6);
        paintBuffs(p, raceState.t);
      }
      const el = racerEls.get(p.seat);
      if (!el) continue;
      const hp = el.querySelector('.hp i');
      hp.style.transform = `scaleX(${p.hp / p.maxHp})`;
      hp.classList.toggle('low', p.hp / p.maxHp < 0.35);
      let sub = STATE_LABEL[p.state] || '';
      if (p.state === 'landed') sub = p.crumpled ? 'Crumpled' : p.zone ? `${p.zone.label} +${p.zone.pay}` : 'Missed';
      el.querySelector('.sub').textContent = el.dataset.rank ? `${el.dataset.rank} · ${sub}` : sub;
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
    const order = placeOrder(raceState.planes, raceState.t);
    const key = order.map(p => p.seat).join(',');
    const anyFlying = raceState.planes.some(p => p.state !== 'held');
    order.forEach((p, i) => {
      const el = racerEls.get(p.seat);
      if (!el) return;
      el.style.transform = `translateY(${i * 72}px)`;
      el.querySelector('.pl').textContent = anyFlying ? ORD[i] : '';
      tagEls.get(p.seat)?.classList.toggle('lead', anyFlying && i === 0 && !p.crumpled);
    });
    if (key !== lastOrder) {
      if (lastOrder && anyFlying) {
        const lead = racerEls.get(order[0].seat);
        if (lead && lastOrder.split(',')[0] !== String(order[0].seat)) { lead.classList.remove('lead-change'); void lead.offsetWidth; lead.classList.add('lead-change'); onLeadChange?.(order[0].seat); }
      }
      lastOrder = key;
    }
  }
  let onLeadChange = null;
  const setLeadChange = fn => { onLeadChange = fn; };

  // Combo counter per player for chained paper-clip pickups
  const combos = new Map();
  function combo(seat, now) {
    const c = combos.get(seat);
    const n = c && now - c.at < 1.6 ? c.n + 1 : 1;
    combos.set(seat, { n, at: now });
    return n;
  }

  /* ----------------------------------------------------- full-screen fx --- */
  const fx = document.createElement('div');
  fx.className = 'screen-fx';
  root.appendChild(fx);
  function flash(kind = 'white') {
    if (reduceMotion) return;
    const f = document.createElement('div');
    f.className = `flash ${kind}`;
    fx.appendChild(f);
    setTimeout(() => f.remove(), 900);
  }


  // Trick callout: hand-lettered name + bonus, stamped near the plane (or in
  // a column on the right if the plane is off-screen). Bigger with the combo.
  // Combo ink: a blot of ink splats behind a callout, bigger and messier as the chain climbs
  function inkSplat(level) {
    const R = 18 + level * 15, N = 16, drops = Math.round(1 + level * 3), pad = R * 1.9;
    const pts = Array.from({ length: N }, (_, i) => {
      const a = i / N * Math.PI * 2, r = R * (0.72 + Math.random() * 0.42);
      return [pad + Math.cos(a) * r, pad + Math.sin(a) * r];
    });
    // smooth blob through the points
    let d = `M${((pts[0][0] + pts[N - 1][0]) / 2).toFixed(1)},${((pts[0][1] + pts[N - 1][1]) / 2).toFixed(1)}`;
    for (let i = 0; i < N; i++) { const a = pts[i], b = pts[(i + 1) % N]; d += `Q${a[0].toFixed(1)},${a[1].toFixed(1)} ${((a[0] + b[0]) / 2).toFixed(1)},${((a[1] + b[1]) / 2).toFixed(1)}`; }
    let dots = '';
    for (let i = 0; i < drops; i++) {
      const a = Math.random() * Math.PI * 2, r = R * (1.15 + Math.random() * 0.8), s = 2 + Math.random() * (3 + level * 2.5);
      dots += `<circle cx="${(pad + Math.cos(a) * r).toFixed(1)}" cy="${(pad + Math.sin(a) * r).toFixed(1)}" r="${s.toFixed(1)}" style="--d:${(i * 25)}ms"/>`;
    }
    const el = document.createElement('div');
    el.className = 'ink-splat';
    el.style.setProperty('--sz', `${pad * 2}px`);
    el.innerHTML = `<svg viewBox="0 0 ${pad * 2} ${pad * 2}" aria-hidden="true"><path d="${d}"/>${dots}</svg>`;
    return el;
  }

  // A collected clip flies from the plane into your clip counter, which pops when it lands
  function clipFly(from, seat, n = 1) {
    if (seat !== meSeat || !from) return;
    const vis = el => el && el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden' && el.closest('[hidden]') == null;
    const ctl = document.querySelector('#controller .cv.on .cclips');
    const tgt = vis(ctl) && ctl.getBoundingClientRect().top < innerHeight ? ctl : vis(myClips) ? myClips : null;
    if (!tgt) return;
    if (reduceMotion) { tgt.classList.remove('bump'); void tgt.offsetWidth; tgt.classList.add('bump'); return; }
    const rr = root.getBoundingClientRect(), tr = (tgt.querySelector('svg') || tgt).getBoundingClientRect();
    const x0 = rr.left + from.x, y0 = rr.top + from.y, x1 = tr.left + tr.width / 2, y1 = tr.top + tr.height / 2;
    const dist = Math.hypot(x1 - x0, y1 - y0), arc = 60 + dist * 0.18;
    const el = document.createElement('div');
    el.className = 'clipfly';
    el.innerHTML = clipIcon;
    document.body.appendChild(el);
    if (tgt === myClips) inFlight += n;
    const frames = [];
    for (let i = 0; i <= 10; i++) {
      const t = i / 10, x = x0 + (x1 - x0) * t, y = y0 + (y1 - y0) * t - Math.sin(Math.PI * t) * arc;
      frames.push({ transform: `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -50%) rotate(${(t * 540).toFixed(0)}deg) scale(${(1.5 - t * 0.8).toFixed(2)})`, opacity: t > 0.92 ? 0.6 : 1 });
    }
    const anim = el.animate(frames, { duration: Math.min(850, 420 + dist * 0.4), easing: 'cubic-bezier(.45,0,.8,.6)' });
    anim.onfinish = anim.oncancel = () => {
      el.remove();
      if (tgt === myClips) inFlight = Math.max(0, inFlight - n);
      tgt.classList.remove('bump'); void tgt.offsetWidth; tgt.classList.add('bump');
    };
  }

  function trick(at, name, label, clips, mult, color) {
    const el = document.createElement('div');
    el.className = `trick m${Math.min(Math.ceil(mult), 5)}`;
    el.style.setProperty('--c', color);
    el.innerHTML = `<b>${esc(label)}</b><span>+${clips}${mult > 1 ? ` <i>x${mult}</i>` : ''}</span>`;
    // chain multiplier runs 1 .. 3; the ink grows with it
    if (mult > 1) el.prepend(inkSplat((mult - 1) * 1.5));
    // Callouts stack down the left side of the screen, out of the way of the flying
    const rail = q('.trick-rail');
    rail.appendChild(el);
    while (rail.children.length > 4) rail.firstElementChild.remove();
    setTimeout(() => el.remove(), 1700);
  }

  function racerHit(seat) {
    const el = racerEls.get(seat);
    if (!el) return;
    el.classList.remove('hit'); void el.offsetWidth; el.classList.add('hit');
  }

  function floater(x, y, text, cls = '', ink = 0) {
    const f = document.createElement('div');
    f.className = `floater ${cls}`;
    f.textContent = text;
    if (ink > 0) f.prepend(inkSplat(ink));
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
  function showIntro({ floor: f, round, rounds, leg, legs, players, startsAt }, onTick) {
    cancelAnimationFrame(countRaf);
    race.hidden = true;
    boardWrap.hidden = true;
    intro.hidden = false;
    intro.innerHTML = `
      <div class="elevator">
        <div class="disp"><svg aria-hidden="true"><use href="#i-up"/></svg><span>${f.number}</span></div>
        <div class="fname">${esc(f.name)}</div>
        <div class="stakes">Race ${leg} of ${legs} · ${esc(f.stakes)}</div>
        <div class="callin">${players.map((p, i) => `<span style="--c:${colorFor(p.seat)};--i:${i}">${esc(p.name)}<small>${esc(p.rank || '')}</small></span>`).join('')}</div>
      </div>
      <div class="count" hidden></div>`;
    const panel = intro.querySelector('.elevator'), count = intro.querySelector('.count');
    let last = null;
    const tick = () => {
      const left = startsAt() - Date.now();
      if (left <= 3000 && !panel.hidden) { panel.hidden = true; count.hidden = false; }
      const label = left <= 0 ? 'GO!' : left <= 3000 ? String(Math.ceil(left / 1000)) : null;
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

  function results(rows, f, isLast, leg, legs) {
    const html = `
      <h2>Floor ${f.number} · Race ${leg} <small>${isLast ? 'Final race' : leg === legs ? 'Shop, then up a floor' : 'Shop next'}</small></h2>
      <div class="rows">${rows.map((r, i) => `
        <div class="rrow" style="--c:${colorFor(r.seat)};--i:${i}">
          <div class="pl">${r.place}</div>
          <div class="nm">${esc(r.name)}<div class="rk">${r.promoted ? `<b class="promo">Promoted: ${esc(r.promoted)}</b>` : esc(r.rank)}</div></div>
          <div class="zn">${r.crumpled ? 'Crumpled' : r.zone ? `${esc(r.zone)}${r.ring ? ` <small class="ring">${esc(r.ring)}</small>` : ''}` : `Missed (${Math.round(r.dist)} ft)`}
            <div class="brk">${Math.round(r.dist)} ft${r.pb ? ' · <b class="pb">New best</b>' : ''} · distance ${plural(r.distPts ?? 0, 'pt')}${r.zone && !r.crumpled ? ` · target ${plural(r.targetPts ?? 0, 'pt')} <span class="par${r.parFactor >= 1 ? ' under' : ''}">${r.flightT}s, par ${r.par}s</span>` : ''}${r.earned.tricks ? ` · tricks ${r.earned.tricks}` : ''}${r.earned.streak ? ` · streak ${r.earned.streak}` : ''}</div>
            ${r.zoneStreak >= 2 || r.cleanStreak >= 2 || r.trickList?.length ? `<div class="badges">${r.zoneStreak >= 2 ? `<span>Zone streak x${r.zoneStreak}</span>` : ''}${r.cleanStreak >= 2 ? `<span>Clean streak x${r.cleanStreak}</span>` : ''}${r.trickList?.length ? `<span class="tk">${r.trickList.length} trick${r.trickList.length > 1 ? 's' : ''}${Math.max(...r.trickList.map(t => t.mult)) > 1 ? `, best x${Math.max(...r.trickList.map(t => t.mult))}` : ''}</span>` : ''}</div>` : ''}</div>
          <div class="earn">+<span data-to="${r.earned.total}">0</span>${clipIcon}</div>
          <div class="pts">+${r.points} · ${plural(r.totalPoints, 'pt')}</div>
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
          <div class="path">${esc(pathOf(p))}</div>
          <div class="ups">${upChips(p).map(c => `<span data-id="${c.id}">${esc(c.text)}</span>`).join('')}</div>
          <div class="state">${p.done ? 'Done' : 'Shopping'}</div>
        </div>`).join('')}</div>
      <div class="foot"><span>Next: Floor ${state.next.number} · ${esc(state.next.name)} · Race ${state.nextLeg} of ${state.legs}</span></div>`;
    const existing = boardWrap.querySelector('.shopgrid');
    if (!existing || boardWrap.hidden) { showBoard(html); return; }
    // Patch in place so cards don't replay their entrance on every purchase
    for (const p of state.players) {
      const card = boardWrap.querySelector(`.shopcard[data-seat="${p.seat}"]`);
      if (!card) { showBoard(html); return; }
      card.classList.toggle('done', p.done);
      card.querySelector('.cl span').textContent = p.clips;
      card.querySelector('.path').textContent = pathOf(p);
      card.querySelector('.state').textContent = p.done ? 'Done' : 'Shopping';
      const ups = card.querySelector('.ups');
      const chips = upChips(p);
      for (const el of [...ups.children]) if (!chips.some(c => c.id === el.dataset.id)) el.remove();
      for (const c of chips) {
        let chip = ups.querySelector(`[data-id="${c.id}"]`);
        if (!chip) { chip = document.createElement('span'); chip.dataset.id = c.id; ups.appendChild(chip); }
        if (chip.textContent !== c.text) {
          chip.textContent = c.text;
          chip.style.animation = 'none'; void chip.offsetWidth; chip.style.animation = '';
        }
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
          <div class="nm">${esc(r.name)}</div><div class="pts">${esc(r.rank || "")}</div>
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

  return { setRace, update, setLeadChange, combo, flash, trick, racerHit, clipFly, setMe, floater, banner, showIntro, results, shop, shopTimer, final, hideBoards, showRace, setHint };
}
