// render3d.js: the host's shared-screen 3D view.
// Builds each office floor from floors.js data, draws the paper planes, and runs
// the chase camera. Everything is low-poly and flat-shaded so the ink pass can
// outline it. Sim space maps to three.js as (x, y, z) -> (x, y, -z).

import * as THREE from 'three';
import { createInk } from './ink.js';
import { colorFor, TIER_COLORS } from '../shared/colors.js';
import { SIM } from '../game/sim.js';
import { moverAt, groundAt, gapWind } from '../game/floors.js';

const INK = '#2c2416';
const lam = (color, extra = {}) => new THREE.MeshLambertMaterial({ color, flatShading: true, ...extra });
const MAT_CACHE = new Map();
const M = color => { if (!MAT_CACHE.has(color)) MAT_CACHE.set(color, lam(color)); return MAT_CACHE.get(color); };

function boxMesh(w, h, d, color, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), M(color));
  m.position.set(x, y + h / 2, z);
  return m;
}

/* ------------------------------------------------------- canvas labels --- */

function hand(size) { return `${size}px "Caveat", "Patrick Hand", cursive`; }

function wobblyRect(ctx, x, y, w, h, seed = 1) {
  ctx.beginPath();
  const j = () => (Math.sin(seed++ * 12.9898) * 43758.5453 % 1) * 3;
  ctx.moveTo(x + j(), y + j());
  ctx.lineTo(x + w + j(), y + j());
  ctx.lineTo(x + w + j(), y + h + j());
  ctx.lineTo(x + j(), y + h + j());
  ctx.closePath();
}

function labelTexture(lines, { w = 512, h = 256, bg = '#f6efdc', fg = INK, border = true, dash = false } = {}) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);
  // paper speckle
  for (let i = 0; i < 400; i++) {
    ctx.fillStyle = `rgba(60,40,20,${Math.random() * 0.05})`;
    ctx.fillRect(Math.random() * w, Math.random() * h, 2, 2);
  }
  if (border) {
    ctx.strokeStyle = fg; ctx.lineWidth = Math.max(4, w / 80);
    if (dash) ctx.setLineDash([w / 18, w / 28]);
    wobblyRect(ctx, ctx.lineWidth, ctx.lineWidth, w - ctx.lineWidth * 2, h - ctx.lineWidth * 2, w);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  ctx.fillStyle = fg;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const n = lines.length;
  lines.forEach((ln, i) => {
    let size = ln.size || h / (n + 0.6);
    ctx.font = `${ln.bold ? '700 ' : ''}${hand(size)}`;
    while (size > 12 && ctx.measureText(ln.text).width > w * 0.86) {
      size *= 0.9;
      ctx.font = `${ln.bold ? '700 ' : ''}${hand(size)}`;
    }
    ctx.fillText(ln.text, w / 2, h * (i + 0.5) / n + h * 0.03);
  });
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

// A landing zone painted as a target: concentric ellipses in the tier colour,
// a dashed border, a bullseye dot, and the zone name along the far edge.
function targetTexture(zn) {
  const W = 512, H = Math.max(160, Math.round(512 * zn.d / zn.w));
  const c = document.createElement('canvas');
  c.width = W; c.height = Math.min(1024, H);
  const x = c.getContext('2d');
  const base = new THREE.Color(TIER_COLORS[zn.tier]);
  const light = '#' + base.clone().lerp(new THREE.Color('#fffdf6'), 0.55).getHexString();
  const dark = '#' + base.clone().multiplyScalar(0.82).getHexString();
  x.fillStyle = light; x.fillRect(0, 0, c.width, c.height);
  const cx = c.width / 2, cy = c.height / 2;
  [1, 2 / 3, 1 / 3].forEach((r, i) => {
    x.beginPath();
    x.ellipse(cx, cy, cx * r, cy * r, 0, 0, Math.PI * 2);
    x.fillStyle = i % 2 ? light : dark;
    x.fill();
    x.lineWidth = 5; x.strokeStyle = '#2c2416';
    x.stroke();
  });
  x.beginPath(); x.ellipse(cx, cy, cx * 0.07, cy * 0.07, 0, 0, Math.PI * 2); x.fillStyle = '#c1440e'; x.fill();
  x.strokeStyle = '#2c2416'; x.lineWidth = 8; x.setLineDash([28, 18]);
  x.strokeRect(5, 5, c.width - 10, c.height - 10); x.setLineDash([]);
  // name in the outer band near the far edge, with a paper backing so it stays legible
  let size = Math.min(64, c.height * 0.16);
  x.font = `700 ${size}px "Caveat", cursive`;
  while (size > 18 && x.measureText(zn.label).width > c.width * 0.7) { size *= 0.9; x.font = `700 ${size}px "Caveat", cursive`; }
  const tw = x.measureText(zn.label).width;
  x.fillStyle = 'rgba(255,253,246,.85)';
  x.fillRect(cx - tw / 2 - 10, 14, tw + 20, size * 1.05);
  x.fillStyle = '#2c2416'; x.textAlign = 'center'; x.textBaseline = 'top';
  x.fillText(zn.label, cx, 14 + size * 0.05);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

function speckleTexture(base, dot, n = 2500, size = 256, grid = 0) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  ctx.fillStyle = base; ctx.fillRect(0, 0, size, size);
  for (let i = 0; i < n; i++) {
    ctx.fillStyle = dot; ctx.globalAlpha = Math.random() * 0.25;
    ctx.fillRect(Math.random() * size, Math.random() * size, 2, 2);
  }
  ctx.globalAlpha = 0.35;
  if (grid) {
    ctx.strokeStyle = dot; ctx.lineWidth = 2;
    for (let i = 0; i <= size; i += size / grid) {
      ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i, size); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, i); ctx.lineTo(size, i); ctx.stroke();
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/* ------------------------------------------------------------- planes --- */

function planeGeometry(owned) {
  const wide = (owned.includes('widewings') ? 1.35 : 1) * (owned.includes('swallowtail') ? 1.15 : 1) * (owned.includes('dart') ? 0.82 : 1);
  const thick = owned.includes('cardstock') ? 0.09 : 0.0;
  const S = 0.75 * wide, L = owned.includes('dart') ? 1.0 : 0.85, K = 0.28, D = owned.includes('swallowtail') ? 0.22 : 0.14;
  // Nose at -z. Classic dart: two wing panels and a folded keel.
  const v = [
    0, 0, -L,          // 0 nose
    -S, D, L,          // 1 left tip
    0, 0, L,           // 2 centre rear (top fold)
    S, D, L,           // 3 right tip
    0, -K, L * 0.9,    // 4 keel bottom rear
    -S * 0.18, 0.03, L,// 5 left inner fold
    S * 0.18, 0.03, L, // 6 right inner fold
  ];
  const idx = [
    0, 1, 5, 0, 5, 2,  // left wing
    0, 2, 6, 0, 6, 3,  // right wing
    0, 2, 4,           // keel
  ];
  if (thick) {
    // Cardstock gets a visible second layer under the wings.
    const base = v.length / 3;
    v.push(0, -thick, -L + 0.05, -S, D - thick, L, S, D - thick, L);
    idx.push(base, base + 1, 2, base, 2, base + 2);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
  g.setIndex(idx);
  // UVs from the top-down footprint, so paper patterns lie flat across the wings.
  const uv = [];
  for (let i = 0; i < v.length; i += 3) uv.push(v[i] / (2 * S) + 0.5, v[i + 2] / (2 * L) + 0.5);
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.computeVertexNormals();
  return g;
}

/* ---------------------------------------------------- rank paper looks --- */
// Every promotion changes what your plane is folded from. The pattern is a
// near-white texture so the player's colour still tints it and stays readable.
const PAPER_TEX = new Map();
function paperTexture(rank) {
  if (PAPER_TEX.has(rank)) return PAPER_TEX.get(rank);
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const x = c.getContext('2d');
  const line = (style, w, fn) => { x.strokeStyle = style; x.lineWidth = w; x.beginPath(); fn(); x.stroke(); };
  x.fillStyle = '#ffffff'; x.fillRect(0, 0, 256, 256);
  switch (rank) {
    case 1: // lined notebook
      line('rgba(70,120,200,.55)', 3, () => { for (let y = 20; y < 256; y += 26) { x.moveTo(0, y); x.lineTo(256, y); } });
      line('rgba(210,60,60,.7)', 4, () => { x.moveTo(40, 0); x.lineTo(40, 256); });
      break;
    case 2: // graph paper
      line('rgba(60,140,120,.45)', 2, () => { for (let i = 0; i <= 256; i += 16) { x.moveTo(i, 0); x.lineTo(i, 256); x.moveTo(0, i); x.lineTo(256, i); } });
      line('rgba(60,140,120,.65)', 3, () => { for (let i = 0; i <= 256; i += 64) { x.moveTo(i, 0); x.lineTo(i, 256); x.moveTo(0, i); x.lineTo(256, i); } });
      break;
    case 3: // legal pad
      x.fillStyle = '#fff3a8'; x.fillRect(0, 0, 256, 256);
      line('rgba(90,130,200,.5)', 2.5, () => { for (let y = 18; y < 256; y += 22) { x.moveTo(0, y); x.lineTo(256, y); } });
      line('rgba(200,50,50,.75)', 3, () => { x.moveTo(36, 0); x.lineTo(36, 256); x.moveTo(42, 0); x.lineTo(42, 256); });
      break;
    case 4: // kraft paper
      x.fillStyle = '#e3c79a'; x.fillRect(0, 0, 256, 256);
      for (let i = 0; i < 900; i++) { x.fillStyle = `rgba(110,70,30,${Math.random() * 0.25})`; x.fillRect(Math.random() * 256, Math.random() * 256, 1 + Math.random() * 6, 1); }
      break;
    case 5: // blueprint
      x.fillStyle = '#4f7fbf'; x.fillRect(0, 0, 256, 256);
      line('rgba(255,255,255,.35)', 1.5, () => { for (let i = 0; i <= 256; i += 16) { x.moveTo(i, 0); x.lineTo(i, 256); x.moveTo(0, i); x.lineTo(256, i); } });
      line('rgba(255,255,255,.85)', 3, () => { x.moveTo(30, 200); x.lineTo(128, 40); x.lineTo(226, 200); x.closePath(); x.moveTo(128, 40); x.lineTo(128, 220); });
      break;
    case 6: // silver foil
    case 7: // gold foil
      for (let y = 0; y < 256; y += 2) { x.fillStyle = `rgba(0,0,0,${0.04 + Math.random() * 0.06})`; x.fillRect(0, y, 256, 1); }
      break;
    default: return null;
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  PAPER_TEX.set(rank, t);
  return t;
}

function paperMaterial(seat, owned, rank) {
  const base = new THREE.Color(colorFor(seat));
  if (owned.includes('cardstock')) base.multiplyScalar(0.9);
  const map = paperTexture(rank);
  const shiny = owned.includes('glossy') || owned.includes('laminated');
  if (rank >= 6) {
    // Foil: metallic, but keep a hint of the player's colour
    const metal = new THREE.Color(rank === 7 ? '#e8b830' : '#d6dce3');
    return new THREE.MeshPhongMaterial({
      color: base.lerp(metal, rank === 7 ? 0.7 : 0.6), map, flatShading: true, side: THREE.DoubleSide,
      shininess: 140, specular: rank === 7 ? 0xffe08a : 0xdddddd, emissive: rank === 7 ? 0x3a2800 : 0x1a1d22,
    });
  }
  const color = map ? base.lerp(new THREE.Color('#ffffff'), rank === 5 ? 0.55 : 0.25) : base;
  const opts = { color, map, flatShading: true, side: THREE.DoubleSide };
  if (owned.includes('featherweight')) Object.assign(opts, { transparent: true, opacity: 0.82 });
  return shiny
    ? new THREE.MeshPhongMaterial({ ...opts, shininess: 90, specular: 0x777777 })
    : new THREE.MeshLambertMaterial(opts);
}

function buildPlane(seat, owned, rank = 0) {
  const group = new THREE.Group();
  const mat = paperMaterial(seat, owned, rank);
  const body = new THREE.Mesh(planeGeometry(owned), mat);
  group.add(body);

  const wide = (owned.includes('widewings') ? 1.35 : 1) * (owned.includes('swallowtail') ? 1.15 : 1) * (owned.includes('dart') ? 0.82 : 1);
  if (owned.includes('bumpers')) {
    for (const s of [-1, 1]) {
      const b = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.16, 0.3), M('#ef8fa8'));
      b.position.set(s * 0.74 * wide, 0.14, 0.8);
      group.add(b);
    }
  }
  if (owned.includes('skids')) {
    const sk = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.08, 0.9), M('#ef8fa8'));
    sk.position.set(0, -0.27, 0.35);
    group.add(sk);
  }
  if (owned.includes('rudder')) {
    const r = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.3, 0.3), M('#c8f04a'));
    r.position.set(0, 0.16, 0.75);
    group.add(r);
  }
  if (owned.includes('noseclip')) {
    const clip = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.16, 0.34), M('#b9c1c9'));
    clip.position.set(0, -0.04, -0.62);
    group.add(clip);
  }
  if (owned.includes('flaps')) {
    for (const s of [-1, 1]) {
      const f = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.02, 0.22), M('#f7e26b'));
      f.position.set(s * 0.6 * wide, 0.14, 0.78);
      group.add(f);
    }
  }
  if (owned.includes('tape')) {
    const t = new THREE.Mesh(new THREE.BoxGeometry(1.0 * wide, 0.015, 0.16),
      new THREE.MeshLambertMaterial({ color: '#d8c7a0', transparent: true, opacity: 0.75 }));
    t.position.set(0, 0.06, 0.25);
    group.add(t);
  }
  if (owned.includes('binder')) {
    const b = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.14, 0.16), M('#2c2c2c'));
    b.position.set(0, -0.26, 0.7);
    group.add(b);
  }
  if (owned.includes('magnet')) {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.06, 8), M('#c1440e'));
    m.position.set(0, -0.12, 0.1);
    group.add(m);
  }
  if (owned.includes('afterburner')) {
    // Doodled flames on the tail; more levels, longer flames
    const lv = owned.filter(x => x === 'afterburner').length;
    for (const [s, c] of [[-1, '#f08a2c'], [0, '#e2462e'], [1, '#f08a2c']]) {
      const len = 0.22 + 0.06 * lv + (s ? 0 : 0.08);
      const f = new THREE.Mesh(new THREE.ConeGeometry(0.06, len, 4), M(c));
      f.rotation.x = Math.PI / 2;
      f.position.set(s * 0.1, 0.04, 0.9 + len / 2);
      group.add(f);
    }
  }
  if (owned.includes('rubberband')) {
    const r = new THREE.Mesh(new THREE.TorusGeometry(0.12, 0.025, 4, 10), M('#c94f3d'));
    r.position.set(0, -0.16, 0.45); r.rotation.y = Math.PI / 2;
    group.add(r);
  }

  // Crumpled-ball stand-in, revealed when durability runs out
  const ballGeo = new THREE.IcosahedronGeometry(0.42, 1);
  const pos = ballGeo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const k = 0.75 + Math.abs(Math.sin(i * 91.7)) * 0.45;
    pos.setXYZ(i, pos.getX(i) * k, pos.getY(i) * k, pos.getZ(i) * k);
  }
  ballGeo.computeVertexNormals();
  const ball = new THREE.Mesh(ballGeo, mat);
  ball.visible = false;

  const root = new THREE.Group();
  root.add(group, ball);
  // Wing tips (just outside the outer edges) for the slipstream doodle lines
  const tipS = 0.75 * wide + 0.04, tipL = owned.includes('dart') ? 1.0 : 0.85, tipD = owned.includes('swallowtail') ? 0.22 : 0.14;
  const tips = [new THREE.Vector3(-tipS, tipD, tipL * 0.92), new THREE.Vector3(tipS, tipD, tipL * 0.92)];
  root.userData = { body: group, ball, seat, tips };
  return root;
}

/* ----------------------------------------------------------- furniture --- */

function buildObject(o) {
  const g = new THREE.Group();
  const { w, d, h } = o;
  switch (o.type) {
    case 'desk': {
      g.add(boxMesh(w, 0.35, d, o.launch ? '#a8794a' : '#b98a55', 0, h - 0.35, 0));
      for (const sx of [-1, 1]) for (const sz of [-1, 1])
        g.add(boxMesh(0.25, h - 0.35, 0.25, '#6b5440', sx * (w / 2 - 0.3), 0, sz * (d / 2 - 0.3)));
      if (o.mon) {
        g.add(boxMesh(1.8, 1.1, 0.15, '#3b3f45', 0, h + 0.3, -(d / 2 - 0.4)));
        g.add(boxMesh(0.2, 0.3, 0.2, '#3b3f45', 0, h, -(d / 2 - 0.4)));
        g.add(boxMesh(1.4, 0.06, 0.5, '#d8d4cc', 0, h, 0.1));
      }
      if (o.launch) {
        // Stack of paper and a pencil cup on the launch desk
        g.add(boxMesh(1.4, 0.6, 1.1, '#f7f3ea', -5.7, h, 0.6));
        g.add(boxMesh(1.4, 0.04, 1.1, '#efe6d0', -5.65, h + 0.6, 0.6));
        const cup = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.3, 0.8, 7), M('#1e4d6b'));
        cup.position.set(5.8, h + 0.4, 0.6); g.add(cup);
        for (let i = 0; i < 3; i++) {
          const p = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 1.4, 5), M(['#e0a526', '#c1440e', '#3d6b52'][i]));
          p.position.set(5.8 + (i - 1) * 0.12, h + 1, 0.6); p.rotation.z = (i - 1) * 0.2; g.add(p);
        }
      }
      break;
    }
    case 'table': {
      g.add(boxMesh(w, 0.35, d, '#c9a97a', 0, h - 0.35, 0));
      g.add(boxMesh(0.5, h - 0.35, 0.5, '#6b5440', 0, 0, 0));
      g.add(boxMesh(Math.min(w, 3), 0.15, Math.min(d, 3), '#6b5440', 0, 0, 0));
      break;
    }
    case 'counter':
      g.add(boxMesh(w, h - 0.3, d, '#8a6a4a'));
      g.add(boxMesh(w + 0.2, 0.3, d + 0.2, '#e8e0d0', 0, h - 0.3, 0));
      break;
    case 'cubicle':
      g.add(boxMesh(w, h - 0.2, d, '#7d8c99'));
      g.add(boxMesh(w + 0.05, 0.2, d + 0.1, '#c9ced2', 0, h - 0.2, 0));
      break;
    case 'pillar':
      g.add(boxMesh(w, h, d, '#ddd3c2'));
      g.add(boxMesh(w + 0.4, 0.5, d + 0.4, '#c8bca8'));
      break;
    case 'plant': {
      const pot = new THREE.Mesh(new THREE.CylinderGeometry(w * 0.45, w * 0.35, 1.4, 7), M('#b5643c'));
      pot.position.y = 0.7; g.add(pot);
      for (let i = 0; i < 4; i++) {
        const leaf = new THREE.Mesh(new THREE.IcosahedronGeometry(0.7 + (i % 2) * 0.3, 0), M(i % 2 ? '#4f8a5b' : '#3d6b52'));
        leaf.position.set(Math.sin(i * 2.1) * 0.35, 2 + i * 0.6, Math.cos(i * 2.1) * 0.35);
        g.add(leaf);
      }
      break;
    }
    case 'cabinet':
      g.add(boxMesh(w, h, d, '#9aa3a8'));
      for (let y = 0.6; y < h - 0.3; y += 1.3) g.add(boxMesh(w * 0.5, 0.12, 0.06, '#5b6266', 0, y + 0.5, -d / 2 - 0.02));
      break;
    case 'couch':
      g.add(boxMesh(w, h * 0.5, d, '#6a7f8f'));
      g.add(boxMesh(w, h, d * 0.3, '#5d7080', 0, 0, d * 0.35));
      for (const s of [-1, 1]) g.add(boxMesh(0.5, h * 0.75, d, '#5d7080', s * (w / 2 - 0.25), 0, 0));
      break;
    case 'cooler': {
      g.add(boxMesh(w, h - 1.4, d, '#e8e6df'));
      const b = new THREE.Mesh(new THREE.CylinderGeometry(w * 0.4, w * 0.4, 1.4, 7), lam('#8fc3e6', { transparent: true, opacity: 0.85 }));
      b.position.y = h - 0.7; g.add(b);
      break;
    }
    case 'printer':
      g.add(boxMesh(w, h - 0.5, d, '#d9d6cf'));
      g.add(boxMesh(w * 0.9, 0.5, d * 0.8, '#5b6266', 0, h - 0.5, 0));
      g.add(boxMesh(w * 0.5, 0.05, 0.6, '#ffffff', 0, h * 0.6, -d / 2 - 0.3));
      break;
    case 'vending':
      g.add(boxMesh(w, h, d, '#b8432f'));
      g.add(boxMesh(w * 0.6, h * 0.6, 0.1, '#e6eef2', -w * 0.12, h * 0.3, -d / 2 - 0.04));
      break;
    case 'fridge':
      g.add(boxMesh(w, h, d, '#f0eee8'));
      g.add(boxMesh(0.15, 1.6, 0.2, '#8a8f93', w / 2 - 0.5, h * 0.55, -d / 2 - 0.1));
      g.add(boxMesh(w + 0.02, 0.08, d + 0.02, '#c9c6bd', 0, h * 0.4, 0));
      break;
    case 'rack':
      g.add(boxMesh(w, h, d, '#56606b'));
      for (let y = 0.8; y < h - 0.4; y += 0.9) {
        g.add(boxMesh(w + 0.04, 0.08, d * 0.96, '#7a8590', 0, y, 0));
      }
      break;
    case 'shelf': {
      g.add(boxMesh(w, h, d, '#7a5a3a'));
      const cols = ['#c1440e', '#1e4d6b', '#3d6b52', '#e0a526', '#efe6d0'];
      // Book spines face the players: toward the launch end for shelves set
      // across the room, toward the middle of the room for shelves on a wall.
      const along = w < d, face = along ? -Math.sign(o.x || 1) : 1;
      const span = along ? d : w;
      for (let y = 0.4, k = 0; y < h - 0.8; y += 1.5) {
        for (let u = -span / 2 + 0.4; u < span / 2 - 0.4; u += 0.45, k++) {
          const bh = 1.0 + (k % 3) * 0.15;
          if (along) g.add(boxMesh(0.2, bh, 0.35, cols[k % 5], face * (w / 2 + 0.05), y, u));
          else g.add(boxMesh(0.35, bh, 0.2, cols[k % 5], u, y, d / 2 + 0.05));
        }
      }
      break;
    }
    case 'glass': {
      const glass = new THREE.Mesh(new THREE.BoxGeometry(w, h, d),
        new THREE.MeshLambertMaterial({ color: '#bfe0ea', transparent: true, opacity: 0.28, depthWrite: false }));
      glass.position.y = h / 2; glass.layers.set(1); g.add(glass);
      g.add(boxMesh(w, 0.3, d + 0.1, '#5b6266', 0, 0, 0));
      g.add(boxMesh(w, 0.3, d + 0.1, '#5b6266', 0, h - 0.3, 0));
      for (const s of [-1, 1]) g.add(boxMesh(0.25, h, d + 0.1, '#5b6266', s * (w / 2 - 0.12), 0, 0));
      break;
    }
    case 'crate':
      g.add(boxMesh(w, h, d, '#c9a26b'));
      g.add(boxMesh(w + 0.02, 0.05, 0.5, '#e8d9b0', 0, h, 0));
      break;
    case 'tv':
      g.add(boxMesh(w, h, d, '#26292d', 0, 0, 0));
      g.add(boxMesh(w * 0.92, h * 0.86, 0.05, '#6f8fa3', 0, h * 0.07, -d / 2 - 0.03));
      break;
    case 'hallwall': {
      // Floor-to-ceiling hallway wall: painted panel, skirting, a chair rail,
      // and the odd framed picture on the long faces.
      g.add(boxMesh(w, h, d, o.color || '#e9e1cf'));
      g.add(boxMesh(w + 0.12, 0.6, d + 0.12, '#6b5440'));
      g.add(boxMesh(w + 0.08, 0.18, d + 0.08, '#a8794a', 0, 3.4, 0));
      const long = d > w ? 'd' : 'w';
      const L = long === 'd' ? d : w;
      const cols = ['#1e4d6b', '#3d6b52', '#c1440e', '#e0a526'];
      for (let t = -L / 2 + 6, i = 0; t < L / 2 - 4; t += 11 + (i % 3) * 3, i++) {
        for (const side of [-1, 1]) {
          const fw = 2.2 + (i % 2), fh = 1.6 + ((i + 1) % 2) * 0.6;
          const frame = new THREE.Group();
          frame.add(boxMesh(fw, fh, 0.12, '#5b4636', 0, 0, 0));
          const art = boxMesh(fw - 0.4, fh - 0.4, 0.05, cols[(i + (side > 0)) % 4], 0, 0.2, side > 0 ? 0.06 : -0.06);
          frame.add(art);
          if (long === 'd') { frame.rotation.y = Math.PI / 2; frame.position.set(side * (w / 2 + 0.07), 5.2, t); }
          else frame.position.set(t, 5.2, side * (d / 2 + 0.07));
          g.add(frame);
        }
      }
      break;
    }
    case 'lintel':
      g.add(boxMesh(w + 0.6, h, d, '#efe6d6'));
      g.add(boxMesh(w + 1.2, 0.45, d + 0.3, '#6b5440'));          // header trim at the door's top edge
      // EXIT-style sign above the doorway
      g.add(boxMesh(1.8, 0.6, 0.12, '#3d6b52', 0, 0.8, -d / 2 - 0.08));
      break;
    case 'doorframe':
      // Decorative posts at the sides of the opening (the walls do the colliding)
      for (const s of [-1, 1]) g.add(boxMesh(0.35, h, d + 0.25, '#6b5440', s * (w / 2 + 0.17), 0, 0));
      break;
    /* ----- Rooftop gear ----- */
    case 'parapet':
      g.add(boxMesh(w, h, d, '#b8ad9a'));
      g.add(boxMesh(w + 0.15, 0.15, d + 0.15, '#d8cfbf', 0, h, 0));
      break;
    case 'acunit': {
      g.add(boxMesh(w, h, d, '#c9cdd1'));
      for (let x = -w / 2 + 0.5; x < w / 2 - 0.3; x += 0.45) g.add(boxMesh(0.08, h * 0.6, 0.04, '#8a8f93', x, h * 0.2, d / 2 + 0.02));
      const fan = new THREE.Mesh(new THREE.CylinderGeometry(Math.min(w, d) * 0.35, Math.min(w, d) * 0.35, 0.12, 12), M('#3b3f45'));
      fan.position.y = h + 0.06; g.add(fan);
      for (let i = 0; i < 3; i++) { const b = boxMesh(Math.min(w, d) * 0.6, 0.05, 0.25, '#8a8f93', 0, h + 0.12, 0); b.rotation.y = i * Math.PI / 3; g.add(b); }
      break;
    }
    case 'watertower': {
      const legH = h * 0.45, tankH = h * 0.42, r = w / 2;
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) g.add(boxMesh(0.3, legH, 0.3, '#4a3b2c', sx * r * 0.65, 0, sz * r * 0.65));
      g.add(boxMesh(w * 0.9, 0.12, 0.12, '#4a3b2c', 0, legH * 0.5, 0));
      const tank = new THREE.Mesh(new THREE.CylinderGeometry(r, r, tankH, 14), M('#9a6b45'));
      tank.position.y = legH + tankH / 2; g.add(tank);
      for (const k of [0.25, 0.7]) { const band = new THREE.Mesh(new THREE.CylinderGeometry(r + 0.05, r + 0.05, 0.15, 14), M('#4a3b2c')); band.position.y = legH + tankH * k; g.add(band); }
      const cap = new THREE.Mesh(new THREE.ConeGeometry(r * 1.05, h - legH - tankH, 14), M('#5b4636'));
      cap.position.y = legH + tankH + (h - legH - tankH) / 2; g.add(cap);
      break;
    }
    case 'dish': {
      g.add(boxMesh(0.3, h * 0.55, 0.3, '#8a8f93'));
      const dish = new THREE.Mesh(new THREE.SphereGeometry(w / 2, 14, 6, 0, Math.PI * 2, 0, Math.PI / 3.2), new THREE.MeshLambertMaterial({ color: '#ecebe4', side: THREE.DoubleSide }));
      dish.position.y = h * 0.62; dish.rotation.x = Math.PI / 2 + 0.6; g.add(dish);
      g.add(boxMesh(0.08, 0.08, w * 0.45, '#5b6266', 0, h * 0.62, w * 0.2));
      break;
    }
    case 'stack': {
      const pipe = new THREE.Mesh(new THREE.CylinderGeometry(w / 2, w / 2, h, 10), M('#8a8f93'));
      pipe.position.y = h / 2; g.add(pipe);
      const hat = new THREE.Mesh(new THREE.ConeGeometry(w * 0.8, 0.5, 10), M('#5b6266'));
      hat.position.y = h + 0.45; g.add(hat);
      break;
    }
    case 'stairhut':
      g.add(boxMesh(w, h, d, '#c9bfae'));
      g.add(boxMesh(w + 0.5, 0.3, d + 0.5, '#8a7f6e', 0, h, 0));
      g.add(boxMesh(1.8, 3.4, 0.12, '#6b5440', -w * 0.2, 0, d / 2 + 0.06));       // door, facing the launch
      g.add(boxMesh(0.15, 0.15, 0.1, '#f2c94c', -w * 0.2 + 0.6, 1.6, d / 2 + 0.14));
      break;
    default:
      g.add(boxMesh(w, h, d, '#999999'));
  }
  g.position.set(o.x, o.y || 0, -o.z);
  if (o.type === 'tv') g.position.y = o.y;
  return g;
}

// Meshes for moving obstacles. Origin at the bottom centre of the collision box.
function buildMover(m) {
  const g = new THREE.Group();
  const spin = [];
  switch (m.type) {
    case 'chair': {
      g.add(boxMesh(1.8, 0.4, 1.8, '#3d4b5c', 0, 1.5, 0));                 // seat
      g.add(boxMesh(1.8, 1.5, 0.3, '#3d4b5c', 0, 1.9, 0.75));              // back
      g.add(boxMesh(0.2, 1.2, 0.2, '#5b6266', 0, 0.3, 0));                 // gas lift
      const base = new THREE.Group();
      for (let i = 0; i < 5; i++) {
        const leg = boxMesh(1.1, 0.15, 0.2, '#2c2c2c', 0.55, 0.15, 0);
        const arm = new THREE.Group(); arm.rotation.y = i * Math.PI * 2 / 5; arm.add(leg); base.add(arm);
      }
      g.add(base); spin.push({ o: base, axis: 'y', rate: 2 });
      break;
    }
    case 'mailcart':
      g.add(boxMesh(3.2, 1.6, 2, '#8a8f93', 0, 0.6, 0));
      for (let i = 0; i < 6; i++) g.add(boxMesh(0.35, 0.9, 1.6, i % 2 ? '#f6efdc' : '#e9dcbc', -1.3 + i * 0.5, 2.2, 0));
      for (const sx of [-1.4, 1.4]) for (const sz of [-0.8, 0.8]) g.add(boxMesh(0.3, 0.6, 0.3, '#2c2c2c', sx, 0, sz));
      break;
    case 'trolley':
      g.add(boxMesh(3.4, 0.2, 2, '#b98a55', 0, 1.2, 0));
      g.add(boxMesh(3.4, 0.2, 2, '#b98a55', 0, 3.0, 0));
      for (const sx of [-1.6, 1.6]) for (const sz of [-0.9, 0.9]) g.add(boxMesh(0.15, 3.2, 0.15, '#6b5440', sx, 0, sz));
      for (let i = 0; i < 4; i++) {
        const cup = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.2, 0.5, 7), M(['#f6efdc', '#c1440e', '#1e4d6b', '#e0a526'][i]));
        cup.position.set(-1.2 + i * 0.8, 3.45, 0.2); g.add(cup);
      }
      break;
    case 'ball': {
      const ball = new THREE.Mesh(new THREE.IcosahedronGeometry(0.8, 1), M('#f08a3c'));
      ball.position.y = 0.8; g.add(ball);
      const band = new THREE.Mesh(new THREE.TorusGeometry(0.8, 0.07, 4, 16), M('#f6efdc'));
      band.position.y = 0.8; g.add(band);
      spin.push({ o: ball, axis: 'x', rate: 3 });
      break;
    }
    case 'robot': {
      g.add(boxMesh(2.2, 2.6, 2.2, '#c9ced2', 0, 0.3, 0));
      const head = new THREE.Mesh(new THREE.SphereGeometry(0.9, 8, 6, 0, Math.PI * 2, 0, Math.PI / 2), M('#8fb3d9'));
      head.position.y = 2.9; g.add(head);
      const eye = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.25, 0.1), new THREE.MeshBasicMaterial({ color: '#6fe08a' }));
      eye.position.set(0, 2.2, -1.12); g.add(eye);
      g.add(boxMesh(0.12, 0.9, 0.12, '#5b6266', 0, 3.6, 0));
      for (const sx of [-0.8, 0.8]) g.add(boxMesh(0.4, 0.4, 2.4, '#2c2c2c', sx, 0, 0));
      break;
    }
    case 'lift': {
      g.add(boxMesh(m.w, m.h, m.d, '#e0a526'));
      for (let i = 0; i < 5; i++) g.add(boxMesh(0.5, 0.05, m.d + 0.02, '#2c2416', -m.w / 2 + 0.7 + i * (m.w - 1.4) / 4, m.h, 0));
      // Cables up to the ceiling
      for (const sx of [-m.w / 2 + 0.3, m.w / 2 - 0.3]) {
        const c = boxMesh(0.06, 30, 0.06, '#2c2c2c', sx, m.h, 0); c.layers.set(1); g.add(c);
      }
      break;
    }
    case 'slidedoor': {
      const glass = new THREE.Mesh(new THREE.BoxGeometry(m.w, m.h, m.d),
        new THREE.MeshLambertMaterial({ color: '#bfe0ea', transparent: true, opacity: 0.35, depthWrite: false }));
      glass.position.y = m.h / 2; glass.layers.set(1); g.add(glass);
      g.add(boxMesh(m.w, 0.3, m.d + 0.1, '#5b6266', 0, 0, 0));
      g.add(boxMesh(m.w, 0.3, m.d + 0.1, '#5b6266', 0, m.h - 0.3, 0));
      for (const sx of [-1, 1]) g.add(boxMesh(0.2, m.h, m.d + 0.1, '#5b6266', sx * (m.w / 2 - 0.1), 0, 0));
      g.add(boxMesh(0.15, 1.6, 0.25, '#c9a97a', m.w / 2 - 0.6, m.h * 0.35, 0));
      break;
    }
    case 'drone': {
      g.add(boxMesh(0.9, 0.35, 0.9, '#2f3338', 0, 0.15, 0));
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.18, 6, 4), new THREE.MeshBasicMaterial({ color: '#c1440e' }));
      eye.position.set(0, 0.2, -0.5); g.add(eye);
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
        g.add(boxMesh(0.7, 0.08, 0.1, '#2f3338', sx * 0.45, 0.35, sz * 0.45));
        const rotor = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.04, 0.12), M('#d9d6cf'));
        rotor.position.set(sx * 0.8, 0.5, sz * 0.8); g.add(rotor);
        spin.push({ o: rotor, axis: 'y', rate: 30 });
      }
      break;
    }
    case 'pigeons': {
      // A loose flock; wings flap (see the flap entries)
      const spots = [[0, 0.7, 0], [-1.6, 0.4, 0.8], [1.5, 0.9, -0.6], [-0.7, 1.1, -1], [0.9, 0.2, 1], [-2.1, 0.9, -0.3]];
      spots.forEach(([x, y, z], i) => {
        const b = new THREE.Group(); b.position.set(x, y, z);
        b.add(boxMesh(0.35, 0.3, 0.7, '#8a8f9a', 0, -0.15, 0));
        b.add(boxMesh(0.25, 0.25, 0.25, '#6b7280', 0, 0.05, -0.4));
        for (const sx of [-1, 1]) {
          const wing = new THREE.Group(); wing.position.set(sx * 0.15, 0.05, 0);
          wing.add(boxMesh(0.8, 0.04, 0.45, '#a3a8b2', sx * 0.4, 0, 0));
          b.add(wing);
          spin.push({ o: wing, axis: 'z', flap: 0.8 * sx, rate: 14 + i, ph: i });
        }
        g.add(b);
      });
      break;
    }
    default:
      g.add(boxMesh(m.w, m.h, m.d, '#999999'));
  }
  // The meshes above are modelled at a reference size; stretch them to the
  // mover's actual collision box so what you see is what you hit.
  const REF = { chair: [2.2, 3.4, 2.2], mailcart: [3.4, 3.2, 2.2], trolley: [3.6, 3.7, 2.2] }[m.type];
  if (REF) g.scale.set(m.w / REF[0], m.h / REF[1], m.d / REF[2]);
  return { g, spin };
}

function clipGeometry() {
  const pts = [
    [-0.12, -0.2], [-0.12, 0.25], [-0.06, 0.33], [0.06, 0.33], [0.12, 0.25], [0.12, -0.36],
    [0.05, -0.45], [-0.13, -0.45], [-0.2, -0.36], [-0.2, 0.36], [-0.12, 0.45], [0.12, 0.45], [0.2, 0.36], [0.2, -0.05],
  ].map(([x, y]) => new THREE.Vector3(x * 1.6, y * 1.6, 0));
  return new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts, false, 'catmullrom', 0.2), 64, 0.045, 5, false);
}

/* ---------------------------------------------------------- renderer --- */

export function createRenderer(canvas, { reduceMotion = false } = {}) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  const ink = createInk(renderer);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#cfe2ea');   // sky, seen through open windows
  const camera = new THREE.PerspectiveCamera(58, 16 / 9, 0.1, 320);
  camera.layers.enable(1);
  camera.position.set(0, 9, 12);

  scene.add(new THREE.HemisphereLight('#fffaf0', '#b8a888', 2.1));
  scene.add(new THREE.AmbientLight('#fff4e0', 0.9));
  const sun = new THREE.DirectionalLight('#fff1d6', 1.5);
  sun.position.set(-20, 40, 10);
  scene.add(sun);
  const fill = new THREE.DirectionalLight('#cfe0ff', 0.45);
  fill.position.set(25, 10, -40);
  scene.add(fill);

  let env = new THREE.Group();
  scene.add(env);
  const planeLayer = new THREE.Group();
  scene.add(planeLayer);

  let floor = null;
  const anims = { fans: [], vents: [], blowers: [], clips: [], signs: [], leds: [], movers: [] };
  const planes = new Map();   // seat -> { root, shadow, trail, trailPts, aim }
  const TRAIL_N = 26;
  const dotGeo = new THREE.SphereGeometry(0.07, 5, 4);
  const tmpM = new THREE.Matrix4();

  // Slipstream doodles: two inky ribbons streaming off the wing tips while a
  // trick speed boost lasts. Points age out, so the lines shrink away after.
  const SLIP_N = 28, SLIP_LIFE = 0.55;
  const slipMat = new THREE.MeshBasicMaterial({ color: '#2c2416', transparent: true, opacity: 0.85, side: THREE.DoubleSide, depthWrite: false });
  function makeSlipLine() {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(SLIP_N * 2 * 3), 3));
    const idx = [];
    for (let i = 0; i < SLIP_N - 1; i++) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    geo.setIndex(idx);
    geo.setDrawRange(0, 0);
    const m = new THREE.Mesh(geo, slipMat);
    m.frustumCulled = false;
    m.layers.set(1);
    return { m, pts: [] };   // pts: { x, y, z, age }
  }
  const _tip = new THREE.Vector3(), _seg = new THREE.Vector3(), _side = new THREE.Vector3(), _view = new THREE.Vector3();
  function updateSlipLine(line, emit, worldTip, dt, boil) {
    for (const q of line.pts) q.age += dt;
    while (line.pts.length && line.pts[0].age > SLIP_LIFE) line.pts.shift();
    if (emit) {
      line.pts.push({ x: worldTip.x, y: worldTip.y, z: worldTip.z, age: 0 });
      if (line.pts.length > SLIP_N) line.pts.shift();
    }
    const n = line.pts.length, pos = line.m.geometry.attributes.position;
    if (n < 2) { line.m.geometry.setDrawRange(0, 0); line.m.visible = false; return; }
    line.m.visible = true;
    for (let i = 0; i < n; i++) {
      const q = line.pts[i], nb = line.pts[Math.min(n - 1, i + 1)], pb = line.pts[Math.max(0, i - 1)];
      _seg.set(nb.x - pb.x, nb.y - pb.y, nb.z - pb.z);
      _view.set(q.x - camera.position.x, q.y - camera.position.y, q.z - camera.position.z);
      _side.crossVectors(_seg, _view).normalize();
      // Thin pencil stroke: fattest near the wing, tapering and thinning with age
      const k = (i + 1) / n, w = 0.05 * k * (1 - q.age / SLIP_LIFE) + 0.008;
      // Hand-drawn jitter that "boils" with the ink shader's 6 fps redraw
      const j = Math.sin(i * 2.7 + boil * 5.1) * 0.03 * (1 - k);
      pos.setXYZ(i * 2, q.x + _side.x * (w + j), q.y + _side.y * (w + j), q.z + _side.z * (w + j));
      pos.setXYZ(i * 2 + 1, q.x - _side.x * (w - j), q.y - _side.y * (w - j), q.z - _side.z * (w - j));
    }
    pos.needsUpdate = true;
    line.m.geometry.setDrawRange(0, (n - 1) * 6);
  }
  function boost(seat, amount = 3) {
    const v = planes.get(seat);
    if (v) v.boostT = Math.max(v.boostT || 0, 0.7 + amount * 0.18);
  }
  const clipGeo = clipGeometry();
  const clipMat = lam('#c3cad1', { emissive: '#2d3238' });
  const shadowMat = new THREE.MeshBasicMaterial({ color: '#2c2416', transparent: true, opacity: 0.22, depthWrite: false });
  const streakMat = new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthWrite: false });

  /* -------------------------------------------------------- particles --- */
  const bits = [];
  const bitGeo = new THREE.BufferGeometry();
  bitGeo.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 0.22, 0.05, 0, 0.05, 0.2, 0.02], 3));
  bitGeo.computeVertexNormals();
  for (let i = 0; i < 260; i++) {
    const m = new THREE.Mesh(bitGeo, lam('#ffffff', { side: THREE.DoubleSide }));
    m.visible = false;
    scene.add(m);
    bits.push({ m, v: new THREE.Vector3(), life: 0, spin: new THREE.Vector3() });
  }
  let bitIx = 0;
  function burst(x, y, z, color = '#ffffff', n = 14, speed = 4) {
    const k = reduceMotion ? Math.ceil(n / 3) : n;
    for (let i = 0; i < k; i++) {
      const b = bits[bitIx++ % bits.length];
      b.m.visible = true;
      b.m.material.color.set(color);
      b.m.position.set(x, y, -z);
      b.v.set((Math.random() - 0.5) * speed, Math.random() * speed * 0.8 + 1, (Math.random() - 0.5) * speed);
      b.spin.set(Math.random() * 8, Math.random() * 8, Math.random() * 8);
      b.life = 0.9 + Math.random() * 0.5;
    }
  }

  // Confetti in several colours (zone landings, wins)
  function confetti(x, y, z, colors, n = 30) {
    for (let i = 0; i < n; i++) burst(x, y, z, colors[i % colors.length], 1, 6);
  }
  // Air streaks around a plane entering a draft
  function gust(x, y, z, dir) {
    const k = reduceMotion ? 3 : 10;
    for (let i = 0; i < k; i++) {
      const b = bits[bitIx++ % bits.length];
      b.m.visible = true;
      b.m.material.color.set('#ffffff');
      b.m.position.set(x + (Math.random() - 0.5) * 2, y + (Math.random() - 0.5) * 1.5, -z + (Math.random() - 0.5) * 2);
      b.v.set(dir === 'side' ? (Math.random() - 0.5) * 12 : (Math.random() - 0.5) * 2, dir === 'side' ? (Math.random() - 0.5) * 2 : (dir === 'up' ? 1 : -1) * (6 + Math.random() * 4), (Math.random() - 0.5) * 2);
      b.spin.set(0, Math.random() * 4, 0);
      b.life = 0.5;
      b.noGrav = true;
    }
  }

  // Expanding ink rings on the floor (zone landings)
  const rings = [];
  const ringGeo = new THREE.RingGeometry(0.85, 1, 32);
  function ring(x, y, z, color, size = 6) {
    const m = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false }));
    m.rotation.x = -Math.PI / 2;
    m.position.set(x, y + 0.06, -z);
    m.layers.set(1);
    scene.add(m);
    rings.push({ m, t: 0, size });
  }

  // Per-plane wobble when hit
  const wobble = new Map();
  const hitPlane = seat => { if (!reduceMotion) wobble.set(seat, 1); };

  // Field of view widens with speed and "punches" on big moments
  let fovKick = 0, fovSpeed = 0, baseFov = 58;
  const punch = amt => { if (!reduceMotion) fovKick = Math.min(14, fovKick + amt); };
  let sepia = 0, sepiaTarget = 0;
  const setSepia = v => { sepiaTarget = v; };

  let shakeAmt = 0;
  const shake = m => { if (!reduceMotion) shakeAmt = Math.min(0.6, shakeAmt + m); };

  /* ---------------------------------------------------------- rooftop --- */
  // Building faces: rows of windows, a few lit
  function facadeTexture(wall, cols, rows) {
    const c = document.createElement('canvas'); c.width = 256; c.height = 256;
    const g = c.getContext('2d');
    g.fillStyle = wall; g.fillRect(0, 0, 256, 256);
    const cw = 256 / cols, rh = 256 / rows;
    for (let i = 0; i < cols; i++) for (let j = 0; j < rows; j++) {
      g.fillStyle = Math.random() < 0.18 ? '#f4dc8a' : '#7f97a8';
      g.fillRect(i * cw + cw * 0.2, j * rh + rh * 0.22, cw * 0.6, rh * 0.5);
      g.strokeStyle = '#2c2416'; g.lineWidth = 2; g.strokeRect(i * cw + cw * 0.2, j * rh + rh * 0.22, cw * 0.6, rh * 0.5);
    }
    const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }
  // One building: gravel roof on top, windowed walls down to the street
  function building(x0, x1, z0, z1, top, bottom, wall, roofTex) {
    const w = x1 - x0, d = z1 - z0, h = top - bottom;
    const tex = facadeTexture(wall, 4, 4);
    const sideTex = tex.clone(); sideTex.needsUpdate = true; sideTex.repeat.set(d / 14, h / 14);
    const endTex = tex.clone(); endTex.needsUpdate = true; endTex.repeat.set(w / 14, h / 14);
    const mSide = new THREE.MeshLambertMaterial({ map: sideTex }), mEnd = new THREE.MeshLambertMaterial({ map: endTex });
    const roof = new THREE.MeshLambertMaterial({ map: roofTex });
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), [mSide, mSide, roof, roof, mEnd, mEnd]);
    m.position.set((x0 + x1) / 2, (top + bottom) / 2, -(z0 + z1) / 2);
    env.add(m);
    return m;
  }
  function buildRooftop(f, W, H, L, zBack) {
    const g = f.gap, street = -g.depth;
    const gravel = (len) => { const t = speckleTexture(f.carpet, '#3b3f45', 2600, 256, 0); t.repeat.set(W / 10, len / 10); return t; };
    // The start building and the lower finish building
    building(-W / 2 - 0.5, W / 2 + 0.5, -zBack - 20, g.z0, 0, street, '#c9bfae', gravel(g.z0 + zBack + 20));
    building(-W / 2 - 0.5, W / 2 + 0.5, g.z1, L + 30, -g.drop, street, '#b9c3c9', gravel(L + 30 - g.z1));
    // Roof access hut behind the launch desk (you came up the stairs)
    env.add(boxMesh(12, 7, 6, '#c9bfae', 0, 0, zBack + 8));
    env.add(boxMesh(13, 0.4, 7, '#8a7f6e', 0, 7, zBack + 8));
    env.add(boxMesh(2.2, 4, 0.12, '#6b5440', 0, 0, zBack + 4.94));
    // The city floor, so nothing floats
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(4000, 4000), M('#a39e94'));
    ground.rotation.x = -Math.PI / 2; ground.position.set(0, street - 0.08, -L / 2); env.add(ground);
    // Down below: a big city park fills the gap between the two buildings
    // (trees, dirt paths, a pond), and a grid of streets and towers fills the
    // rest of the view. Everything repeated is instanced so it stays cheap.
    let seed = (f.seed || 1) >>> 0;
    const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    const rr = (a, b) => a + (b - a) * rnd();
    const tmpO = new THREE.Object3D(), tmpC = new THREE.Color();
    const instanced = (geo, mat, items, place) => {
      const m = new THREE.InstancedMesh(geo, mat, Math.max(1, items.length));
      items.forEach((it, i) => { place(tmpO, it); tmpO.updateMatrix(); m.setMatrixAt(i, tmpO.matrix); if (it.c) m.setColorAt(i, tmpC.set(it.c)); });
      m.count = items.length;
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
      env.add(m);
      return m;
    };
    const PX = 150;                                   // the park's half-width
    const pz0 = g.z0 + 14, pz1 = g.z1 - 14;           // a street runs along each building face
    // Grass
    const grassTex = speckleTexture('#7fa05a', '#4f6b36', 3000, 256, 0); grassTex.repeat.set(PX / 6, (pz1 - pz0) / 12);
    const grass = new THREE.Mesh(new THREE.PlaneGeometry(PX * 2, pz1 - pz0), new THREE.MeshLambertMaterial({ map: grassTex }));
    grass.rotation.x = -Math.PI / 2; grass.position.set(0, street + 0.03, -(pz0 + pz1) / 2); env.add(grass);

    // Ponds: one big, one small
    const ponds = [
      { x: rr(-60, 60), z: rr(pz0 + (pz1 - pz0) * 0.3, pz0 + (pz1 - pz0) * 0.6), rx: rr(40, 55), rz: rr(60, 90) },
      { x: rr(-90, 90), z: rr(pz0 + (pz1 - pz0) * 0.75, pz1 - 60), rx: rr(18, 26), rz: rr(22, 34) },
    ];
    for (const pd of ponds) {
      const rim = new THREE.Mesh(new THREE.CircleGeometry(1, 40), M('#c9b48a'));
      rim.rotation.x = -Math.PI / 2; rim.scale.set(pd.rx + 2.5, pd.rz + 2.5, 1); rim.position.set(pd.x, street + 0.06, -pd.z); env.add(rim);
      const water = new THREE.Mesh(new THREE.CircleGeometry(1, 40), new THREE.MeshLambertMaterial({ color: '#5f93b0' }));
      water.rotation.x = -Math.PI / 2; water.scale.set(pd.rx, pd.rz, 1); water.position.set(pd.x, street + 0.09, -pd.z); env.add(water);
      // a little jetty
      env.add(boxMesh(3, 0.3, 12, '#8a6a48', pd.x + pd.rx * 0.7, street + 0.1, -(pd.z - pd.rz * 0.2)));
    }
    const inPond = (x, z, pad) => ponds.some(pd => ((x - pd.x) / (pd.rx + pad)) ** 2 + ((z - pd.z) / (pd.rz + pad)) ** 2 < 1);

    // Dirt paths: a few winding ones down the park, and cross paths
    const pathSegs = [];
    const addPath = (pts) => { for (let i = 1; i < pts.length; i++) pathSegs.push({ a: pts[i - 1], b: pts[i] }); };
    for (let k = 0; k < 3; k++) {
      const base = -PX * 0.6 + k * PX * 0.6, amp = rr(15, 35), ph = rr(0, 6), wl = rr(90, 160), pts = [];
      for (let z = pz0; z <= pz1; z += 6) {
        let x = base + Math.sin(z / wl + ph) * amp;
        // swing around the ponds
        for (const pd of ponds) {
          const dz = (z - pd.z) / (pd.rz + 8);
          if (Math.abs(dz) < 1 && Math.abs(x - pd.x) < pd.rx + 8) x = pd.x + Math.sign(x - pd.x || 1) * (pd.rx + 8) * Math.sqrt(Math.max(0, 1 - dz * dz)) + Math.sign(x - pd.x || 1) * 2;
        }
        pts.push([x, z]);
      }
      addPath(pts);
    }
    for (let z = pz0 + rr(40, 80); z < pz1 - 30; z += rr(90, 150)) {
      const pts = [];
      for (let x = -PX; x <= PX; x += 8) pts.push([x, z + Math.sin(x / 30 + z) * 6]);
      if (!pts.some(([x, zz]) => inPond(x, zz, 2))) addPath(pts);
    }
    instanced(new THREE.BoxGeometry(1, 0.06, 1), M('#b08d5f'), pathSegs, (o, s) => {
      const dx = s.b[0] - s.a[0], dz = s.b[1] - s.a[1];
      o.position.set((s.a[0] + s.b[0]) / 2, street + 0.07, -(s.a[1] + s.b[1]) / 2);
      o.rotation.set(0, Math.atan2(dx, dz), 0);
      o.scale.set(3.2, 1, Math.hypot(dx, dz) + 1.5);
    });
    const nearPath = (x, z, pad) => pathSegs.some(({ a, b }) => {
      const dx = b[0] - a[0], dz = b[1] - a[1], L2 = dx * dx + dz * dz || 1;
      const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / L2));
      return Math.hypot(x - a[0] - t * dx, z - a[1] - t * dz) < pad;
    });

    // Trees, packed in tight
    const trees = [];
    const greens = ['#4f7a3a', '#5e8a3f', '#3f6b35', '#6d9445', '#7a9a3c', '#557f46'];
    for (let tries = 0; trees.length < 2600 && tries < 16000; tries++) {
      const x = rr(-PX + 3, PX - 3), z = rr(pz0 + 3, pz1 - 3);
      if (inPond(x, z, 3) || nearPath(x, z, 4)) continue;
      trees.push({ x, z, h: rr(6, 12), r: rr(2.6, 4.6), c: greens[(rnd() * greens.length) | 0] });
    }
    instanced(new THREE.CylinderGeometry(0.35, 0.5, 1, 6), M('#5b4636'), trees, (o, t) => { o.position.set(t.x, street + t.h * 0.3, -t.z); o.rotation.set(0, 0, 0); o.scale.set(1, t.h * 0.6, 1); });
    instanced(new THREE.IcosahedronGeometry(1, 0), new THREE.MeshLambertMaterial({ color: '#ffffff', flatShading: true }), trees,
      (o, t) => { o.position.set(t.x, street + t.h * 0.62, -t.z); o.rotation.set(t.x, t.z, 0); o.scale.set(t.r, t.r * 1.15, t.r); });
    // Benches and lamp posts along the paths
    const bits = pathSegs.filter((_, i) => i % 9 === 0).map(s => ({ x: s.a[0] + 3, z: s.a[1] }));
    instanced(new THREE.BoxGeometry(1, 1, 1), M('#6b5440'), bits, (o, b) => { o.position.set(b.x, street + 0.5, -b.z); o.rotation.set(0, 0, 0); o.scale.set(0.8, 1, 2.4); });

    // City grid around the park: streets every block, towers on the blocks
    const BLOCK = 64, ROAD = 10, X0 = -460, X1 = 460, Z0 = -160, Z1 = L + 260;
    const roadsX = [], roadsZ = [];
    for (let x = X0; x <= X1; x += BLOCK) roadsX.push(x);                      // streets running along z
    for (let z = Z0; z <= Z1; z += BLOCK) roadsZ.push(z);                      // cross streets
    roadsZ.push(g.z0 + 7, g.z1 - 7);                                           // along each building face
    roadsX.push(-PX - 6, PX + 6);                                              // the park's edges
    // Streets stop at the park's edge (the park has its own paths)
    const inPark = (x, z, pad = 0) => Math.abs(x) < PX + pad && z > pz0 - pad && z < pz1 + pad;
    const segs = [];
    for (const x of roadsX) {
      if (Math.abs(x) < PX + 5) { segs.push({ x0: x - ROAD / 2, x1: x + ROAD / 2, z0: Z0, z1: pz0 }, { x0: x - ROAD / 2, x1: x + ROAD / 2, z0: pz1, z1: Z1 }); }
      else segs.push({ x0: x - ROAD / 2, x1: x + ROAD / 2, z0: Z0, z1: Z1 });
    }
    for (const z of roadsZ) {
      if (z > pz0 && z < pz1) { segs.push({ x0: X0, x1: -PX - 1, z0: z - ROAD / 2, z1: z + ROAD / 2 }, { x0: PX + 1, x1: X1, z0: z - ROAD / 2, z1: z + ROAD / 2 }); }
      else segs.push({ x0: X0, x1: X1, z0: z - ROAD / 2, z1: z + ROAD / 2 });
    }
    instanced(new THREE.BoxGeometry(1, 0.1, 1), new THREE.MeshLambertMaterial({ color: '#5d6066' }), segs,
      (o, r) => { o.position.set((r.x0 + r.x1) / 2, street + 0.01, -(r.z0 + r.z1) / 2); o.rotation.set(0, 0, 0); o.scale.set(r.x1 - r.x0, 1, r.z1 - r.z0); });
    // centre-line dashes
    const dashes = [];
    for (const x of roadsX) for (let z = Z0; z < Z1; z += 12) if (!inPark(x, z, 1)) dashes.push({ x, z, along: true });
    for (const z of roadsZ) for (let x = X0; x < X1; x += 12) if (!inPark(x, z, 1)) dashes.push({ x, z, along: false });
    instanced(new THREE.BoxGeometry(1, 0.05, 1), M('#e8dfa8'), dashes, (o, d) => { o.position.set(d.x, street + 0.08, -d.z); o.rotation.set(0, 0, 0); o.scale.set(d.along ? 0.35 : 4, 1, d.along ? 4 : 0.35); });
    // Cars on the streets
    const carCols = ['#c1440e', '#1e4d6b', '#e0a526', '#3d6b52', '#efe6d0', '#8b3a2e'];
    const cars = [];
    for (let i = 0; i < 160; i++) {
      const along = rnd() < 0.5;
      if (along) { const x = roadsX[(rnd() * roadsX.length) | 0] + (rnd() < 0.5 ? -2.5 : 2.5); cars.push({ x, z: rr(Z0, Z1), along, c: carCols[i % 6] }); }
      else { const z = roadsZ[(rnd() * roadsZ.length) | 0] + (rnd() < 0.5 ? -2.5 : 2.5); cars.push({ x: rr(X0, X1), z, along, c: carCols[i % 6] }); }
      if (inPark(cars[cars.length - 1].x, cars[cars.length - 1].z, 2)) cars.pop();
    }
    instanced(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshLambertMaterial({ color: '#ffffff' }), cars,
      (o, c) => { o.position.set(c.x, street + 0.8, -c.z); o.rotation.set(0, c.along ? 0 : Math.PI / 2, 0); o.scale.set(2, 1.5, 4.4); });

    // Towers fill every block that isn't the park or one of our two buildings
    const towers = [];
    const sky = ['#9fb3c4', '#b6c4cf', '#8ea3b5', '#c3cdd5', '#a9b7c2', '#c9bfae', '#b9a998'];
    const xsB = [...new Set(roadsX)].sort((a, b) => a - b), zsB = [...new Set(roadsZ)].sort((a, b) => a - b);
    for (let i = 0; i + 1 < xsB.length; i++) for (let j = 0; j + 1 < zsB.length; j++) {
      const bx0 = xsB[i] + ROAD / 2 + 1.5, bx1 = xsB[i + 1] - ROAD / 2 - 1.5, bz0 = zsB[j] + ROAD / 2 + 1.5, bz1 = zsB[j + 1] - ROAD / 2 - 1.5;
      if (bx1 - bx0 < 8 || bz1 - bz0 < 8) continue;
      const cx = (bx0 + bx1) / 2, cz = (bz0 + bz1) / 2;
      if (Math.abs(cx) < PX + 6 && cz > g.z0 && cz < g.z1) continue;          // the park
      if (bx1 > -W / 2 - 4 && bx0 < W / 2 + 4 && (bz0 < g.z0 || bz1 > g.z1)) continue;   // our buildings
      // 1-4 towers per block, taller further from the run
      const n = 1 + ((rnd() * 4) | 0), far = Math.min(1, Math.abs(cx) / 400);
      for (let k = 0; k < n; k++) {
        const w = (bx1 - bx0) / (n > 2 ? 2 : 1), d = (bz1 - bz0) / (n > 1 ? 2 : 1);
        const tx = n > 2 ? bx0 + w * ((k % 2) + 0.5) : cx, tz = n > 1 ? bz0 + d * ((k >> (n > 2 ? 1 : 0)) % 2 + 0.5) : cz;
        const h = rr(20, 55) + far * rr(10, 70);
        towers.push({ x: tx, z: tz, w: w - 2, d: d - 2, h, c: sky[(rnd() * sky.length) | 0] });
      }
    }
    const towerTex = facadeTexture('#ffffff', 4, 6);
    towerTex.repeat.set(2, 3);
    instanced(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshLambertMaterial({ color: '#ffffff', map: towerTex }), towers,
      (o, t) => { o.position.set(t.x, street + t.h / 2, -t.z); o.rotation.set(0, 0, 0); o.scale.set(t.w, t.h, t.d); });

    // Wind in the gap: crosswind streaks, and gust streaks below the roofline
    const streaks = [];
    for (let i = 0; i < 70; i++) {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(1.4, 0.07), streakMat);
      m.layers.set(1); env.add(m);
      streaks.push({ m, t: Math.random(), y: -16 + Math.random() * 22, z: g.z0 + Math.random() * (g.z1 - g.z0), x: (Math.random() - 0.5) * W });
    }
    anims.gap = { g, W, streaks };
  }

  /* ------------------------------------------------------------ floor --- */
  function setFloor(f) {
    floor = f;
    // Long floors: see all the way to the far wall.
    camera.far = f.length + 120;
    camera.updateProjectionMatrix();
    scene.remove(env);
    env.traverse(o => { if (o.geometry && o.geometry !== clipGeo) o.geometry.dispose(); });
    env = new THREE.Group();
    scene.add(env);
    for (const k in anims) anims[k] = [];
    anims.outside = null; anims.gap = null;

    const W = f.width, H = f.height, L = f.length;
    const zBack = 24, zEnd = L;
    const len = zEnd + zBack;
    const midZ = -(zEnd - zBack) / 2;

    if (f.open) buildRooftop(f, W, H, L, zBack);
    else {
    // Carpet
    const carpetTex = speckleTexture(f.carpet, '#2c2416', 2200, 256, 2);
    carpetTex.repeat.set(W / 8, len / 8);
    // Duct holes are cut right through the floor / ceiling
    const holes = kind => (f.ducts || []).filter(d => d.kind === kind).flatMap(d => [d.ez, d.xz].map(gz => ({ x: d.x, z: gz, hx: d.half, hz: d.hole })));
    const holedPlane = (hs, toY) => {
      if (!hs.length) return new THREE.PlaneGeometry(W, len);
      const sh = new THREE.Shape();
      sh.moveTo(-W / 2, -len / 2); sh.lineTo(W / 2, -len / 2); sh.lineTo(W / 2, len / 2); sh.lineTo(-W / 2, len / 2); sh.closePath();
      for (const h of hs) {
        const y = toY(h.z), hp = new THREE.Path();
        hp.moveTo(h.x - h.hx, y - h.hz); hp.lineTo(h.x - h.hx, y + h.hz); hp.lineTo(h.x + h.hx, y + h.hz); hp.lineTo(h.x + h.hx, y - h.hz); hp.closePath();
        sh.holes.push(hp);
      }
      const g = new THREE.ShapeGeometry(sh);
      // ShapeGeometry UVs are in world units; remap to 0..1 like a PlaneGeometry
      const uv = g.attributes.uv;
      for (let i = 0; i < uv.count; i++) uv.setXY(i, (uv.getX(i) + W / 2) / W, (uv.getY(i) + len / 2) / len);
      return g;
    };
    const floorMesh = new THREE.Mesh(holedPlane(holes('floor'), gz => midZ + gz), new THREE.MeshLambertMaterial({ map: carpetTex }));
    floorMesh.rotation.x = -Math.PI / 2;
    floorMesh.position.set(0, 0, midZ);
    env.add(floorMesh);

    // Ceiling tiles with light panels
    const ceilTex = speckleTexture('#efe9dc', '#8a7a62', 800, 128, 2);
    ceilTex.repeat.set(W / 4, len / 4);
    const ceil = new THREE.Mesh(holedPlane(holes('ceil'), gz => -gz - midZ), new THREE.MeshBasicMaterial({ map: ceilTex, side: THREE.DoubleSide, color: '#e6dfcf' }));
    ceil.rotation.x = Math.PI / 2;
    ceil.position.set(0, H, midZ);
    env.add(ceil);
    for (let z = 0; z < L; z += 22) {
      for (const x of [-11, 11]) {
        if (holes('ceil').some(h => Math.abs(h.x - x) < h.hx + 3.5 && Math.abs(h.z - (z + 8)) < h.hz + 2)) continue;
        const p = new THREE.Mesh(new THREE.BoxGeometry(5, 0.1, 2.4), new THREE.MeshBasicMaterial({ color: '#fffaf0' }));
        p.position.set(x, H - 0.05, -z - 8);
        env.add(p);
      }
    }

    // Side walls with windows, plus skirting
    const wallMat = M(f.wall);
    for (const s of [-1, 1]) {
      // Open shortcut windows punch real holes in the wall
      const holes = (f.windows || []).filter(w => w.side === s).sort((a, b) => a.z - b.z);
      let zc = -zBack;
      const wallSeg = (z0, z1, y0, y1) => {
        if (z1 - z0 < 0.05 || y1 - y0 < 0.05) return;
        const m = new THREE.Mesh(new THREE.BoxGeometry(0.4, y1 - y0, z1 - z0), wallMat);
        m.position.set(s * (W / 2 + 0.2), (y0 + y1) / 2, -(z0 + z1) / 2);
        env.add(m);
      };
      for (const w of holes) {
        wallSeg(zc, w.z - w.half, 0, H);
        wallSeg(w.z - w.half, w.z + w.half, 0, w.y0);
        wallSeg(w.z - w.half, w.z + w.half, w.y1, H);
        zc = w.z + w.half;
        // Frame and a sash swung wide open
        const fx = s * (W / 2 + 0.2);
        env.add(boxMesh(0.6, 0.35, w.half * 2 + 0.6, '#f6efdc', fx, w.y0 - 0.35, -w.z));
        env.add(boxMesh(0.6, 0.3, w.half * 2 + 0.6, '#f6efdc', fx, w.y1, -w.z));
        for (const e of [-1, 1]) env.add(boxMesh(0.6, w.y1 - w.y0, 0.3, '#f6efdc', fx, w.y0, -(w.z + e * w.half)));
        const sash = new THREE.Group();
        const glass = new THREE.Mesh(new THREE.BoxGeometry(0.08, w.y1 - w.y0 - 0.4, w.half * 2 - 0.4),
          new THREE.MeshLambertMaterial({ color: '#bfe0ea', transparent: true, opacity: 0.35, depthWrite: false }));
        glass.layers.set(1);
        glass.position.set(0, 0, -(w.half - 0.2));
        sash.add(glass, boxMesh(0.12, 0.2, w.half * 2 - 0.2, '#8a8f93', 0, (w.y1 - w.y0) / 2 - 0.3, -(w.half - 0.1)));
        sash.position.set(fx + s * 0.3, (w.y0 + w.y1) / 2, -(w.z - w.half));
        sash.rotation.y = -s * 1.1;     // hinged outward
        env.add(sash);
        // Hazard tape on the sill so it reads as "go here"
        for (let i = 0; i < 6; i++) env.add(boxMesh(0.62, 0.06, 0.55, i % 2 ? '#2c2416' : '#f2c94c', fx, w.y0 - 0.02, -(w.z - w.half + 0.6 + i * (w.half * 2 - 1.2) / 5)));
      }
      wallSeg(zc, zEnd, 0, H);
      env.add(Object.assign(boxMesh(0.2, 0.6, len, '#6b5440', s * (W / 2 - 0.05), 0, midZ)));
      for (let z = 6; z < L; z += 18) {
        if (holes.some(w => Math.abs(w.z - (z + 5)) < w.half + 7)) continue;
        const pane = new THREE.Mesh(new THREE.BoxGeometry(0.1, H * 0.45, 10), new THREE.MeshBasicMaterial({ color: '#cfe6ee' }));
        pane.position.set(s * (W / 2 - 0.02), H * 0.55, -z - 5);
        env.add(pane);
        env.add(boxMesh(0.15, 0.25, 10.4, '#8a8f93', s * (W / 2 - 0.05), H * 0.32, -z - 5));
        env.add(boxMesh(0.15, 0.25, 10.4, '#8a8f93', s * (W / 2 - 0.05), H * 0.78 - 0.25, -z - 5));
        env.add(boxMesh(0.15, H * 0.46, 0.25, '#8a8f93', s * (W / 2 - 0.05), H * 0.32, -z - 5));
      }
    }
    // Outside the window run: a stone ledge, the facade below, a city skyline,
    // and wind streaks blowing away from the building.
    if (f.ledge) {
      const Lg = f.ledge, s = Lg.side, lz0 = Lg.z0 - 10, lz1 = Lg.z1 + 10;
      env.add(boxMesh(1.4, 0.35, lz1 - lz0, '#c9bfae', s * (W / 2 + 1.1), Lg.sill - 0.35, -(lz0 + lz1) / 2));
      // the building's face continuing below this floor (the wall itself has the window holes)
      const facade = new THREE.Mesh(new THREE.BoxGeometry(0.3, 40, lz1 - lz0 + 80), M('#d8cfbf'));
      facade.position.set(s * (W / 2 + 0.55), -20, -(lz0 + lz1) / 2);
      env.add(facade);
      const sky = ['#9fb3c4', '#b6c4cf', '#8ea3b5', '#c3cdd5'];
      for (let i = 0; i < 14; i++) {
        const bh = 20 + ((i * 37) % 50), bw = 14 + ((i * 13) % 18);
        const b = new THREE.Mesh(new THREE.BoxGeometry(bw, bh, bw), M(sky[i % 4]));
        b.position.set(s * (W / 2 + 55 + (i % 3) * 30), bh / 2 - 30, -(lz0 - 60 + i * ((lz1 - lz0 + 120) / 14)));
        b.layers.set(1);
        env.add(b);
      }
      const streaks = [];
      for (let i = 0; i < 18; i++) {
        const m = new THREE.Mesh(new THREE.PlaneGeometry(1.2, 0.06), streakMat);
        m.layers.set(1); env.add(m);
        streaks.push({ m, t: Math.random(), y: Lg.sill + 1 + Math.random() * 8, z: Lg.z0 + Math.random() * (Lg.z1 - Lg.z0) });
      }
      anims.outside = { s, W, depth: Lg.depth, streaks };
    }

    // Ducts: a metal tunnel above the ceiling or under the floor. The holes
    // cut in the ceiling / floor show straight into it.
    for (const d of f.ducts || []) {
      const dl = d.z1 - d.z0, dh = d.y1 - d.y0;
      const tube = new THREE.Mesh(new THREE.BoxGeometry(d.half * 2, dh, dl), new THREE.MeshLambertMaterial({ color: '#b4bcc2', side: THREE.BackSide }));
      tube.position.set(d.x, (d.y0 + d.y1) / 2, -(d.z0 + d.z1) / 2);
      env.add(tube);
      for (let z = d.z0 + 3; z < d.z1; z += 5) {
        const rib = new THREE.Mesh(new THREE.BoxGeometry(d.half * 2 - 0.02, 0.1, 0.18), M('#7a8590'));
        rib.position.set(d.x, d.kind === 'ceil' ? d.y1 - 0.06 : d.y0 + 0.06, -z);
        env.add(rib);
      }
      for (const gz of [d.ez, d.xz]) {
        const gy = d.kind === 'ceil' ? H - 0.03 : 0.03;
        // Hazard-yellow trim around the hole, flush with the ceiling / floor
        for (const [ox, oz, w2, d2] of [[0, -d.hole - 0.15, d.half * 2 + 0.6, 0.3], [0, d.hole + 0.15, d.half * 2 + 0.6, 0.3],
          [-d.half - 0.15, 0, 0.3, d.hole * 2], [d.half + 0.15, 0, 0.3, d.hole * 2]]) {
          const fr = new THREE.Mesh(new THREE.BoxGeometry(w2, 0.06, d2), M('#f2c94c'));
          fr.position.set(d.x + ox, gy, -(gz + oz));
          env.add(fr);
        }
        // The removed grate, propped beside the hole
        const g = new THREE.Group();
        for (let i = -2; i <= 2; i++) g.add(boxMesh(0.12, 0.05, d.hole * 1.6, '#5b6266', i * 0.6, 0, 0));
        g.position.set(d.x + d.half + 1.6, gy + (d.kind === 'ceil' ? -0.05 : 0.02), -gz);
        env.add(g);
      }
    }

    // End wall and back wall
    const endWall = new THREE.Mesh(new THREE.BoxGeometry(W, H, 0.4), wallMat);
    endWall.position.set(0, H / 2, -zEnd - 0.2);
    env.add(endWall);
    const backWall = endWall.clone();
    backWall.position.z = zBack + 0.2;
    env.add(backWall);
    if (f.id === 'lobby') {
      // Elevator doors behind the top zone
      env.add(boxMesh(10, 9, 0.3, '#b9c1c9', 0, 0, -zEnd + 0.05));
      env.add(boxMesh(0.12, 8.6, 0.35, '#5b6266', 0, 0, -zEnd + 0.1));
      env.add(boxMesh(10.8, 0.6, 0.4, '#8a8f93', 0, 9, -zEnd + 0.1));
    } else {
      const big = new THREE.Mesh(new THREE.BoxGeometry(W * 0.7, H * 0.5, 0.1), new THREE.MeshBasicMaterial({ color: '#cfe6ee' }));
      big.position.set(0, H * 0.55, -zEnd + 0.05);
      env.add(big);
    }
    // Floor number painted on the back wall above the launch desk
    const numTex = labelTexture([{ text: `Floor ${f.number}`, bold: true }], { w: 512, h: 160, bg: f.wall, border: false });
    const num = new THREE.Mesh(new THREE.PlaneGeometry(8, 2.5), new THREE.MeshBasicMaterial({ map: numTex, transparent: true }));
    num.position.set(0, H * 0.7, zBack - 0.01);
    num.rotation.y = Math.PI;
    env.add(num);
    }

    for (const o of f.objects) {
      const m = buildObject(o);
      env.add(m);
      if (o.type === 'rack') {
        for (let y = 1; y < o.h - 0.5; y += 0.9) {
          for (const s of [-1, 1]) {
            const led = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.08, 0.3),
              new THREE.MeshBasicMaterial({ color: Math.random() < 0.5 ? '#6fe08a' : '#f2c94c' }));
            led.position.set(o.x + s * (o.w / 2 + 0.03), y + 0.3, -o.z + (Math.random() - 0.5) * o.d * 0.8);
            led.layers.set(1);
            env.add(led);
            anims.leds.push({ m: led, ph: Math.random() * 10 });
          }
        }
      }
    }

    // Floor vents: grate plus rising paper streaks
    for (const v of f.vents) {
      const base = v.y0 ?? 0;
      // Gap thermals rise from the street with no grate; AC exhausts blow out of the unit's own fan
      if (!v.gap && !v.ac) {
        const grate = new THREE.Mesh(new THREE.CylinderGeometry(v.r * 0.55, v.r * 0.55, 0.08, 10), M('#5b6266'));
        grate.position.set(v.x, base + 0.04, -v.z);
        env.add(grate);
        for (let i = -2; i <= 2; i++) env.add(boxMesh(v.r * 1.0, 0.1, 0.12, '#2f3338', v.x, base + 0.04, -v.z + i * v.r * 0.18));
      }
      const y0 = v.gap ? -12 : base + 0.3, y1 = v.gap ? 14 : base + (f.open ? 14 : H * 0.85);
      const streaks = [];
      for (let i = 0; i < (v.gap ? 26 : 16); i++) {
        const s = new THREE.Mesh(new THREE.PlaneGeometry(0.08, 0.9), streakMat);
        s.layers.set(1);
        env.add(s);
        streaks.push({ m: s, a: Math.random() * Math.PI * 2, r: Math.random() * v.r * 0.8, y: y0 + Math.random() * (y1 - y0), sp: 3 + Math.random() * 3 });
      }
      anims.vents.push({ v, streaks, y0, y1 });
    }
    // Ceiling fans
    for (const fan of f.fans) {
      const g = new THREE.Group();
      g.position.set(fan.x, H, -fan.z);
      g.add(boxMesh(0.15, 1.2, 0.15, '#5b4636', 0, -1.2, 0));
      const hub = new THREE.Group();
      hub.position.y = -1.3;
      hub.add(new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.4, 0.3, 8), M('#5b4636')));
      for (let i = 0; i < 4; i++) {
        const blade = new THREE.Mesh(new THREE.BoxGeometry(fan.r * 0.85, 0.06, 0.7), M('#a0805a'));
        blade.position.x = fan.r * 0.45;
        const arm = new THREE.Group(); arm.rotation.y = i * Math.PI / 2; arm.add(blade);
        hub.add(arm);
      }
      g.add(hub);
      env.add(g);
      const streaks = [];
      for (let i = 0; i < 12; i++) {
        const s = new THREE.Mesh(new THREE.PlaneGeometry(0.06, 0.8), streakMat);
        s.layers.set(1); env.add(s);
        streaks.push({ m: s, a: Math.random() * 6.28, r: Math.random() * fan.r * 0.8, y: Math.random() * (H - 2), sp: 4 + Math.random() * 2 });
      }
      anims.fans.push({ hub, fan, streaks, H });
    }
    // Rack blowers: side wind
    for (const b of f.blowers) {
      const streaks = [];
      for (let i = 0; i < 12; i++) {
        const s = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.06), streakMat);
        s.layers.set(1); env.add(s);
        streaks.push({ m: s, t: Math.random(), y: 1 + Math.random() * (b.y1 - 2), z: b.z0 + Math.random() * (b.z1 - b.z0) });
      }
      anims.blowers.push({ b, streaks });
    }

    // Landing zones: dashed floor decal plus a sticky-note sign
    for (const zn of f.zones) {
      const tex = targetTexture(zn);
      const dec = new THREE.Mesh(new THREE.PlaneGeometry(zn.w, zn.d), new THREE.MeshLambertMaterial({ map: tex, polygonOffset: true, polygonOffsetFactor: -2 }));
      dec.rotation.x = -Math.PI / 2;
      dec.position.set(zn.x, (zn.y || 0) + 0.03, -zn.z);
      dec.layers.set(1);
      env.add(dec);

      const signTex = labelTexture([{ text: `+${zn.pay}`, bold: true }, { text: `centre x2`, size: 46 }], { w: 256, h: 240, bg: TIER_COLORS[zn.tier] });
      const sign = new THREE.Group();
      const card = new THREE.Mesh(new THREE.PlaneGeometry(2.2, 1.9), new THREE.MeshBasicMaterial({ map: signTex, side: THREE.DoubleSide }));
      card.position.y = 1.2;
      const pole = boxMesh(0.08, 1.2, 0.08, '#6b5440');
      sign.add(card, pole);
      sign.position.set(zn.x, (zn.y || 0), -(zn.z + zn.d / 2) + 0.2);
      sign.scale.setScalar(0.8 + zn.tier * 0.12);
      env.add(sign);
      anims.signs.push(sign);
    }

    // Moving obstacles
    for (const m of f.movers || []) {
      const { g, spin } = buildMover(m);
      env.add(g);
      anims.movers.push({ m, g, spin });
    }

    // Paper clip pickups
    f.clips.forEach((c, i) => {
      const g = new THREE.Group();
      if (c.big) {
        g.add(boxMesh(0.9, 0.6, 0.6, '#c9a26b', 0, -0.3, 0));
        const top = new THREE.Mesh(clipGeo, clipMat); top.position.y = 0.55; top.scale.setScalar(0.9);
        g.add(top);
      } else {
        g.add(new THREE.Mesh(clipGeo, clipMat));
      }
      g.position.set(c.x, c.y, -c.z);
      env.add(g);
      anims.clips.push({ g, i, ph: i * 0.7, gone: 0 });
    });
  }

  /* ----------------------------------------------------------- planes --- */
  function setPlanes(list) {
    for (const p of planes.values()) {
      planeLayer.remove(p.root, p.shadow, p.trail, p.aim, ...p.slips.map(l => l.m));
    }
    planes.clear();
    for (const { seat, owned, rank } of list) {
      const root = buildPlane(seat, owned || [], rank || 0);
      const shadow = new THREE.Mesh(new THREE.CircleGeometry(0.6, 10), shadowMat);
      shadow.rotation.x = -Math.PI / 2;
      shadow.layers.set(1);
      const trailPts = [];
      const trail = new THREE.InstancedMesh(dotGeo, new THREE.MeshBasicMaterial({ color: colorFor(seat) }), TRAIL_N);
      trail.layers.set(1);
      trail.frustumCulled = false;
      trail.count = 0;
      const aim = new THREE.Group();
      for (let i = 0; i < 8; i++) {
        const dot = new THREE.Mesh(new THREE.SphereGeometry(0.09, 5, 4), new THREE.MeshBasicMaterial({ color: colorFor(seat) }));
        dot.layers.set(1);
        aim.add(dot);
      }
      const slips = [makeSlipLine(), makeSlipLine()];
      planeLayer.add(root, shadow, trail, aim, ...slips.map(l => l.m));
      planes.set(seat, { root, shadow, trail, trailPts, aim, slips, boostT: 0, lastState: 'held' });
    }
  }

  function supportBelow(x, y, z) {
    if (!floor) return 0;
    let best = groundAt(floor, z);
    for (const b of floor.boxes) {
      if (x >= b.x0 && x <= b.x1 && z >= b.z0 && z <= b.z1 && b.y1 <= y + 0.05 && b.y1 > best) best = b.y1;
    }
    return best;
  }

  /* ----------------------------------------------------------- camera --- */
  const camPos = new THREE.Vector3(0, 9.5, 15);
  const camLook = new THREE.Vector3(0, 5, -20);
  const tmp = new THREE.Vector3();

  function aimCamera(dt, targetPos, targetLook, k = 2.5) {
    const a = 1 - Math.exp(-k * dt);
    camPos.lerp(targetPos, a);
    camLook.lerp(targetLook, a);
  }

  // Solo: follow one plane from behind along its heading instead of framing the pack.
  function follow(p, dt) {
    let yaw = p.state === 'held' ? p.aim.yaw : p.yaw;
    if (p.state === 'landed' || p.state === 'slide') yaw = p.followYaw ?? yaw;
    p.followYaw = yaw;
    const dx = Math.sin(yaw), dz = Math.cos(yaw);
    let back, up, ahead, k;
    if (p.state === 'held') { back = 7; up = 2.4; ahead = 14; k = 4; }
    else if (p.state === 'landed') { back = 9; up = 5; ahead = 2; k = 1.6; }
    else { back = 7; up = 3; ahead = 9; k = 3.5; }
    const sx = p.x - dx * back, sz = p.z - dz * back;
    const pos = new THREE.Vector3(sx, p.y + up, -sz);
    const look = new THREE.Vector3(p.x + dx * ahead, p.y + (p.state === 'landed' ? 0 : 0.3), -(p.z + dz * ahead));
    if (floor && p.duct != null && floor.ducts?.[p.duct]) {
      // Inside a duct: keep the camera in the tunnel, just behind the plane
      const d = floor.ducts[p.duct];
      pos.x = Math.max(d.x - d.half + 0.4, Math.min(d.x + d.half - 0.4, pos.x));
      pos.y = Math.max(d.y0 + 0.4, Math.min(d.y1 - 0.4, pos.y));
      pos.z = -Math.max(d.z0 + 0.5, -pos.z);
      k = 9;   // snap in: the tunnel is too tight for a lazy camera
    } else if (floor) {
      const outX = p.out && floor.ledge ? floor.ledge.depth + 1 : 0;
      const gnd = floor.gap ? Math.min(groundAt(floor, -pos.z), groundAt(floor, p.z)) : 0;
      pos.y = Math.max(gnd + 0.8, Math.min(pos.y, floor.height - 0.6));
      const lo = -floor.width / 2 + 1 - (floor.ledge?.side < 0 ? outX : 0), hi = floor.width / 2 - 1 + (floor.ledge?.side > 0 ? outX : 0);
      pos.x = Math.max(lo, Math.min(hi, pos.x));
      pos.z = Math.min(pos.z, 22);
    }
    aimCamera(dt, pos, look, k);
  }

  // Photo finish: a low side-on shot across the two contenders, slowly dollying.
  function photoCam(race, dt, pair) {
    const ps = race.planes.filter(p => pair.includes(p.seat));
    if (!ps.length) return;
    const cx = ps.reduce((a, p) => a + p.x, 0) / ps.length;
    const cy = ps.reduce((a, p) => a + p.y, 0) / ps.length;
    const cz = ps.reduce((a, p) => a + p.z, 0) / ps.length;
    const spread = ps.length > 1 ? Math.hypot(ps[0].x - ps[1].x, ps[0].z - ps[1].z) : 0;
    const side = cx > 0 ? -1 : 1;                 // shoot from the roomier side
    const W = floor ? floor.width / 2 - 1.5 : 20;
    const dist = 8 + spread * 0.6;
    const pos = new THREE.Vector3(Math.max(-W, Math.min(W, cx + side * dist)), Math.max((floor?.gap ? groundAt(floor, cz) : 0) + 1.2, cy + 1.6), -(cz - 2 + Math.sin(time * 0.6) * 1.5));
    const look = new THREE.Vector3(cx, Math.max((floor?.gap ? groundAt(floor, cz) : 0) + 0.4, cy - 0.2), -cz);
    aimCamera(dt, pos, look, 2.2);
  }

  function chase(race, dt, focus) {
    if (focus != null) {
      const me = race.planes.find(p => p.seat === focus);
      if (me) return follow(me, dt);
    }
    const fly = race.planes.filter(p => p.state === 'fly' || p.state === 'slide' || p.state === 'fall');
    const held = race.planes.filter(p => p.state === 'held');
    let pos, look;
    if (!fly.length && held.length) {
      pos = new THREE.Vector3(0, 9.5, 15);
      look = new THREE.Vector3(0, 4.5, -26);
    } else {
      const set = fly.length ? fly : race.planes;
      const lead = set.reduce((a, b) => (b.z > a.z ? b : a));
      let cx = 0, cy = 0, cz = 0;
      for (const p of set) { cx += p.x; cy += p.y; cz += p.z; }
      cx /= set.length; cy /= set.length; cz /= set.length;
      cx = cx * 0.5 + lead.x * 0.5; cy = cy * 0.5 + lead.y * 0.5; cz = cz * 0.45 + lead.z * 0.55;
      let spread = 0;
      for (const p of set) spread = Math.max(spread, Math.hypot(p.x - cx, p.z - cz, p.y - cy));
      spread = Math.min(spread, 40);
      const allDown = !fly.length;
      const back = allDown ? 16 + spread * 0.6 : 9 + spread * 0.75;
      const up = allDown ? 9 + spread * 0.3 : 3.2 + spread * 0.22;
      const minZ = Math.min(...set.map(p => p.z));
      const camZ = Math.min(cz - back, minZ - 6);
      pos = new THREE.Vector3(cx, cy + up + Math.max(0, (cz - back) - camZ) * 0.15, -camZ);
      look = new THREE.Vector3(cx, Math.max((floor?.gap ? -floor.gap.depth : 0) + 0.5, cy - 0.5), -(cz + (allDown ? 2 : 7)));
    }
    if (floor) {
      const anyOut = race.planes.some(q => q.out) && floor.ledge ? floor.ledge.depth + 1 : 0;
      pos.y = Math.min(pos.y, floor.height - 0.7);
      pos.x = Math.max(-floor.width / 2 + 1.5 - (floor.ledge?.side < 0 ? anyOut : 0), Math.min(floor.width / 2 - 1.5 + (floor.ledge?.side > 0 ? anyOut : 0), pos.x));
      pos.z = Math.min(pos.z, 22);
    }
    aimCamera(dt, pos, look, fly.length ? 3.2 : 1.6);
  }

  function introCam(t) {
    // Sweep from the high landing zones back to the launch desk.
    if (!floor) return;
    const L = floor.length;
    const e = t < 0 ? 0 : t > 1 ? 1 : t;
    const s = e * e * (3 - 2 * e);
    const z = (L - 10) * (1 - s) - 4 * s;
    camPos.set(Math.sin(s * 2.4) * 6 * (1 - s), floor.height * 0.7 * (1 - s) + 9.5 * s, -z + 15 + (1 - s) * 4);
    camLook.set(0, 2 * (1 - s) + 4.5 * s, -(z + 30));
  }

  const showcaseState = { t: 0 };
  function showcase(dt, seats) {
    showcaseState.t += dt;
    const n = seats.length;
    seats.forEach((seat, i) => {
      const p = planes.get(seat);
      if (!p) return;
      p.root.visible = true;
      p.root.userData.body.visible = true;
      p.root.userData.ball.visible = false;
      p.root.position.set((i - (n - 1) / 2) * 2.6, 4.2 + 0.55 + Math.sin(showcaseState.t * 2 + i) * 0.08, 2.4);
      p.root.rotation.set(0.15, showcaseState.t * 0.7 + i, 0, 'YXZ');
      p.shadow.position.set(p.root.position.x, 4.22, 2.4);
      p.trail.visible = false;
      p.aim.visible = false;
      p.slips.forEach(l => { l.pts.length = 0; l.m.visible = false; });
    });
    const sway = Math.sin(showcaseState.t * 0.4) * 1.5;
    aimCamera(dt, tmp.set(sway, 7.6, 10.4), new THREE.Vector3(0, 7.9, 2.4), 3);
  }

  /* ----------------------------------------------------------- frame --- */
  let time = 0;
  function frame(dt, view) {
    time += dt;
    const race = view.race;

    if (view.mode === 'intro') introCam(view.introT);
    else if (view.mode === 'showcase') showcase(dt, view.seats || []);
    else if (view.mode === 'photo' && race) photoCam(race, dt, view.pair);
    else if (race) chase(race, dt, view.focus);

    // Speed sensation: FOV follows the fastest flying plane (or yours, in solo)
    if (race && view.mode !== 'photo') {
      const fliers = race.planes.filter(p => p.state === 'fly');
      const mine = view.focus != null ? race.planes.find(p => p.seat === view.focus) : null;
      const v = mine ? (mine.state === 'fly' ? mine.v : 0) : fliers.reduce((m, p) => Math.max(m, p.v), 0);
      fovSpeed += ((reduceMotion ? 0 : Math.max(-2, Math.min(10, (v - 12) * 0.7))) - fovSpeed) * Math.min(1, dt * 3);
    } else fovSpeed *= Math.pow(0.1, dt);
    fovKick *= Math.pow(0.05, dt);
    const fov = baseFov + fovSpeed + fovKick - (view.mode === 'photo' ? 12 : 0);
    if (Math.abs(camera.fov - fov) > 0.05) { camera.fov += (fov - camera.fov) * Math.min(1, dt * 6); camera.updateProjectionMatrix(); }
    sepia += (sepiaTarget - sepia) * Math.min(1, dt * 4);

    if (race && view.mode !== 'showcase') syncPlanes(race, dt);

    // Ambient animation
    for (const f of anims.fans) {
      f.hub.rotation.y += dt * 6;
      for (const s of f.streaks) {
        s.y -= s.sp * dt; if (s.y < 0.5) s.y = f.H - 2;
        s.m.position.set(f.fan.x + Math.cos(s.a) * s.r, s.y, -f.fan.z + Math.sin(s.a) * s.r);
        s.m.lookAt(camera.position.x, s.y, camera.position.z);
      }
    }
    for (const v of anims.vents) {
      for (const s of v.streaks) {
        s.y += s.sp * dt; s.a += dt * 1.5;
        if (s.y > v.y1) s.y = v.y0;
        s.m.position.set(v.v.x + Math.cos(s.a) * s.r, s.y, -v.v.z + Math.sin(s.a) * s.r);
        s.m.lookAt(camera.position.x, s.y, camera.position.z);
      }
    }
    if (anims.gap && floor?.gap) {
      const w = gapWind(floor.gap, race ? race.t : time), G = anims.gap;
      for (const st of G.streaks) {
        // sideways with the crosswind, rising harder when a gust pulses below the roofline
        st.x += w.side * floor.gap.cross * 4 * dt;
        st.y += (st.y < 0 ? 1 + 7 * w.up : 0.6) * dt;
        if (Math.abs(st.x) > G.W / 2 + 6 || st.y > 8) { st.x = (Math.random() - 0.5) * G.W; st.y = -16 + Math.random() * 6; }
        st.m.position.set(st.x, st.y, -st.z);
        st.m.lookAt(camera.position.x, st.y, camera.position.z);
      }
    }
    for (const bl of anims.blowers) {
      for (const s of bl.streaks) {
        s.t += dt * 0.9; if (s.t > 1) s.t = 0;
        const b = bl.b;
        const x = bl.b.dir > 0 ? b.x0 + (b.x1 - b.x0) * s.t : b.x1 - (b.x1 - b.x0) * s.t;
        s.m.position.set(x, s.y, -s.z);
        s.m.rotation.y = 0;
      }
    }
    if (anims.outside) {
      const o = anims.outside;
      for (const st of o.streaks) {
        st.t += dt * 0.7; if (st.t > 1) st.t = 0;
        st.m.position.set(o.s * (o.W / 2 + 0.8 + st.t * o.depth), st.y, -st.z);
        st.m.rotation.y = 0;
      }
    }
    for (const l of anims.leds) l.m.visible = Math.sin(time * 3 + l.ph * 5) > -0.6;
    // Movers follow race time, so they're exactly where the sim says they are.
    const rt = race ? race.t : 0;
    for (const a of anims.movers) {
      const c = moverAt(a.m, rt);
      a.g.position.set(c.x, c.y, -c.z);
      for (const sp of a.spin) {
        if (sp.flap) sp.o.rotation[sp.axis] = Math.sin(time * sp.rate + sp.ph) * sp.flap;
        else sp.o.rotation[sp.axis] += sp.rate * dt;
      }
    }
    for (const c of anims.clips) {
      const taken = race && race.clips[c.i] && race.clips[c.i].taken >= 0;
      if (taken) c.gone = Math.min(1, c.gone + dt * 5); else c.gone = 0;
      c.g.visible = c.gone < 1;
      c.g.rotation.y = time * 1.6 + c.ph;
      c.g.position.y = (floor.clips[c.i]?.y ?? 0) + Math.sin(time * 2 + c.ph) * 0.15 + c.gone * 1.2;
      c.g.scale.setScalar(1 + c.gone * 0.6 - c.gone * c.gone * 1.5);
    }
    for (const s of anims.signs) s.rotation.y = Math.atan2(camera.position.x - s.position.x, camera.position.z - s.position.z);

    for (const b of bits) {
      if (b.life <= 0) continue;
      b.life -= dt;
      if (!b.noGrav) b.v.y -= 7 * dt;
      b.v.multiplyScalar(Math.pow(0.4, dt));
      if (b.life - dt <= 0) b.noGrav = false;
      b.m.position.addScaledVector(b.v, dt);
      if (b.m.position.y < 0.05) { b.m.position.y = 0.05; b.v.set(0, 0, 0); }
      b.m.rotation.x += b.spin.x * dt; b.m.rotation.y += b.spin.y * dt;
      if (b.life <= 0) b.m.visible = false;
    }

    for (let i = rings.length - 1; i >= 0; i--) {
      const g = rings[i];
      g.t += dt;
      const k = g.t / 0.9;
      g.m.scale.setScalar(0.5 + k * g.size);
      g.m.material.opacity = 0.9 * (1 - k);
      if (k >= 1) { scene.remove(g.m); g.m.material.dispose(); rings.splice(i, 1); }
    }

    camera.position.copy(camPos);
    if (shakeAmt > 0.001) {
      camera.position.x += (Math.random() - 0.5) * shakeAmt;
      camera.position.y += (Math.random() - 0.5) * shakeAmt;
      shakeAmt *= Math.pow(0.02, dt);
    }
    camera.lookAt(camLook);
    ink.render(scene, camera, time, reduceMotion, sepia);
  }

  function syncPlanes(race, dt) {
    for (const p of race.planes) {
      const v = planes.get(p.seat);
      if (!v) continue;
      const { root, shadow, trail, trailPts, aim } = v;
      root.visible = true;
      const crumpled = p.crumpled;
      root.userData.body.visible = !crumpled;
      root.userData.ball.visible = crumpled;

      if (p.state === 'held') {
        const pull = p.aim.power * 0.7;
        root.position.set(p.x - Math.sin(p.aim.yaw) * pull * 0.3, p.y - pull * 0.15, -(p.z - pull));
        root.rotation.set(p.aim.pitch, -p.aim.yaw, Math.sin(time * 3 + p.seat) * 0.04, 'YXZ');
        aim.visible = true;
        aim.children.forEach((d, i) => {
          const s = (i + 1) * (0.9 + p.aim.power * 1.4);
          d.position.set(p.x + Math.sin(p.aim.yaw) * s, p.y + Math.sin(p.aim.pitch) * s - 0.012 * s * s, -(p.z + Math.cos(p.aim.yaw) * s));
          d.scale.setScalar(1 - i * 0.08);
        });
      } else {
        aim.visible = false;
        root.position.set(p.x, p.y + (crumpled ? 0.25 : 0), -p.z);
        if (crumpled) root.rotation.set(p.pitch, -p.yaw, p.roll, 'YXZ');
        else {
          // Paper flutter. A healthy plane at speed flies rock-steady; the
          // wobble grows as it takes damage and as it slows toward a stall,
          // so you can read trouble straight off the plane.
          let fl = 0;
          if (p.state === 'fly' && !reduceMotion) {
            const hurt = 1 - Math.max(0, p.hp) / (p.maxHp || 100);      // 0 healthy .. 1 nearly crumpled
            const slow = Math.max(0, Math.min(1, (8.5 - p.v) / 4));     // starts below 8.5, full by ~4.5
            fl = Math.min(1.6, hurt * hurt * 1.4 + slow * 1.1);
          }
          // Two frequencies so it reads as paper shaking, not a smooth sway
          const shakeP = (Math.sin(time * 23 + p.seat * 3) + 0.5 * Math.sin(time * 41 + p.seat)) * 0.04 * fl;
          const shakeR = (Math.sin(time * 17 + p.seat) + 0.6 * Math.sin(time * 37 + p.seat * 2)) * 0.09 * fl;
          root.rotation.set(
            (p.state === 'slide' || p.state === 'landed' ? 0 : p.pitch) + shakeP,
            -p.yaw + shakeR * 0.3, -p.roll + shakeR, 'YXZ');
        }
      }
      const w = wobble.get(p.seat) || 0;
      if (w > 0.01) {
        const k = Math.sin(time * 45) * w * 0.25;
        root.scale.set(1 + k, 1 - k, 1 + k * 0.5);
        wobble.set(p.seat, w * Math.pow(0.02, dt));
      } else root.scale.set(1, 1, 1);

      // Dotted pencil trail while flying
      v.trailTick = (v.trailTick || 0) + 1;
      if (p.state === 'fly' && !crumpled) {
        if (v.trailTick % 3 === 0) {
          trailPts.push(p.x, p.y, -p.z);
          if (trailPts.length > TRAIL_N * 3) trailPts.splice(0, 3);
        }
      } else if (trailPts.length && v.trailTick % 2 === 0) trailPts.splice(0, 3);
      const n = trailPts.length / 3;
      for (let i = 0; i < n; i++) {
        const k = (i + 1) / n;
        tmpM.makeScale(0.35 + k * 0.65, 0.35 + k * 0.65, 0.35 + k * 0.65);
        tmpM.setPosition(trailPts[i * 3], trailPts[i * 3 + 1], trailPts[i * 3 + 2]);
        trail.setMatrixAt(i, tmpM);
      }
      trail.count = n;
      trail.instanceMatrix.needsUpdate = true;

      // Slipstream doodle lines off the wing tips during a trick boost
      const flying = p.state === 'fly' && !crumpled;
      v.boostT = flying ? Math.max(0, (v.boostT || 0) - dt) : 0;
      root.updateMatrixWorld();
      const boil = Math.floor(time * 6);
      v.slips.forEach((line, i) => {
        _tip.copy(root.userData.tips[i]);
        root.userData.body.localToWorld(_tip);
        updateSlipLine(line, v.boostT > 0, _tip, dt, boil);
      });

      const sy = supportBelow(p.x, p.y, p.z);
      shadow.position.set(p.x, sy + 0.04, -p.z);
      const hgt = Math.max(0, p.y - sy);
      shadow.scale.setScalar(Math.max(0.35, 1 - hgt * 0.06));
      shadow.material.opacity = 0.22;

      v.lastState = p.state;
    }
  }

  function project(x, y, z) {
    tmp.set(x, y, -z).project(camera);
    const r = renderer.domElement.getBoundingClientRect();
    return { x: (tmp.x * 0.5 + 0.5) * r.width, y: (-tmp.y * 0.5 + 0.5) * r.height, visible: tmp.z < 1 && tmp.z > -1 };
  }

  function resize() {
    const w = canvas.clientWidth || window.innerWidth, h = canvas.clientHeight || window.innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    baseFov = w / h < 1 ? 72 : 58;
    camera.fov = baseFov;
    camera.updateProjectionMatrix();
    ink.resize();
  }
  resize();
  window.addEventListener('resize', resize);

  return { setFloor, setPlanes, frame, boost, burst, confetti, gust, ring, hitPlane, punch, setSepia, shake, project, resize, get floor() { return floor; } };
}
