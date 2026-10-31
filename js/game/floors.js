// floors.js: the five levels, one per floor of the office building.
// Pure data plus a builder that turns furniture into collision boxes.
// Units: sim space (see sim.js). Width spans x = -W/2..W/2, z runs 0..length.
// The renderer reads the same `objects` list to build meshes, so what you see is
// exactly what you collide with.

export const ZONE_PAY = [3, 6, 10, 15, 24];

// Furniture types that are solid from the floor up. Everything else is listed in
// boxesFor() with its own shape.
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

// A line of paper clips from a to b, n of them.
function line(a, b, n, extra = {}) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? 0 : i / (n - 1);
    out.push({ x: a[0] + (b[0] - a[0]) * t, y: a[1] + (b[1] - a[1]) * t, z: a[2] + (b[2] - a[2]) * t, ...extra });
  }
  return out;
}
const box = (x, y, z) => ({ x, y, z, n: 5, big: true });

function zone(tier, label, x, z, w, d, y = 0) {
  return { tier, label, x, z, w, d, y, pay: ZONE_PAY[tier] };
}

function build(f) {
  f.width ??= 44; f.height ??= 16; f.length ??= 200;
  f.vents ??= []; f.fans ??= []; f.blowers ??= [];
  // Launch desk is the same on every floor.
  f.objects.unshift({ type: 'desk', x: 0, z: -2.6, w: 13, d: 3, h: 4.2, launch: true });
  f.boxes = f.objects.flatMap(boxesFor);
  return f;
}

export const FLOORS = [
  build({
    id: 'lobby', number: 1, name: 'Lobby',
    carpet: '#c9b48a', wall: '#e9e1cf', accent: '#c1440e', height: 16,
    stakes: 'Elevator pays 24',
    objects: [
      { type: 'counter', x: 0, z: 36, w: 14, d: 3, h: 3.6 },
      { type: 'pillar', x: -12, z: 58, w: 2.4, d: 2.4, h: 16 },
      { type: 'pillar', x: 12, z: 58, w: 2.4, d: 2.4, h: 16 },
      { type: 'pillar', x: -12, z: 112, w: 2.4, d: 2.4, h: 16 },
      { type: 'pillar', x: 12, z: 112, w: 2.4, d: 2.4, h: 16 },
      { type: 'plant', x: -19, z: 20, w: 1.8, d: 1.8, h: 4.5 },
      { type: 'plant', x: 19, z: 20, w: 1.8, d: 1.8, h: 4.5 },
      { type: 'plant', x: -19, z: 86, w: 1.8, d: 1.8, h: 4.5 },
      { type: 'plant', x: 19, z: 86, w: 1.8, d: 1.8, h: 4.5 },
      { type: 'couch', x: -16, z: 74, w: 8, d: 3, h: 2.2 },
      { type: 'couch', x: 16, z: 74, w: 8, d: 3, h: 2.2 },
      { type: 'table', x: 0, z: 80, w: 6, d: 4, h: 1.6 },
      { type: 'desk', x: -7, z: 160, w: 8, d: 4, h: 3, mon: true },
      { type: 'cooler', x: 18, z: 150, w: 1.6, d: 1.6, h: 4.4 },
      { type: 'plant', x: -19, z: 176, w: 1.8, d: 1.8, h: 4.5 },
      { type: 'plant', x: 19, z: 176, w: 1.8, d: 1.8, h: 4.5 },
    ],
    vents: [
      { x: 0, z: 60, r: 4, s: 7 },
      { x: 10, z: 98, r: 3.2, s: 6 },
      { x: -9, z: 124, r: 3.2, s: 6 },
    ],
    zones: [
      zone(0, 'Welcome Mat', 0, 100, 18, 14),
      zone(1, 'Lobby Rug', -9, 128, 13, 10),
      zone(2, 'Mail Cart', 10, 142, 8, 8),
      zone(3, 'Security Desk', -7, 160, 8, 4, 3),
      zone(4, 'Elevator', 0, 192, 9, 8),
    ],
    clips: [
      ...line([0, 6.5, 14], [0, 6.5, 30], 5),
      ...line([0, 9, 56], [0, 13, 64], 4),
      box(0, 14, 70),
      ...line([10, 8, 92], [10, 11, 104], 4),
      ...line([-9, 7, 118], [-9, 10, 130], 4),
      ...line([-4, 4, 170], [0, 2, 186], 4),
    ],
  }),

  build({
    id: 'cubicles', number: 2, name: 'Cubicle Farm',
    carpet: '#8f9aa3', wall: '#dfe3e2', accent: '#1e4d6b', height: 13,
    stakes: 'Window Seat pays 24',
    objects: [
      // Partition rows across the floor with gaps to thread
      { type: 'cubicle', x: -15, z: 32, w: 14, d: 0.5, h: 5 },
      { type: 'cubicle', x: 7, z: 32, w: 18, d: 0.5, h: 5 },
      { type: 'cubicle', x: -8, z: 56, w: 24, d: 0.5, h: 5.5 },
      { type: 'cubicle', x: 18, z: 56, w: 8, d: 0.5, h: 5.5 },
      { type: 'cubicle', x: -18, z: 80, w: 8, d: 0.5, h: 5.5 },
      { type: 'cubicle', x: 8, z: 80, w: 24, d: 0.5, h: 5.5 },
      { type: 'cubicle', x: -12, z: 104, w: 20, d: 0.5, h: 5 },
      { type: 'cubicle', x: 14, z: 104, w: 16, d: 0.5, h: 5 },
      // Lengthwise partitions making cubicles near the end
      { type: 'cubicle', x: -6, z: 140, w: 0.5, d: 22, h: 4.5 },
      { type: 'cubicle', x: 8, z: 150, w: 0.5, d: 26, h: 4.5 },
      { type: 'desk', x: -14, z: 44, w: 7, d: 3, h: 3, mon: true },
      { type: 'desk', x: 12, z: 44, w: 7, d: 3, h: 3, mon: true },
      { type: 'desk', x: -2, z: 68, w: 7, d: 3, h: 3, mon: true },
      { type: 'desk', x: 15, z: 92, w: 7, d: 3, h: 3, mon: true },
      { type: 'desk', x: -15, z: 92, w: 7, d: 3, h: 3, mon: true },
      { type: 'printer', x: 0, z: 118, w: 3, d: 2.4, h: 3.4 },
      { type: 'cabinet', x: -20, z: 132, w: 2.4, d: 3, h: 4.4 },
      { type: 'desk', x: -14, z: 150, w: 8, d: 3.5, h: 3, mon: true },
      { type: 'desk', x: 15, z: 168, w: 7, d: 3.5, h: 3, mon: true },
      { type: 'plant', x: 20, z: 120, w: 1.8, d: 1.8, h: 4.5 },
    ],
    vents: [
      { x: -1, z: 44, r: 3.4, s: 7 },
      { x: -12, z: 66, r: 3, s: 6.5 },
      { x: 2, z: 96, r: 3.4, s: 7 },
      { x: 0, z: 134, r: 3, s: 5 },
    ],
    zones: [
      zone(0, 'Hallway', 0, 120, 10, 12),
      zone(1, 'Intern Desk', -14, 150, 8, 3.5, 3),
      zone(2, 'Cubicle 4B', 1, 156, 11, 12),
      zone(3, "Manager's Desk", 15, 168, 7, 3.5, 3),
      zone(4, 'Window Seat', -12, 190, 10, 8),
    ],
    clips: [
      ...line([-6, 6.5, 26], [-6, 6.5, 38], 4),
      ...line([-1, 8, 42], [-1, 11, 48], 3),
      ...line([12, 6.5, 52], [12, 6.5, 60], 3),
      ...line([-12, 8, 62], [-12, 10, 70], 3),
      box(-12, 7, 80),
      ...line([2, 9, 92], [2, 11, 100], 3),
      ...line([2, 7, 104], [-6, 6, 116], 4),
      box(0, 2, 160),
    ],
  }),

  build({
    id: 'breakroom', number: 3, name: 'Break Room',
    carpet: '#b9c9b2', wall: '#efe4c8', accent: '#3d6b52', height: 15,
    stakes: 'Top of the fridge pays 24',
    objects: [
      { type: 'counter', x: -17, z: 30, w: 8, d: 16, h: 3.6 },
      { type: 'vending', x: 19, z: 30, w: 4, d: 3, h: 7.5 },
      { type: 'vending', x: 19, z: 36, w: 4, d: 3, h: 7.5 },
      { type: 'table', x: -6, z: 58, w: 7, d: 5, h: 2.8 },
      { type: 'table', x: 8, z: 66, w: 7, d: 5, h: 2.8 },
      { type: 'table', x: -8, z: 86, w: 7, d: 5, h: 2.8 },
      { type: 'couch', x: 15, z: 92, w: 9, d: 3, h: 2.2 },
      { type: 'tv', x: 15, z: 100, w: 8, d: 0.6, h: 5, y: 3 },
      { type: 'cooler', x: -19, z: 104, w: 1.6, d: 1.6, h: 4.4 },
      { type: 'table', x: 0, z: 128, w: 10, d: 6, h: 2.6 },
      { type: 'counter', x: 17, z: 150, w: 10, d: 4, h: 3.6 },
      { type: 'fridge', x: -16, z: 178, w: 5, d: 4, h: 7.5 },
      { type: 'shelf', x: 17, z: 186, w: 8, d: 2, h: 5 },
    ],
    fans: [
      { x: 0, z: 46, r: 5, s: 5 },
      { x: -2, z: 110, r: 5.5, s: 5.5 },
      { x: 10, z: 140, r: 4.5, s: 5 },
    ],
    vents: [
      { x: -17, z: 30, r: 3, s: 8, steam: true },
      { x: 4, z: 76, r: 3.4, s: 7 },
      { x: -12, z: 132, r: 3.4, s: 7.5 },
    ],
    zones: [
      zone(0, 'Sink Mat', 0, 112, 14, 10),
      zone(1, 'Lunch Table', 0, 128, 10, 6, 2.6),
      zone(2, 'Snack Counter', 17, 150, 10, 4, 3.6),
      zone(3, 'Ping-pong Corner', 4, 176, 12, 10),
      zone(4, 'Fridge Top', -16, 178, 5, 4, 7.5),
    ],
    clips: [
      ...line([-17, 7, 24], [-17, 11, 36], 4),
      ...line([0, 7, 52], [8, 6, 62], 4),
      ...line([4, 8, 72], [4, 12, 80], 3),
      box(-6, 4.2, 58),
      ...line([-12, 8, 126], [-12, 12, 136], 3),
      ...line([-14, 9, 150], [-16, 9, 168], 4),
    ],
  }),

  build({
    id: 'servers', number: 4, name: 'Server Room',
    carpet: '#7b8794', wall: '#c9d1d8', accent: '#1e4d6b', height: 14,
    stakes: 'Root Access pays 24',
    objects: [
      // Rows of racks running lengthwise, making aisles
      { type: 'rack', x: -13, z: 48, w: 3, d: 34, h: 9 },
      { type: 'rack', x: 0, z: 40, w: 3, d: 26, h: 9 },
      { type: 'rack', x: 13, z: 48, w: 3, d: 34, h: 9 },
      { type: 'rack', x: -7, z: 98, w: 3, d: 30, h: 9 },
      { type: 'rack', x: 7, z: 98, w: 3, d: 30, h: 9 },
      { type: 'rack', x: -19, z: 106, w: 3, d: 18, h: 9 },
      { type: 'rack', x: 19, z: 106, w: 3, d: 18, h: 9 },
      { type: 'crate', x: 0, z: 72, w: 4, d: 3, h: 2.5 },
      { type: 'desk', x: 12, z: 146, w: 8, d: 3.5, h: 3, mon: true },
      { type: 'cabinet', x: -14, z: 150, w: 6, d: 3, h: 6 },
      { type: 'rack', x: 0, z: 186, w: 4, d: 3, h: 7 },
    ],
    vents: [
      { x: -6.5, z: 46, r: 3, s: 9 },
      { x: 6.5, z: 46, r: 3, s: 9 },
      { x: 0, z: 98, r: 3.2, s: 9 },
      { x: -13, z: 98, r: 2.6, s: 8 },
      { x: 13, z: 98, r: 2.6, s: 8 },
    ],
    blowers: [
      { x0: -11.5, x1: -1.5, z0: 58, z1: 64, y1: 9, dir: 1, s: 4 },
      { x0: 1.5, x1: 11.5, z0: 26, z1: 32, y1: 9, dir: -1, s: 4 },
    ],
    zones: [
      zone(0, 'Cable Tray', 0, 126, 14, 10),
      zone(1, 'Cold Aisle', -2, 150, 8, 10),
      zone(2, 'Admin Desk', 12, 146, 8, 3.5, 3),
      zone(3, 'Tape Library', -14, 150, 6, 3, 6),
      zone(4, 'Root Access', 0, 186, 4, 3, 7),
    ],
    clips: [
      ...line([-6.5, 6, 30], [-6.5, 11, 50], 5),
      ...line([6.5, 6, 30], [6.5, 11, 50], 5),
      box(0, 10.5, 46),
      ...line([0, 9, 86], [0, 12, 100], 4),
      ...line([0, 9, 120], [0, 8, 140], 4),
      ...line([0, 8.5, 172], [0, 8, 182], 3),
    ],
  }),

  build({
    id: 'executive', number: 5, name: 'Executive Suite',
    carpet: '#8b3a2e', wall: '#efe6d6', accent: '#c1440e', height: 16,
    stakes: 'Corner Office pays 24',
    objects: [
      { type: 'glass', x: -14, z: 40, w: 16, d: 0.4, h: 16 },
      { type: 'glass', x: 14, z: 40, w: 16, d: 0.4, h: 16 },
      { type: 'table', x: 0, z: 70, w: 8, d: 22, h: 3.2 },
      { type: 'shelf', x: -20, z: 70, w: 2, d: 14, h: 7 },
      { type: 'plant', x: 18, z: 60, w: 1.8, d: 1.8, h: 4.5 },
      { type: 'glass', x: -16, z: 100, w: 12, d: 0.4, h: 16 },
      { type: 'glass', x: 4, z: 100, w: 12, d: 0.4, h: 16 },
      { type: 'couch', x: 14, z: 122, w: 8, d: 3, h: 2.2 },
      { type: 'shelf', x: -18, z: 150, w: 8, d: 2, h: 6 },
      { type: 'counter', x: 17, z: 160, w: 6, d: 3, h: 3.8 },
      { type: 'desk', x: -10, z: 186, w: 10, d: 5, h: 3.2, mon: true },
      { type: 'plant', x: 19, z: 194, w: 1.8, d: 1.8, h: 4.5 },
    ],
    vents: [
      { x: 0, z: 30, r: 3, s: 7 },
      { x: 13, z: 84, r: 3.4, s: 8 },
      { x: -3, z: 130, r: 3, s: 7 },
    ],
    fans: [
      { x: 0, z: 70, r: 5, s: 4 },
    ],
    zones: [
      zone(0, 'Visitor Chair', 2, 136, 12, 10),
      zone(1, 'Bookshelf', -18, 150, 8, 2, 6),
      zone(2, 'Mini Bar', 17, 160, 6, 3, 3.8),
      zone(3, 'Executive Rug', 4, 178, 12, 10),
      zone(4, 'Corner Office', -10, 186, 10, 5, 3.2),
    ],
    clips: [
      ...line([0, 7, 22], [0, 10, 36], 4),
      ...line([-4, 7, 42], [-4, 7, 50], 3),
      ...line([13, 8, 78], [13, 12, 90], 4),
      box(-10, 6, 100),
      ...line([-3, 7, 124], [-3, 10, 136], 3),
      ...line([-6, 6, 170], [-9, 4.5, 182], 3),
    ],
  }),
];

export const FLOOR_BY_ID = Object.fromEntries(FLOORS.map(f => [f.id, f]));
