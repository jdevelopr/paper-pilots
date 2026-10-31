// floors.js: the five office floors and the layout generator.
//
// Each floor is a *theme* (name, colours, ceiling height, what furniture lives
// there, what the landing zones are called). generateFloor(theme, seed) builds
// a fresh random layout from that theme for every race. The layout is plain
// data: the sim collides with `boxes`, and the renderer builds meshes from
// `objects`, so what you see is exactly what you hit.
//
// Playability guarantees:
//   - a winding "lane" from the launch desk to the far wall is kept clear of
//     anything taller than a desk, so there is always a way through;
//   - nothing spawns on the launch area or on top of a landing zone;
//   - landing zones sit in fixed distance bands, so farther really is harder.
//
// Units: sim space (see sim.js). Width spans x = -W/2..W/2, z runs 0..length.
// Pure: no DOM, no Math.random (the seed is passed in).

export const ZONE_PAY = [3, 6, 10, 15, 24];

// Floor 1 is 400 long; each floor above it is 25% longer than the one below.
const BASE_LENGTH = 400, GROWTH = 1.25;

// Distance bands per tier [zMin, zMax] for the zone centre, on a 200-long
// reference floor. They stretch with the floor.
const TIER_BANDS = [[100, 116], [120, 134], [138, 152], [156, 170], [176, 191]];
const LANE_HALF = 3.6;     // half-width of the guaranteed-clear corridor
const TALL = 3.2;          // anything taller than this may not sit in the lane

/* ----------------------------------------------------------------- rng --- */

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function tools(rng) {
  const r = (a, b) => a + (b - a) * rng();
  const ri = (a, b) => Math.floor(r(a, b + 1));
  const pick = arr => arr[Math.floor(rng() * arr.length)];
  const chance = p => rng() < p;
  return { r, ri, pick, chance };
}

/* --------------------------------------------------------- collisions --- */

const SOLID = new Set(['counter', 'cubicle', 'pillar', 'plant', 'cabinet', 'couch', 'cooler',
  'printer', 'vending', 'fridge', 'rack', 'shelf', 'glass', 'crate', 'copier', 'tv']);

function boxesFor(o) {
  const hw = o.w / 2, hd = o.d / 2;
  const base = { x0: o.x - hw, x1: o.x + hw, z0: o.z - hd, z1: o.z + hd };
  if (o.type === 'desk' || o.type === 'table') {
    // Only the slab is solid. Planes can fly under desks.
    const out = [{ ...base, y0: o.h - 0.35, y1: o.h }];
    if (o.mon) out.push({ x0: o.x - 0.9, x1: o.x + 0.9, z0: o.z + hd - 0.6, z1: o.z + hd - 0.2, y0: o.h, y1: o.h + 1.4 });
    return out;
  }
  if (SOLID.has(o.type)) return [{ ...base, y0: o.y || 0, y1: (o.y || 0) + o.h }];
  return [];
}

const topOf = o => (o.y || 0) + o.h + (o.mon ? 1.4 : 0);
const overlapsRect = (o, x0, x1, z0, z1) =>
  o.x + o.w / 2 > x0 && o.x - o.w / 2 < x1 && o.z + o.d / 2 > z0 && o.z - o.d / 2 < z1;

/* ------------------------------------------------------ moving things --- */

// A mover glides back and forth along one axis with an ease-in-out swing.
// Its position is a pure function of race time, so the host, the bots'
// look-ahead and the renderer all agree on where it is.
export function moverAt(m, t) {
  const u = 0.5 - 0.5 * Math.cos(2 * Math.PI * (t / m.period + m.phase));
  const off = m.from + (m.to - m.from) * u;
  return { x: m.x + (m.axis === 'x' ? off : 0), y: m.y + (m.axis === 'y' ? off : 0), z: m.z + (m.axis === 'z' ? off : 0) };
}
export function moverBox(m, t) {
  const c = moverAt(m, t);
  return { x0: c.x - m.w / 2, x1: c.x + m.w / 2, z0: c.z - m.d / 2, z1: c.z + m.d / 2, y0: c.y, y1: c.y + m.h, mover: true };
}
// The whole volume a mover can sweep through, for placement checks.
function moverSweep(m) {
  const a = moverAt({ ...m, phase: 0 }, 0), b = moverAt({ ...m, phase: 0.5 }, 0);
  return { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2, w: Math.abs(a.x - b.x) + m.w, d: Math.abs(a.z - b.z) + m.d };
}

// On-theme moving obstacles. Each returns a mover centred on (x, z).
const M = {
  // Cubicle Farm: office chairs scooting between desks, the mail cart doing its rounds
  chair: (x, z, T) => ({ type: 'chair', x, z, y: 0, w: 2.2, d: 2.2, h: 3.4, axis: 'x', from: -T.r(7, 11), to: T.r(7, 11), period: T.r(3.5, 5.5) }),
  mailcart: (x, z, T) => ({ type: 'mailcart', x, z, y: 0, w: 3.4, d: 2.2, h: 3.2, axis: 'x', from: -T.r(9, 13), to: T.r(9, 13), period: T.r(6, 8) }),
  // Break Room: the snack trolley, and a bouncy ball someone kicked
  trolley: (x, z, T) => ({ type: 'trolley', x, z, y: 0, w: 3.6, d: 2.2, h: 3.4, axis: 'x', from: -T.r(8, 12), to: T.r(8, 12), period: T.r(5, 7) }),
  ball: (x, z, T) => ({ type: 'ball', x, z, y: 0.2, w: 1.6, d: 1.6, h: 1.6, axis: 'y', from: 0, to: T.r(6, 9), period: T.r(1.6, 2.4) }),
  // Server Room: a maintenance robot patrolling an aisle, a cable lift going up and down
  robot: (x, z, T) => ({ type: 'robot', x, z, y: 0, w: 2.4, d: 2.4, h: 4, axis: 'z', from: -T.r(8, 12), to: T.r(8, 12), period: T.r(5, 7) }),
  lift: (x, z, T) => ({ type: 'lift', x, z, y: 0.5, w: T.r(6, 8), d: 3, h: 0.6, axis: 'y', from: 0, to: T.r(8, 10), period: T.r(4, 6) }),
  // Executive Suite: automatic sliding glass doors, and the CEO's camera drone
  slidedoor: (x, z, T, H) => ({ type: 'slidedoor', x, z, y: 0, w: T.r(6, 8), d: 0.4, h: H, axis: 'x', from: -T.r(5, 8), to: T.r(5, 8), period: T.r(4, 6) }),
  drone: (x, z, T) => ({ type: 'drone', x, z, y: T.r(5, 9), w: 2.2, d: 2.2, h: 0.7, axis: 'x', from: -T.r(9, 14), to: T.r(9, 14), period: T.r(3.5, 5) }),
};

/* -------------------------------------------------------------- themes --- */

// Furniture presets. w is across the floor, d along it, h is height.
const F = {
  desk: (x, z, T) => ({ type: 'desk', x, z, w: T.r(6, 8), d: T.r(3, 3.8), h: 3, mon: T.chance(0.7) }),
  table: (x, z, T) => ({ type: 'table', x, z, w: T.r(5, 8), d: T.r(4, 6), h: T.r(2.6, 3) }),
  counter: (x, z, T) => ({ type: 'counter', x, z, w: T.r(6, 12), d: T.r(3, 4), h: 3.6 }),
  pillar: (x, z) => ({ type: 'pillar', x, z, w: 2.4, d: 2.4, h: 99 }),
  plant: (x, z) => ({ type: 'plant', x, z, w: 1.8, d: 1.8, h: 4.5 }),
  couch: (x, z, T) => ({ type: 'couch', x, z, w: T.r(6, 9), d: 3, h: 2.2 }),
  cooler: (x, z) => ({ type: 'cooler', x, z, w: 1.6, d: 1.6, h: 4.4 }),
  cabinet: (x, z, T) => ({ type: 'cabinet', x, z, w: T.r(2.4, 5), d: 3, h: T.pick([4.4, 6]) }),
  printer: (x, z) => ({ type: 'printer', x, z, w: 3, d: 2.4, h: 3.4 }),
  vending: (x, z) => ({ type: 'vending', x, z, w: 4, d: 3, h: 7.5 }),
  fridge: (x, z) => ({ type: 'fridge', x, z, w: 5, d: 4, h: 7.5 }),
  shelf: (x, z, T) => ({ type: 'shelf', x, z, w: T.r(6, 9), d: 2, h: T.pick([5, 6, 7]) }),
  crate: (x, z, T) => ({ type: 'crate', x, z, w: T.r(2.5, 4.5), d: T.r(2.5, 3.5), h: T.r(1.8, 3) }),
  rack: (x, z, T, d) => ({ type: 'rack', x, z, w: 3, d: d ?? T.r(16, 30), h: 9 }),
};

// A partition or glass wall across the floor with 1-2 random doorways.
function wallRow(type, h, z, W, T) {
  const gaps = [];
  const nGaps = T.ri(1, 2);
  for (let i = 0; i < nGaps; i++) {
    const gw = T.r(7, 11);
    const gx = T.r(-W / 2 + gw / 2 + 1, W / 2 - gw / 2 - 1);
    gaps.push([gx - gw / 2, gx + gw / 2]);
  }
  gaps.sort((a, b) => a[0] - b[0]);
  const out = [];
  let x = -W / 2;
  for (const [g0, g1] of [...gaps, [W / 2, W / 2]]) {
    if (g0 - x > 1.5) out.push({ type, x: (x + g0) / 2, z, w: g0 - x, d: type === 'glass' ? 0.4 : 0.5, h });
    x = Math.max(x, g1);
  }
  return out;
}

function scatter(z, W, T, makers, n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(T.pick(makers)(T.r(-W / 2 + 3, W / 2 - 3), z + T.r(-4, 4), T));
  return out;
}

export const THEMES = [
  {
    id: 'lobby', number: 1, name: 'Lobby',
    carpet: '#c9b48a', wall: '#e9e1cf', accent: '#c1440e', height: 16,
    zoneNames: [['Welcome Mat', 'Doormat'], ['Lobby Rug', 'Waiting Area'], ['Mail Cart', 'Coat Rack'], ['Visitor Sofa', 'Fountain Ledge'], ['Elevator', 'Revolving Door']],
    perches: [
      { name: 'Security Desk', make: (x, z, T) => ({ ...F.desk(x, z, T), mon: false }) },
      { name: 'Reception', make: (x, z, T) => F.counter(x, z, T) },
    ],
    rows: [
      (z, W, T) => [F.pillar(T.r(-14, -6), z), F.pillar(T.r(6, 14), z)],
      (z, W, T) => [F.counter(T.r(-8, 8), z, T), ...scatter(z, W, T, [F.plant], 2)],
      (z, W, T) => [F.couch(T.r(-16, -8), z, T), F.couch(T.r(8, 16), z, T), F.table(0, z + T.r(-2, 2), T)],
      (z, W, T) => scatter(z, W, T, [F.plant, F.cooler, F.pillar], T.ri(2, 4)),
    ],
    vents: [3, 4], fans: [0, 1], blowers: [0, 0], movers: [],
  },
  {
    id: 'cubicles', number: 2, name: 'Cubicle Farm',
    carpet: '#8f9aa3', wall: '#dfe3e2', accent: '#1e4d6b', height: 13,
    zoneNames: [['Hallway', 'Copier Nook'], ['Cubicle 4B', 'Hot Desk'], ['Break Corner', 'Supply Shelf'], ['Team Lead Desk', 'Huddle Room'], ['Window Seat', 'Corner Cubicle']],
    perches: [
      { name: "Manager's Desk", make: (x, z, T) => ({ ...F.desk(x, z, T), mon: false }) },
      { name: 'Filing Cabinet', make: (x, z, T) => ({ ...F.cabinet(x, z, T), w: 5, h: 4.4 }) },
    ],
    rows: [
      (z, W, T) => wallRow('cubicle', T.r(4.8, 5.6), z, W, T),
      (z, W, T) => wallRow('cubicle', T.r(4.8, 5.6), z, W, T),
      (z, W, T) => scatter(z, W, T, [F.desk, F.desk, F.printer, F.cabinet], T.ri(2, 4)),
      (z, W, T) => [{ type: 'cubicle', x: T.r(-12, 12), z: z + 6, w: 0.5, d: T.r(12, 22), h: 4.5 }, ...scatter(z, W, T, [F.desk], 2)],
    ],
    vents: [3, 5], fans: [0, 0], blowers: [0, 0],
    movers: [M.chair, M.chair, M.mailcart], moverCount: [2, 3],
  },
  {
    id: 'breakroom', number: 3, name: 'Break Room',
    carpet: '#b9c9b2', wall: '#efe4c8', accent: '#3d6b52', height: 15,
    zoneNames: [['Sink Mat', 'Recycling Bins'], ['Coffee Corner', 'Bean Bag'], ['Snack Drawer', 'Water Cooler'], ['Ping-pong Corner', 'Microwave Line'], ['Nap Pod', 'Birthday Cake']],
    perches: [
      { name: 'Lunch Table', make: (x, z, T) => F.table(x, z, T) },
      { name: 'Snack Counter', make: (x, z, T) => F.counter(x, z, T) },
      { name: 'Fridge Top', make: (x, z) => F.fridge(x, z), tiers: [4] },
    ],
    rows: [
      (z, W, T) => scatter(z, W, T, [F.table, F.table, F.couch], T.ri(2, 3)),
      (z, W, T) => [F.vending(T.pick([-1, 1]) * T.r(12, 18), z), F.vending(T.r(-6, 6), z + 6)],
      (z, W, T) => [F.counter(T.pick([-1, 1]) * T.r(10, 16), z, T), F.cooler(T.r(-8, 8), z)],
      (z, W, T) => [F.fridge(T.r(-14, 14), z), ...scatter(z, W, T, [F.table], 1)],
    ],
    vents: [3, 4], fans: [2, 3], blowers: [0, 0],
    movers: [M.trolley, M.ball, M.ball], moverCount: [2, 3],
  },
  {
    id: 'servers', number: 4, name: 'Server Room',
    carpet: '#7b8794', wall: '#c9d1d8', accent: '#1e4d6b', height: 14,
    zoneNames: [['Cable Tray', 'Loading Dock'], ['Cold Aisle', 'Patch Panel'], ['Hot Aisle', 'Spare Parts'], ['Admin Desk', 'UPS Bank'], ['Root Access', 'Mainframe']],
    perches: [
      { name: 'Admin Desk', make: (x, z, T) => ({ ...F.desk(x, z, T), mon: false }) },
      { name: 'Tape Library', make: (x, z, T) => ({ ...F.cabinet(x, z, T), w: 5, h: 6 }) },
      { name: 'Root Access', make: (x, z, T) => ({ ...F.rack(x, z, T, 3), w: 4, h: 7 }), tiers: [4] },
    ],
    rows: [
      // Racks running lengthwise make aisles
      (z, W, T) => {
        const n = T.ri(2, 4), out = [];
        const span = W - 8, step = span / n;
        for (let i = 0; i < n; i++) out.push(F.rack(-span / 2 + step * (i + 0.5) + T.r(-1.5, 1.5), z + 8, T));
        return out;
      },
      (z, W, T) => scatter(z, W, T, [F.crate, F.crate, F.cabinet], T.ri(2, 3)),
    ],
    rowGap: [26, 34],
    vents: [4, 6], fans: [0, 0], blowers: [1, 2],
    movers: [M.robot, M.robot, M.lift], moverCount: [2, 3],
  },
  {
    id: 'executive', number: 5, name: 'Executive Suite',
    carpet: '#8b3a2e', wall: '#efe6d6', accent: '#c1440e', height: 16,
    zoneNames: [['Visitor Chair', 'Coat Closet'], ['Lounge Rug', 'Fish Tank'], ['Mini Bar', 'Trophy Case'], ['Executive Rug', 'Golf Green'], ['Corner Office', 'CEO Chair']],
    perches: [
      { name: 'Boardroom Table', make: (x, z, T) => ({ ...F.table(x, z, T), w: T.r(7, 9), d: T.r(10, 16), h: 3.2 }) },
      { name: 'Bookshelf', make: (x, z, T) => ({ ...F.shelf(x, z, T), h: 6 }) },
      { name: 'Corner Office', make: (x, z) => ({ type: 'desk', x, z, w: 10, d: 5, h: 3.2, mon: false }), tiers: [4] },
    ],
    rows: [
      (z, W, T) => wallRow('glass', 16, z, W, T),
      (z, W, T) => [{ ...F.table(T.r(-8, 8), z + 6, T), w: T.r(7, 9), d: T.r(14, 22), h: 3.2 }],
      (z, W, T) => [F.shelf(T.pick([-1, 1]) * T.r(12, 17), z, T), F.plant(T.r(-10, 10), z), F.couch(T.r(-12, 12), z + 5, T)],
    ],
    vents: [3, 4], fans: [1, 2], blowers: [0, 0],
    movers: [M.slidedoor, M.drone, M.drone], moverCount: [2, 3],
  },
];

for (const t of THEMES) t.length = Math.round(BASE_LENGTH * GROWTH ** (t.number - 1));

// rules.js picks the floors for a match from this list.
export const FLOORS = THEMES;

/* ----------------------------------------------------------- generator --- */

export function generateFloor(theme, seed = 1) {
  const rng = mulberry32(seed);
  const T = tools(rng);
  const W = 44, H = theme.height, L = theme.length || 200;
  const k = L / 200, sk = Math.sqrt(k);   // stretch relative to the reference floor
  const many = ([a, b]) => T.ri(Math.round(a * k), Math.round(b * k));

  // The clear lane: random control points, linear in between.
  const ctrl = [[0, 0]];
  const nCtrl = Math.max(5, Math.round(5 * k));
  for (let i = 1; i < nCtrl; i++) ctrl.push([L * i / nCtrl, T.r(-14, 14)]);
  ctrl[1][1] = T.r(-10, 10);
  ctrl.push([L, T.r(-12, 12)]);
  const laneX = z => {
    for (let i = 1; i < ctrl.length; i++) {
      if (z <= ctrl[i][0]) {
        const [z0, x0] = ctrl[i - 1], [z1, x1] = ctrl[i];
        return x0 + (x1 - x0) * (z - z0) / (z1 - z0);
      }
    }
    return ctrl[ctrl.length - 1][1];
  };
  const inLane = o => {
    for (let z = o.z - o.d / 2; z <= o.z + o.d / 2 + 0.01; z += 1.5) {
      const lx = laneX(z);
      if (o.x + o.w / 2 > lx - LANE_HALF && o.x - o.w / 2 < lx + LANE_HALF) return true;
    }
    return false;
  };

  /* Landing zones, one per tier */
  const zones = [];
  for (let tier = 0; tier < 5; tier++) {
    const [b0, b1] = TIER_BANDS[tier].map(z => z * k);
    const hosts = theme.perches.filter(p => (p.tiers || [3, 4]).includes(tier));
    const usePerch = tier >= 3 && hosts.length > 0 && T.chance(tier === 4 ? 0.5 : 0.6);
    for (let attempt = 0; attempt < 30; attempt++) {
      const z = T.r(b0, b1);
      let zn;
      if (usePerch) {
        const host = T.pick(hosts);
        const o = host.make(0, z, T);
        o.x = T.r(-W / 2 + o.w / 2 + 2, W / 2 - o.w / 2 - 2);
        zn = { tier, label: host.name, x: o.x, z: o.z, w: o.w, d: o.d, y: o.h, pay: ZONE_PAY[tier], host: o };
      } else {
        // Mats grow a little on longer floors, where planes arrive faster.
        const w = Math.min(W - 6, (tier === 4 ? T.r(7, 9) : T.r(9, 14) - tier) * Math.pow(k, 0.25));
        const d = (tier === 4 ? T.r(6, 8) : T.r(7, 11) - tier * 0.5) * sk;
        zn = { tier, label: T.pick(theme.zoneNames[tier]), x: T.r(-W / 2 + w / 2 + 1.5, W / 2 - w / 2 - 1.5), z, w, d, y: 0, pay: ZONE_PAY[tier] };
      }
      const clash = zones.some(o => Math.abs(o.x - zn.x) < (o.w + zn.w) / 2 + 1.5 && Math.abs(o.z - zn.z) < (o.d + zn.d) / 2 + 1.5);
      if (!clash || attempt === 29) { zones.push(zn); break; }
    }
  }
  const perched = [];
  for (const zn of zones) if (zn.host) { perched.push(zn.host); delete zn.host; }

  /* Furniture rows down the floor */
  let objects = [];
  const [g0, g1] = theme.rowGap || [17, 25];
  for (let z = T.r(20, 28); z < L - 14; z += T.r(g0, g1)) objects.push(...T.pick(theme.rows)(z, W, T));
  // Along-the-wall decor
  for (let z = T.r(8, 20); z < L - 6; z += T.r(18, 32)) {
    const o = T.pick([F.plant, F.cabinet, F.shelf, F.cooler])(0, z, T);
    if (o.type === 'shelf') { o.w = 2; o.d = T.r(6, 10); }
    o.x = T.pick([-1, 1]) * (W / 2 - o.w / 2 - 0.3);
    objects.push(o);
  }

  // Keep things inside the room, off the launch area, out of the lane (if
  // tall), and off the landing zones.
  objects = objects.filter(o => {
    o.x = Math.max(-W / 2 + o.w / 2, Math.min(W / 2 - o.w / 2, o.x));
    o.z = Math.max(o.d / 2 + 1, Math.min(L - o.d / 2 - 1, o.z));
    if (o.h > H) o.h = H;
    if (o.z - o.d / 2 < 16) return false;
    if (topOf(o) > TALL && inLane(o)) return false;
    for (const zn of zones) if (overlapsRect(o, zn.x - zn.w / 2 - 1, zn.x + zn.w / 2 + 1, zn.z - zn.d / 2 - 1, zn.z + zn.d / 2 + 1)) return false;
    return true;
  });
  objects.push(...perched);
  objects.unshift({ type: 'desk', x: 0, z: -2.6, w: 13, d: 3, h: 4.2, launch: true });
  const boxes = objects.flatMap(boxesFor);

  const freeAt = (x, z, r) => boxes.every(b => x + r < b.x0 || x - r > b.x1 || z + r < b.z0 || z - r > b.z1);
  const solidAt = (x, y, z) => boxes.some(b => x > b.x0 - 0.6 && x < b.x1 + 0.6 && z > b.z0 - 0.6 && z < b.z1 + 0.6 && y > b.y0 - 0.6 && y < b.y1 + 0.6);

  /* Air currents */
  const vents = [];
  const nVents = many(theme.vents);
  for (let tries = 0; vents.length < nVents && tries < 300; tries++) {
    // The first two vents hug the lane so a good line always has lift on it.
    const z = T.r(30, L * 0.75);
    const x = vents.length < 2 * k ? laneX(z) + T.r(-2.5, 2.5) : T.r(-W / 2 + 4, W / 2 - 4);
    const r = T.r(3, 4) * Math.pow(k, 0.25);
    if (Math.abs(x) > W / 2 - r - 0.5 || !freeAt(x, z, r + 0.5)) continue;
    if (vents.some(v => Math.hypot(v.x - x, v.z - z) < 14)) continue;
    if (zones.some(zn => Math.abs(zn.x - x) < zn.w / 2 + r && Math.abs(zn.z - z) < zn.d / 2 + r)) continue;
    vents.push({ x, z, r, s: T.r(6.5, 9) * sk });
  }
  vents.sort((a, b) => a.z - b.z);

  const fans = [];
  const nFans = many(theme.fans);
  for (let tries = 0; fans.length < nFans && tries < 100; tries++) {
    const z = T.r(35, L * 0.8), x = T.r(-W / 2 + 6, W / 2 - 6);
    if (fans.some(f => Math.hypot(f.x - x, f.z - z) < 20) || vents.some(v => Math.hypot(v.x - x, v.z - z) < 10)) continue;
    fans.push({ x, z, r: T.r(4.5, 5.5), s: T.r(4, 5.5) });
  }

  const blowers = [];
  const nBlowers = many(theme.blowers);
  for (let i = 0; i < nBlowers; i++) {
    const z = T.r(30, L * 0.7), lx = laneX(z);
    blowers.push({ x0: lx - 6, x1: lx + 6, z0: z, z1: z + 6, y1: 9, dir: T.pick([-1, 1]), s: 4 });
  }

  /* Moving obstacles (floor 2 and up): placed across the clear lane so they matter */
  const movers = [];
  if (theme.movers?.length) {
    const want = many(theme.moverCount);
    for (let tries = 0; movers.length < want && tries < 200; tries++) {
      const z = T.r(30, L * 0.85);
      const m = T.pick(theme.movers)(laneX(z) + T.r(-2, 2), z, T, H);
      m.phase = rng();
      const sw = moverSweep(m);
      if (Math.abs(sw.x) + sw.w / 2 > W / 2 - 0.5) { m.x -= Math.sign(sw.x) * (Math.abs(sw.x) + sw.w / 2 - W / 2 + 0.5); }
      const s2 = moverSweep(m);
      const clear = boxes.every(b => b.x1 < s2.x - s2.w / 2 || b.x0 > s2.x + s2.w / 2 || b.z1 < s2.z - s2.d / 2 || b.z0 > s2.z + s2.d / 2
        || b.y0 > m.y + m.h + (m.axis === 'y' ? m.to : 0) || b.y1 < m.y);
      if (!clear) continue;
      if (zones.some(zn => overlapsRect(s2, zn.x - zn.w / 2 - 2, zn.x + zn.w / 2 + 2, zn.z - zn.d / 2 - 2, zn.z + zn.d / 2 + 2))) continue;
      if (movers.some(o => Math.abs(o.z - m.z) < 18)) continue;
      if (vents.some(v => Math.hypot(v.x - s2.x, v.z - s2.z) < v.r + 3 && m.axis !== 'y')) continue;
      movers.push(m);
    }
  }

  /* Paper clips: columns over vents, runs along the lane, one bonus box */
  const clips = [];
  const addClip = (x, y, z, extra = {}) => {
    if (solidAt(x, y, z) || y > H - 1 || y < 0.8 || Math.abs(x) > W / 2 - 1) return;
    clips.push({ x, y, z, ...extra });
  };
  for (const v of vents) for (let i = 0; i < 3; i++) addClip(v.x, 7 + i * 2, v.z);
  const runs = many([2, 3]);
  for (let k = 0; k < runs; k++) {
    const z0 = T.r(10, L * 0.48), n = T.ri(3, 5), y = T.r(5, 7.5);
    for (let i = 0; i < n; i++) addClip(laneX(z0 + i * 3), y - i * 0.2, z0 + i * 3);
  }
  for (let i = 0; i < Math.round(k); i++) {
    const bz = T.r(60, L * 0.7);
    addClip(laneX(bz) + T.pick([-1, 1]) * T.r(4, 9), T.r(9, H - 2.5), bz, { n: 5, big: true });
  }

  const tier4 = zones.find(z => z.tier === 4);
  return {
    id: theme.id, number: theme.number, name: theme.name,
    carpet: theme.carpet, wall: theme.wall, accent: theme.accent,
    width: W, height: H, length: L, scale: k, seed,
    stakes: `${tier4.label} pays ${tier4.pay}`,
    objects, boxes, vents, fans, blowers, zones, clips, movers,
    lane: ctrl,   // the guaranteed-clear path, as [z, x] control points (bots follow it)
  };
}
