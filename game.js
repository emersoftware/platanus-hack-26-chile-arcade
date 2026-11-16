// CÓNDOR 3000
//
// A small software renderer shown through Phaser 3. Everything is drawn into one low-resolution
// pixel buffer and scaled up with hard pixels:
//   · the world is a height and a colour per ground cell, blended into smooth slopes
//   · the flyer — a fighter with a condor's markings — is a stack of voxel slices that can yaw, bank,
//     pitch and roll
//   · clouds are a second, floating layer of domes that casts soft shadows
// The camera follows from behind and a little above.

const GAME_WIDTH = 800;
const GAME_HEIGHT = 600;

// DO NOT replace existing keys — they match the physical arcade cabinet wiring.
// To add local testing shortcuts, append extra keys to any array.
const CABINET_KEYS = {
  P1_U: ['w'],
  P1_D: ['s'],
  P1_L: ['a'],
  P1_R: ['d'],
  P1_1: ['u'],
  P1_2: ['i'],
  P1_3: ['o'],
  P1_4: ['j'],
  P1_5: ['k'],
  P1_6: ['l'],
  P2_U: ['ArrowUp'],
  P2_D: ['ArrowDown'],
  P2_L: ['ArrowLeft'],
  P2_R: ['ArrowRight'],
  P2_1: ['r'],
  P2_2: ['t'],
  P2_3: ['y'],
  P2_4: ['f'],
  P2_5: ['g'],
  P2_6: ['h'],
  START1: ['Enter'],
  START2: ['2'],
};

// ───────────────────────────────────────────────────────────── tunables

const P = {
  // flight
  speed: 31, // world units per second
  boost: 1.8, // × speed while the thruster is held
  turnRate: 1.25, // radians per second at full stick
  bankAngle: 52, // degrees of bank in a full turn
  climbRate: 22, // world units per second at full stick
  invertY: false, // true: stick up dives (flight-stick style)
  cruiseAlt: 22,
  ceiling: 330, // the top of the stratosphere
  rollTime: 0.8, // seconds for a barrel roll
  rollSlide: 11, // how far a barrel roll carries the condor sideways
  // model: small against the land, so the valley is wide and the cordillera towers
  modelScale: 0.2, // world units per design unit
  // camera
  chaseY: 0.62, // where the condor sits on screen, top to bottom
  chaseFollow: 7, // how quickly the camera swings round behind the condor …
  chaseSlide: 5, // … and how quickly it catches up when the condor moves sideways
  chaseDist: 2.6, // camera distance, in model lengths
  chaseElev: 12, // camera height above the condor, degrees
  chaseWidth: 0.27, // wingspan as a share of the screen
  // world
  seed: 3000,
  clouds: 0.45,
};

// ───────────────────────────────────────────────────────────── constants

const PX = 2; // screen pixels per buffer pixel
const RS = 3 / PX; // sizes below were drawn for three; this scales them
const BW = Math.ceil(GAME_WIDTH / PX);
const BH = Math.ceil(GAME_HEIGHT / PX);
const CXS = BW >> 1;

// The world is a strip of Chile: sea to the west, then the coastal hills, the central valley
// and the cordillera. It repeats north–south; east–west it just goes on (open sea one way,
// a high snowfield the other).
const N = 1024; // map size in cells
const NM = N - 1;
const NS = 10;
const BIG = 1 << 20; // keeps world coordinates positive (a multiple of N)
const COAST = 0.13; // where the sea ends, as a share of the map from the west
const HMAX = 127; // tallest peak
const SNOWFIELD = 100; // height the far east levels off at
const CA = 60; // cloud base altitude
const CK = 5; // thickest cloud
const BLEND_M = 2.5; // cells drawn larger than this many pixels are blended with their neighbours
const CLOUD_SOFT = 1.2; // thinner than this, a cloud is see-through
const ZTOP = HMAX + 2; // the tallest thing in the world

const VIEW_DIST = 700; // how far the eye reaches at ground level; from higher up it sees further
const FOG_N = 24;
const STRATO = 110; // where the sky starts to darken …
const SPACE = 300; // … and where it is all but black
const NEAR_W = 0.4; // nearest thing drawn, as a share of the camera distance
const DV_MIN = 1.5; // depth step limits, in screen pixels of ground
const DV_MAX = 3;
const EMPTY = 1e9;
const TAKEN = 1e8;

const SUN_X = 0.42; // where a shadow falls, per unit of height (east, south)
const SUN_Y = 0.34;
const SUN_AZ = -Math.PI * 0.25 - 0.1; // the sun sits opposite the shadows
const SUN_ELEV = 0.4;
const LIGHT = norm3(-0.5, -0.45, 0.74);

const TAU = Math.PI * 2;

// ───────────────────────────────────────────────────────────── helpers

function norm3(x, y, z) {
  const l = Math.hypot(x, y, z);
  return [x / l, y / l, z / l];
}

function clamp(v, a, b) {
  return v < a ? a : v > b ? b : v;
}

function wrapAngle(a) {
  a = (a + Math.PI) % TAU;
  return (a < 0 ? a + TAU : a) - Math.PI;
}

function ease(t) {
  return t * t * (3 - 2 * t);
}

function pack(r, g, b) {
  return ((255 << 24) | (clamp(b, 0, 255) << 16) | (clamp(g, 0, 255) << 8) | clamp(r, 0, 255)) >>> 0;
}

// Two colours blended: t of 255 parts of b over a.
function mix(a, b, t) {
  const u = 255 - t;
  return (
    (0xff000000 |
      (((((a >> 16) & 255) * u + ((b >> 16) & 255) * t) >> 8) << 16) |
      (((((a >> 8) & 255) * u + ((b >> 8) & 255) * t) >> 8) << 8) |
      (((a & 255) * u + (b & 255) * t) >> 8)) >>>
    0
  );
}

function makeRng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash2(x, y, s) {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ s;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (h ^ (h >>> 16)) >>> 0;
}

// Tileable value noise, several octaves, normalised to 0..1.
function fbm(cell, octaves, rnd) {
  const out = new Float32Array(N * N);
  let amp = 1;
  for (let o = 0; o < octaves; o++, cell >>= 1, amp *= 0.5) {
    const g = N / cell;
    const lat = new Float32Array(g * g);
    for (let i = 0; i < lat.length; i++) lat[i] = rnd();
    for (let y = 0; y < N; y++) {
      const gy = y / cell;
      const y0 = gy | 0;
      const ty = gy - y0;
      const sy = ty * ty * (3 - 2 * ty);
      const r0 = (y0 % g) * g;
      const r1 = ((y0 + 1) % g) * g;
      let p = y * N;
      for (let x = 0; x < N; x++, p++) {
        const gx = x / cell;
        const x0 = gx | 0;
        const tx = gx - x0;
        const sx = tx * tx * (3 - 2 * tx);
        const c0 = x0 % g;
        const c1 = (x0 + 1) % g;
        const a = lat[r0 + c0] + (lat[r0 + c1] - lat[r0 + c0]) * sx;
        const b = lat[r1 + c0] + (lat[r1 + c1] - lat[r1 + c0]) * sx;
        out[p] += (a + (b - a) * sy) * amp;
      }
    }
  }
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < out.length; i++) {
    if (out[i] < lo) lo = out[i];
    if (out[i] > hi) hi = out[i];
  }
  const k = 1 / (hi - lo);
  for (let i = 0; i < out.length; i++) out[i] = (out[i] - lo) * k;
  return out;
}

// The value below which `share` of the field lies.
function levelFor(field, share) {
  const hist = new Uint32Array(2048);
  for (let i = 0; i < field.length; i++) hist[(field[i] * 2047) | 0]++;
  const target = field.length * share;
  let acc = 0;
  let s = 0;
  while (s < 2047 && acc + hist[s] < target) acc += hist[s++];
  return s / 2047;
}

// ───────────────────────────────────────────────────────────── input

const KEY_TO_ARCADE = {};
for (const [code, keys] of Object.entries(CABINET_KEYS)) {
  for (const key of keys) KEY_TO_ARCADE[normalizeKey(key)] = code;
}

function normalizeKey(key) {
  return key.length === 1 ? key.toLowerCase() : key;
}

const held = Object.create(null);
const pressed = Object.create(null);

window.addEventListener('keydown', (e) => {
  const code = KEY_TO_ARCADE[normalizeKey(e.key || '')];
  if (!code) return;
  if (!held[code]) pressed[code] = true;
  held[code] = true;
});
window.addEventListener('keyup', (e) => {
  const code = KEY_TO_ARCADE[normalizeKey(e.key || '')];
  if (code) held[code] = false;
});

// ───────────────────────────────────────────────────────────── palettes

// CÓNDOR's own colours — a ramp of blues from deep navy through ice to white, and red — are
// kept for the flyer, the clouds and the sky. The ground has its own gradient, below.
const BLUES = [
  [42, 69, 96],
  [74, 111, 144],
  [112, 149, 184],
  [168, 200, 224],
  [224, 240, 255],
  [255, 255, 255],
];
const REDS = [
  [204, 51, 51],
  [255, 0, 64],
  [255, 68, 68],
];
const SKY_TOP = [100, 140, 190];
const SKY_LOW = [225, 240, 250];

const NR = 76; // steps in the ramp: 15 between each pair of blues
const WHITE = NR - 1;
const SHADOW = 13; // how many ramp steps a full shadow takes off a cloud
const CLOUD_LOW = 50; // the foot of a cloud's side
const CLOUD_UNDER = 44; // a cloud seen from below
const RAMP = [];
for (let i = 0; i < NR; i++) {
  const t = (i / (NR - 1)) * (BLUES.length - 1);
  const n = Math.min(t | 0, BLUES.length - 2);
  const a = BLUES[n];
  const b = BLUES[n + 1];
  RAMP.push([0, 1, 2].map((k) => Math.round(a[k] + (b[k] - a[k]) * (t - n))));
}

const PAL = new Uint32Array((FOG_N + 1) * NR); // [haze step][ramp step]

// The ground's colours, from the sea floor up to the snow: a place along this gradient, lit or
// shaded, gives every colour the land and the water take.
const GROUND = [
  [0, 26, 60, 106],
  [8, 44, 102, 150],
  [14, 84, 160, 190],
  [17, 240, 248, 250],
  [20, 214, 210, 198],
  [24, 140, 176, 100],
  [30, 98, 150, 86],
  [36, 90, 122, 80],
  [42, 86, 118, 142],
  [48, 112, 149, 184],
  [54, 168, 200, 224],
  [59, 224, 240, 255],
  [63, 255, 255, 255],
];
const GS = 4; // gradient places stored per unit above, so wide slopes of colour stay smooth
const NG = 63 * GS + 1;
const G_SHALLOW = 14;
const G_SURF = 17;
const G_SAND = 20;
const NL = 32; // light levels
const LIT_FLAT = 16; // level ground in the open
const LIT_SHADOW = 7; // how many levels a full shadow takes off
const GPAL = new Uint32Array((FOG_N + 1) * NG * NL); // [haze step][gradient place][light]

// What the flyer is made of. Each material runs from its colour in shadow to its colour in
// full sun (NLIT steps), then on towards white where it glints.
const NAVY = 1;
const PLUME = 2;
const HEAD = 3;
const GLASS = 4;
const ENGINE = 5;
const GLOW = 6; // the hot ring of a nozzle: always bright
const MATERIALS = [
  [0, 0, 0, 0, 0, 0],
  [10, 16, 32, 84, 122, 162],
  [116, 138, 176, 255, 255, 255],
  [104, 8, 34, 255, 34, 78],
  [18, 46, 78, 124, 192, 226],
  [8, 12, 22, 58, 68, 90],
  [255, 70, 90, 255, 70, 90],
  [255, 150, 50, 255, 170, 60],
  [58, 44, 34, 150, 122, 92],
];
const FIRE = 7;
const MUD = 8;
const GLINT = [0, 4, 5, 6, 12, 3, 0, 0, 1]; // how strongly each catches a highlight
const NLIT = 16;
const NLV = 24;
const JPAL = new Uint32Array(MATERIALS.length * NLV);
const FLAME = [RAMP[WHITE], REDS[2], REDS[1], REDS[0]].map((c) => pack(c[0], c[1], c[2]));
const colOutline = pack(RAMP[0][0], RAMP[0][1], RAMP[0][2]);
const colTrail = pack(255, 255, 255);
const colSmoke = pack(RAMP[47][0], RAMP[47][1], RAMP[47][2]);
const colSun = pack(255, 255, 255);
const colHaze = pack(SKY_LOW[0], SKY_LOW[1], SKY_LOW[2]);

function buildPalettes() {
  for (let f = 0; f <= FOG_N; f++) {
    const haze = (f / FOG_N) * 0.94;
    for (let c = 0; c < NR; c++) {
      const s = RAMP[c];
      PAL[f * NR + c] = pack(
        (s[0] + (SKY_LOW[0] - s[0]) * haze) | 0,
        (s[1] + (SKY_LOW[1] - s[1]) * haze) | 0,
        (s[2] + (SKY_LOW[2] - s[2]) * haze) | 0,
      );
    }
  }
  for (let g = 0; g < NG; g++) {
    let n = 0;
    const at = g / GS;
    while (GROUND[n + 1][0] < at) n++;
    const a = GROUND[n];
    const b = GROUND[n + 1];
    const t = (at - a[0]) / (b[0] - a[0]);
    for (let l = 0; l < NL; l++) {
      // light scales the colour; shade leans a little towards blue
      const k = 0.5 + l / 32;
      const cool = k < 1 ? 1 - k : 0;
      const r = (a[1] + (b[1] - a[1]) * t) * (k - cool * 0.1);
      const gg = (a[2] + (b[2] - a[2]) * t) * k;
      const bl = (a[3] + (b[3] - a[3]) * t) * (k + cool * 0.25);
      for (let f = 0; f <= FOG_N; f++) {
        const haze = (f / FOG_N) * 0.94;
        GPAL[(f * NG + g) * NL + l] = pack((r + (SKY_LOW[0] - r) * haze) | 0, (gg + (SKY_LOW[1] - gg) * haze) | 0, (bl + (SKY_LOW[2] - bl) * haze) | 0);
      }
    }
  }
  for (let m = 0; m < MATERIALS.length; m++) {
    const c = MATERIALS[m];
    for (let l = 0; l < NLV; l++) {
      const t = Math.min(1, l / (NLIT - 1));
      const up = l < NLIT ? 0 : ((l - NLIT + 1) / (NLV - NLIT)) * 0.75; // towards white
      const r = c[0] + (c[3] - c[0]) * t;
      const g = c[1] + (c[4] - c[1]) * t;
      const b = c[2] + (c[5] - c[2]) * t;
      JPAL[m * NLV + l] = pack((r + (255 - r) * up) | 0, (g + (255 - g) * up) | 0, (b + (255 - b) * up) | 0);
    }
  }
}

// ───────────────────────────────────────────────────────────── world

const H = new Uint8Array(N * N); // height of each ground cell, in half units
const HM = new Uint8Array((N >> 4) * (N >> 4)); // the tallest ground in and around each 16 × 16 block
const GR = new Uint8Array(N * N); // its colour, as a place along the ground gradient
const LIT = new Uint8Array(N * N); // how much light it catches (LIT_FLAT on level ground)
const R8 = new Uint8Array(N * N); // a random byte per cell (sparkle timing)
const GRAIN = new Float32Array(4096); // fine speckle laid over the ground close by, so it has a grain to rush past
for (let i = 0; i < 4096; i++) GRAIN[i] = ((hash2(i & 63, i >> 6, 9) & 255) / 255 - 0.5) * 2.4;
const CT = new Uint8Array(N * N); // cloud thickness per cell, in sixteenths
const CTONE = new Uint8Array(N * N); // the tone of the cloud's top there

function smooth(a, b, v) {
  const t = clamp((v - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}

// How much light a slope catches (0.74 on the flat), from how fast it rises east and south.
function lightOn(gx, gy) {
  return (0.5 * gx + 0.45 * gy + 0.74) / Math.sqrt(gx * gx + gy * gy + 1);
}

function buildWorld(seed) {
  const rnd = makeRng(seed);
  const broad = fbm(256, 5, rnd);
  const fine = fbm(64, 4, rnd);
  const rough = fbm(128, 3, rnd);
  const E = new Float32Array(N * N); // elevation
  QUEB.length = 0;

  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const i = (y << NS) | x;
      const r = hash2(x, y, seed);
      const jit = ((r >>> 8) & 255) / 255 - 0.5;
      const n = broad[i];
      const f = fine[i];
      // how far east this cell is; the noise bends the coast and the ranges
      const u = x / N + (n - 0.5) * 0.07 + (f - 0.5) * 0.012;
      // rivers run west from the cordillera to the sea, five to a lap of the map, each in a
      // ravine it has cut through the ranges; `cut` is how far this cell is from the nearest
      const lane = (y / N) * 5 + (n - 0.5) * 1.6 + (f - 0.5) * 0.12;
      const cut = Math.abs(lane - Math.round(lane));
      let e = 0;
      let g;
      if (x < 2 || u < COAST) {
        const d = x < 2 ? 1 : (COAST - u) / COAST;
        g = d < 0.02 ? G_SURF : G_SHALLOW * (1 - smooth(0, 0.6, d)); // surf, then deeper water
      } else {
        const ridge = 1 - Math.abs(2 * rough[i] - 1);
        const hills = Math.exp(-(((u - 0.21) / 0.04) ** 2)) * (4 + 44 * f * (0.35 + 0.65 * ridge)); // the coastal range
        const rise = smooth(0.5, 0.8, u);
        const peaks = rise * (26 + 100 * Math.pow(ridge, 1.5) * (0.5 + 0.5 * n) + (f - 0.5) * 12); // the cordillera
        const edge = smooth(0.93, 0.995, x / N); // far east: level off into a high snowfield
        e = 3 + 2 * n + hills + peaks;
        const bed = 2.5 + rise * 22; // the ground falls away into the ravine, down to the river
        if (e > bed) e = bed + (e - bed) * smooth(0.012, 0.13, cut);
        e = clamp(e + (SNOWFIELD - e) * edge, 0.5, HMAX) * smooth(-0.004, 0.03, u - COAST); // the land comes up out of the sea
        if (cut < 0.006 && rise > 0.4 && edge < 0.01 && r % 11 === 0) QUEB.push(i);

        // colour by height: green low down, then blue-grey rock and snow
        if (u - COAST < 0.012) g = G_SAND;
        else if (cut < 0.012 && edge < 0.01) g = G_SHALLOW - 2; // river
        else {
          g = e < 6 ? 24 + e * 0.7 : e < 34 ? 28 + (e - 6) * 0.36 : e < 90 ? 38 + (e - 34) * 0.29 : 54 + (e - 90 + jit * 4) * 0.5;
          if (e < 34) g += (f - 0.5) * 7 + (rough[i] - 0.5) * 5; // lighter and darker stretches of green
        }
        g += (63 - g) * edge;
      }
      E[i] = e;
      GR[i] = clamp(Math.round(g * GS), 0, NG - 1);
      R8[i] = r & 255;
    }
  }

  // Bake the light each cell catches from the way its slope faces.
  for (let y = 0; y < N; y++) {
    const up = ((y - 1) & NM) << NS;
    const dn = ((y + 1) & NM) << NS;
    for (let x = 0; x < N; x++) {
      const i = (y << NS) | x;
      const gx = (E[(y << NS) | Math.min(x + 1, NM)] - E[(y << NS) | Math.max(x - 1, 0)]) * 0.5;
      const gy = (E[dn | x] - E[up | x]) * 0.5;
      H[i] = Math.round(E[i] * 2);
      LIT[i] = clamp(Math.round(LIT_FLAT + (lightOn(gx, gy) - 0.74) * 30), 0, NL - 1);
    }
  }

  // The tallest ground in each block and the blocks around it, so the renderer can tell
  // cheaply that nothing at a spot can reach into view.
  const B = N >> 4;
  const top = new Uint8Array(B * B);
  for (let i = 0; i < N * N; i++) {
    const b = ((i >> NS) >> 4) * B + ((i & NM) >> 4);
    if (H[i] > top[b]) top[b] = H[i];
  }
  for (let by = 0; by < B; by++) {
    for (let bx = 0; bx < B; bx++) {
      let m = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) m = Math.max(m, top[((by + dy + B) % B) * B + clamp(bx + dx, 0, B - 1)]);
      }
      HM[by * B + bx] = m;
    }
  }

  // Clouds: thin sheets of varying thickness, whiter the thicker they are, lit like the ground.
  const puff = fbm(64, 4, rnd);
  const cover = clamp(P.clouds * 0.36, 0, 0.9);
  const thr = levelFor(puff, 1 - cover);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      // the noise is squeezed north–south, which draws the clouds out into long streaks
      const t = (puff[(((y * 3) & NM) << NS) | x] - thr) / (1 - thr);
      const i = (y << NS) | x;
      E[i] = t > 0 && cover > 0 ? CK * Math.pow(t, 0.6) : 0;
      CT[i] = Math.min(255, Math.round(E[i] * 16));
    }
  }
  for (let y = 0; y < N; y++) {
    const up = ((y - 1) & NM) << NS;
    const dn = ((y + 1) & NM) << NS;
    for (let x = 0; x < N; x++) {
      const i = (y << NS) | x;
      const gx = (E[(y << NS) | ((x + 1) & NM)] - E[(y << NS) | ((x - 1) & NM)]) * 0.5;
      const gy = (E[dn | x] - E[up | x]) * 0.5;
      CTONE[i] = clamp(Math.round(62 + E[i] * 3 + (lightOn(gx, gy) - 0.74) * 22), CLOUD_LOW + 2, WHITE);
    }
  }
  buildTowns(seed);
}

// Small towns, alternately in the valley and behind the beach: pale streets on the ground and
// a huddle of low buildings (each: x, y, ground, height, half-width, tone).
const TOWNS = [];
function buildTowns(seed) {
  TOWNS.length = 0;
  for (let k = 0; k < 6; k++) {
    let cx = 0;
    let cy = 0;
    for (let tries = 0; tries < 60; tries++) {
      // somewhere green and level, off the rivers
      const r = hash2(k, tries, seed);
      cx = N * (k & 1 ? COAST + 0.03 + (r % 100) / 4000 : 0.32 + (r % 100) / 800);
      cy = ((k + 0.5) * N) / 6 + ((r >>> 8) % 70) - 35;
      const g = GR[cell(cx, cy)] / GS;
      if (g > 23 && g < 32 && Math.abs(groundAt(cx + 7, cy) - groundAt(cx - 7, cy)) < 2.5) break;
    }
    const b = [];
    for (let gy = -4; gy <= 4; gy++) {
      for (let gx = -4; gx <= 4; gx++) {
        const r = hash2(gx + k * 32, gy, seed + 5);
        const d = Math.hypot(gx, gy);
        const i = cell(cx + gx * 2.7, cy + gy * 2.7);
        if (d < 4.4 + (r & 3) * 0.2 && GR[i] > G_SAND * GS) {
          for (let n = 0; n < 9; n++) GR[cell(cx + gx * 2.7 + (n % 3) - 1, cy + gy * 2.7 + ((n / 3) | 0) - 1)] = (G_SAND + 1) * GS;
        }
        if (d > 3.5 || r % 4 === 0) continue;
        const x = cx + gx * 2.7 + ((r >>> 4) % 10) / 12;
        const y = cy + gy * 2.7 + ((r >>> 20) % 10) / 12;
        b.push(x, y, groundAt(x, y), 1.2 + ((r >>> 8) % 3) * 0.7 + (d < 1.5 ? 1.6 : 0), 0.65 + ((r >>> 12) % 3) * 0.15, (r >>> 16) % 3);
      }
    }
    TOWNS.push({ x: cx, y: cy, b });
  }
}

// A power line runs the length of the valley: a pylon every PYLON units, cables sagging between.
const PYLON = 32;
const PYLON_H = 10;
const ARM = 1.2; // how far below a pylon's top the cables hang from …
const SAG = 1.8; // … and how much lower they are at mid-span
function lineX(y) {
  return N * (0.44 + 0.028 * Math.sin((y / N) * TAU * 2) + 0.012 * Math.sin((y / N) * TAU * 5 + 1));
}
function pylonTop(j) {
  return groundAt(lineX(j * PYLON + 16), j * PYLON + 16) + PYLON_H;
}

function groundAt(x, y) {
  return H[((Math.floor(y) & NM) << NS) | clamp(Math.floor(x), 0, NM)] * 0.5;
}

// ───────────────────────────────────────────────────────────── model

// The flyer is a fighter with a condor's markings, sculpted in voxels: swept wings whose tips
// split into feathers, twin fins and engines; dark body, white collar and wing bars, and a red
// nose for the condor's head. Its shape is described once, in design units (MW across the
// wings, ML nose to tail, MH tall), and cut into MK voxels per unit. Each voxel on the surface
// remembers which way it faces and how tucked-in it is, so it can be lit as a solid thing.
const MW = 47;
const ML = 49;
const MH = 13;
const MK = 2; // voxels per design unit
const GW = MW * MK;
const GL = ML * MK;
const GH = MH * MK;
const MCX = 23; // centre line
const MPJ = 26; // pivot, along the body
const MPK = 4; // pivot height (wing level)
const WING_ROOT = 5; // parts further out than this bend with the wings
// points on the model, in design units from the pivot: across, towards the nose, up
const NOZZLES = [
  [-3, MPJ - 48, 0.5],
  [3, MPJ - 48, 0.5],
];
const WINGTIPS = [
  [-21, MPJ - 36, 0],
  [21, MPJ - 36, 0],
];

const model = { n: 0, a: null, b: null, c: null, w: null, col: null, ni: null, ao: null, gi: null, gj: null, gk: null, used: null };
const GRID = new Uint8Array(GW * GL * GH); // the whole block, for casting the flyer's shadows on itself
const MASK = new Uint8Array(MW * ML); // the flyer from above, for its shadow on the ground
const NQ = new Float32Array(4096 * 3); // the directions a surface can face, 16 steps a side

function inEll(x, y, z, rx, ry, rz) {
  return (x / rx) ** 2 + (y / ry) ** 2 + (z / rz) ** 2 <= 1;
}

// What the flyer is made of at a point: x across from the centre line, y back from the nose,
// z up. 0 is empty air.
function partAt(x, y, z) {
  const d = Math.abs(x);
  if (inEll(x, y - 16, z - 7, 1.7, 4.4, 1.6)) return GLASS; // canopy
  if (inEll(x, y - 11, z - 5, 3.1, 1.6, 2.9)) return PLUME; // collar
  if (inEll(x, y - 5, z - 5, 1.7, 6, 1.6)) return HEAD; // nose
  if (inEll(x, y - 23, z - 5, 3.4, 21, 2.9)) return NAVY; // body
  if (d > 3.4 && d < 5.6 && y > 18.5 && y < 23.5 && z > 2.5 && z < 5.5) return y < 19.5 ? ENGINE : NAVY; // air intakes
  if (y > 29.5 && y < 47.5 && (d - 3) ** 2 + (z - 4.5) ** 2 < 5.2) return y > 46.4 ? GLOW : y > 43.5 ? ENGINE : NAVY; // engines
  if (y > 35.5 && y < 46.5 && z > 5.5) {
    // twin fins, leaning outwards, red at the top
    const top = Math.min(11.5, 6.5 + (y - 35.5) * 0.9);
    if (z < top && Math.abs(d - (3 + (z - 6) * 0.45)) < 0.55) return z > 8.6 && z > top - 1.6 ? HEAD : NAVY;
  }
  if (d < 10.5) {
    // tailplanes
    const le = 39.5 + d * 0.55;
    if (y > le && y < 46.5 + d * 0.2 && Math.abs(z - 4) < 0.5 && (d < 7.5 || (y - le) % 3 < 2)) return NAVY;
  }
  if (d < 22.5) {
    // wings: swept back, thick at the root and thin at the tips, which split into feathers
    const le = 16.5 + d * 0.62;
    const te = 36.5 + d * 0.08;
    if (y > le && y < te) {
      if (d > 16.5 && ((y - le) % 3 > 2 || d > 22.5 - Math.floor((y - le) / 3) * 1.5)) return 0;
      const along = (y - le) / (te - le);
      const half = Math.max(0.5, (0.45 + 1.5 * (1 - d / 22)) * Math.sqrt(4 * along * (1 - along)));
      if (Math.abs(z - 4.2) < half) return d > 4.5 && d < 15.5 && y > te - 5 && y < te - 2 ? PLUME : NAVY;
    }
  }
  return 0;
}

function buildModel() {
  const at = (i, j, k) => (i < 0 || j < 0 || k < 0 || i >= GW || j >= GL || k >= GH ? 0 : GRID[(k * GL + j) * GW + i]);
  for (let k = 0; k < GH; k++) {
    for (let j = 0; j < GL; j++) {
      for (let i = 0; i < GW; i++) {
        const v = partAt((i + 0.5) / MK - 0.5 - MCX, (j + 0.5) / MK - 0.5, (k + 0.5) / MK - 0.5);
        GRID[(k * GL + j) * GW + i] = v;
        if (v) MASK[((j / MK) | 0) * MW + ((i / MK) | 0)] = 1;
      }
    }
  }
  for (let q = 0; q < 4096; q++) {
    const x = (q & 15) - 7.5;
    const y = ((q >> 4) & 15) - 7.5;
    const z = (q >> 8) - 7.5;
    const l = Math.hypot(x, y, z);
    NQ[q * 3] = x / l;
    NQ[q * 3 + 1] = y / l;
    NQ[q * 3 + 2] = z / l;
  }

  // keep only the voxels that can be seen
  const a = [];
  const b = [];
  const c = [];
  const w = [];
  const col = [];
  const ni = [];
  const ao = [];
  const gi = [];
  const gj = [];
  const gk = [];
  const used = new Set();
  for (let k = 0; k < GH; k++) {
    for (let j = 0; j < GL; j++) {
      for (let i = 0; i < GW; i++) {
        const v = at(i, j, k);
        if (!v) continue;
        if (at(i - 1, j, k) && at(i + 1, j, k) && at(i, j - 1, k) && at(i, j + 1, k) && at(i, j, k - 1) && at(i, j, k + 1)) continue;
        // which way the surface faces: away from the solid around it; and how much solid
        // there is around it — a crease is darker, an edge catches the light
        let nx = 0;
        let ny = 0;
        let nz = 0;
        let full = 0;
        for (let dk = -2; dk <= 2; dk++) {
          for (let dj = -2; dj <= 2; dj++) {
            for (let di = -2; di <= 2; di++) {
              if (!at(i + di, j + dj, k + dk)) continue;
              nx -= di;
              ny += dj; // towards the nose is lower j
              nz -= dk;
              full++;
            }
          }
        }
        const l = Math.hypot(nx, ny, nz);
        if (l < 0.5) nz = 1;
        const s = 7.5 / (l < 0.5 ? 1 : l);
        const q = Math.round(nx * s + 7.5) | (Math.round(ny * s + 7.5) << 4) | (Math.round(nz * s + 7.5) << 8);
        const share = full / 125;
        const x = (i + 0.5) / MK - 0.5 - MCX;
        const y = (j + 0.5) / MK - 0.5;
        const z = (k + 0.5) / MK - 0.5;
        a.push(x);
        b.push(MPJ - y);
        c.push(z - MPK);
        w.push(y < 39 && z < 6 ? Math.max(0, Math.abs(x) - WING_ROOT) : 0);
        col.push(v);
        ni.push(q);
        ao.push(share > 0.5 ? 1 - Math.min(0.5, (share - 0.5) * 1.6) : 1 + Math.min(0.14, (0.5 - share) * 0.4));
        gi.push(i);
        gj.push(j);
        gk.push(k);
        used.add(q);
      }
    }
  }
  model.n = a.length;
  model.a = Float32Array.from(a);
  model.b = Float32Array.from(b);
  model.c = Float32Array.from(c);
  model.w = Float32Array.from(w);
  model.col = Uint8Array.from(col);
  model.ni = Uint16Array.from(ni);
  model.ao = Float32Array.from(ao);
  model.gi = Uint8Array.from(gi);
  model.gj = Uint8Array.from(gj);
  model.gk = Uint8Array.from(gk);
  model.used = Uint16Array.from(used);
}

// ───────────────────────────────────────────────────────────── state

const TRAIL_N = 72; // points kept per wingtip
const TRAIL_STEP = 1; // world units between them
const PUFF_N = 240; // smoke, fire, spray and dust: all the soft round things
const PUFF_F = 10;

function makeFlyer() {
  return {
    x: 0,
    y: 0,
    z: 0,
    yaw: 0,
    bank: 0,
    pitch: 0,
    roll: 0,
    thr: 0.3,
    turn: 0,
    lift: 0,
    rollT: 0,
    rollDir: 1,
    flex: 0.02, // how far the wings are bent up
    trail: [new Float32Array(TRAIL_N * 3), new Float32Array(TRAIL_N * 3)],
    trailHead: 0,
    trailLen: 0,
    trailX: 0,
    trailY: 0,
    ax: new Float32Array(9), // its axes in the world: wing, nose, up
    tip: new Float32Array(6), // where its wingtips are right now
    shade: null, // which of its voxels are in its own shadow, for the sun at (sunX, sunY, sunZ)
    sunX: 0,
    sunY: 0,
    sunZ: 9,
  };
}

const lead = makeFlyer(); // the condor
const puffs = new Float32Array(PUFF_N * PUFF_F);
let puffHead = 0;
let smokeClock = 0;

const cam = { x: 0, y: 0, yaw: 0, zr: 0, S: 1, q: 0.01, k: 0.2, cy: BH / 2 };
let now = 0;
let windX = 0;
let windY = 0;

// The game: the condor flies rescue over Chile while hacker drones hunt it.
const TITLE = 0;
const PLAY = 1;
const OVER = 2;
const SHOT = 240; // how fast the condor's shots fly
const G = {
  mode: TITLE,
  t: 0, // seconds in this mode
  score: 0,
  best: 0,
  mult: 1, // flying low multiplies every reward
  low: 0,
  shield: 100,
  inv: 0, // seconds of safety after a hit
  kick: 0, // the bounce off the ground
  fireCd: 0,
  water: 0, // loads of water aboard
  fill: 0,
  hacked: 0,
  purge: 0, // how far the pilot has shaken the hacker off
  chan: 0, // how far a hacker has got with breaking in
  immune: 0,
  dirX: 0,
  dirY: 0,
  side: 0, // which side of the power line the condor was on
  lock: null, // what the guns are tracking
  spawnT: 0,
  hackT: 0,
  fenceT: 0,
  emT: 0,
  emN: 0,
  satT: 0,
  msg: '',
  msgT: 0,
  shake: 0,
  flash: 0,
};
const drones = [];
const shots = []; // k: 0 the condor's, 1 the enemy's, 2 a load of water
const fires = [];
const folk = []; // people waiting for rescue
const fences = [];
let sat = null; // the hackers' satellite
let em = null; // the emergency under way: k 0 a wildfire, 1 a mudslide
const QUEB = []; // cells in the ravines of the cordillera, where mudslides start

// Sound: tones and bursts of noise, made on the spot.
let AC = null; // the audio context, once Phaser has one
let NOISE = null;
function tone(from, to, secs, type, vol) {
  if (!AC || AC.state !== 'running') return;
  const o = AC.createOscillator();
  const g = AC.createGain();
  const t = AC.currentTime;
  o.type = type;
  o.frequency.setValueAtTime(from, t);
  o.frequency.exponentialRampToValueAtTime(to, t + secs);
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + secs);
  o.connect(g).connect(AC.destination);
  o.start(t);
  o.stop(t + secs);
}
function burst(secs, vol) {
  if (!AC || AC.state !== 'running') return;
  if (!NOISE) {
    NOISE = AC.createBuffer(1, AC.sampleRate, AC.sampleRate);
    const d = NOISE.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
  }
  const s = AC.createBufferSource();
  const g = AC.createGain();
  s.buffer = NOISE;
  s.playbackRate.value = 0.4 + Math.random() * 0.3;
  g.gain.setValueAtTime(vol, AC.currentTime);
  g.gain.exponentialRampToValueAtTime(0.001, AC.currentTime + secs);
  s.connect(g).connect(AC.destination);
  s.start();
  s.stop(AC.currentTime + secs);
}

const rand = Math.random;
const spread = () => rand() * 2 - 1;

function cell(x, y) {
  return ((Math.floor(y) & NM) << NS) | clamp(Math.floor(x), 0, NM);
}

function say(text, secs) {
  G.msg = text;
  G.msgT = secs || 1.8;
}

function gain(points, text) {
  points *= G.mult;
  G.score += points;
  say(text + ' +' + points);
  tone(520, 1040, 0.16, 'triangle', 0.12);
}

function heal(n) {
  G.shield = Math.min(100, G.shield + n);
}

// kind: 0 exhaust · 1 flame · 2 flash · 3 water · 4 dust · 5 black smoke
function puff(x, y, z, vx, vy, vz, life, kind, size) {
  const o = puffHead * PUFF_F;
  puffHead = (puffHead + 1) % PUFF_N;
  puffs[o] = x;
  puffs[o + 1] = y;
  puffs[o + 2] = z;
  puffs[o + 3] = vx;
  puffs[o + 4] = vy;
  puffs[o + 5] = vz;
  puffs[o + 6] = 0.001;
  puffs[o + 7] = life;
  puffs[o + 8] = kind;
  puffs[o + 9] = size;
}

function boom(x, y, z, n) {
  for (let i = 0; i < n; i++) puff(x, y, z, spread() * 9, spread() * 9, spread() * 9, 0.35 + rand() * 0.5, i % 4 ? 1 : 5, 1.1);
  puff(x, y, z, 0, 0, 0, 0.16, 2, 3);
  burst(0.2 + n * 0.02, 0.25);
}

function damage(d) {
  G.shield -= d;
  if (G.shield > 0 || G.mode !== PLAY) return;
  G.shield = 0;
  boom(lead.x, lead.y, lead.z, 40);
  G.mode = OVER;
  G.t = 0;
  G.hacked = 0;
  if (G.score > G.best) G.best = G.score;
}

function hurt(d, why) {
  if (G.inv > 0 || G.mode !== PLAY) return;
  G.inv = 1;
  G.shake = 1;
  G.flash = 0.5;
  say(why, 1.2);
  tone(220, 50, 0.35, 'sawtooth', 0.2);
  damage(d);
}

function resetFlight() {
  lead.x = N * 0.41; // over the valley, heading north: sea to the left, cordillera to the right
  lead.y = N * 0.5;
  lead.z = P.cruiseAlt;
  lead.yaw = 0.12;
  cam.yaw = lead.yaw;
  cam.x = lead.x;
  cam.y = lead.y;
  lead.trailLen = 0;
  puffs.fill(0);
}

function startGame() {
  Object.assign(G, { mode: PLAY, t: 0, score: 0, mult: 1, low: 0, shield: 100, inv: 2, kick: 0, water: 0, hacked: 0, purge: 0, chan: 0, immune: 0, spawnT: 4, hackT: 20, fenceT: 9, emT: 10, emN: 0, satT: 14, flash: 0, side: 0 });
  drones.length = shots.length = fires.length = folk.length = fences.length = 0;
  sat = em = null;
  lead.z = Math.max(lead.z, groundAt(lead.x, lead.y) + 20);
  say('¡DESPEGA, CÓNDOR!', 2);
}

// ───────────────────────────────────────────────────────────── simulation

function axesOf(f) {
  const cy = Math.cos(f.yaw);
  const sy = Math.sin(f.yaw);
  const cp = Math.cos(f.pitch);
  const sp = Math.sin(f.pitch);
  const r = f.bank + f.roll;
  const cr = Math.cos(r);
  const sr = Math.sin(r);
  // level flight: wing = (cy, sy, 0), nose = (sy, −cy, 0), up = (0, 0, 1)
  const ux = -sy * sp; // up, after pitching
  const uy = cy * sp;
  const uz = cp;
  const a = f.ax;
  a[0] = cy * cr - ux * sr;
  a[1] = sy * cr - uy * sr;
  a[2] = -uz * sr;
  a[3] = sy * cp;
  a[4] = -cy * cp;
  a[5] = sp;
  a[6] = cy * sr + ux * cr;
  a[7] = sy * sr + uy * cr;
  a[8] = uz * cr;
}

// A point on the model (in voxels from the pivot) → the world.
function modelPoint(f, ma, mb, mc, out, o) {
  const a = f.ax;
  const s = P.modelScale;
  out[o] = f.x + s * (ma * a[0] + mb * a[3] + mc * a[6]);
  out[o + 1] = f.y + s * (ma * a[1] + mb * a[4] + mc * a[7]);
  out[o + 2] = f.z + s * (ma * a[2] + mb * a[5] + mc * a[8]);
}

function spawnDrone(k) {
  drones.push({ k, hp: k ? 4 : 2, r: k ? 1.9 : 1.5, a: 190, s: spread() * 50, u: 8, ta: 50, ts: 0, tu: 4, nt: 0, cd: 1.5 + rand(), ch: 0, x: 0, y: 0, z: 0 });
}

// A spot of ground near the condor, mostly ahead of it, that passes the test.
function landNear(near, far, test) {
  for (let n = 0; n < 80; n++) {
    const a = lead.yaw + spread() * 1.4;
    const d = near + rand() * (far - near);
    const x = lead.x + Math.sin(a) * d;
    const y = lead.y - Math.cos(a) * d;
    if (x > 4 && x < N - 4 && test(GR[cell(x, y)] / GS)) return [x, y];
  }
  return null;
}

const GREEN = (g) => g > 23 && g < 40;

function light(x, y) {
  fires.push({ x, y, z: groundAt(x, y) });
}

// A wildfire: a few fires that spread until they are put out with water from the sea or a river.
function startFire() {
  const at = landNear(110, 260, GREEN);
  if (!at) return false;
  for (let i = 0; i < 5; i++) light(at[0] + spread() * 8, at[1] + spread() * 8);
  em = { k: 0, t: 0 };
  say('¡INCENDIO! CARGA AGUA Y SUÉLTALA CON B5', 3);
  return true;
}

// A mudslide: it starts high in a ravine and runs down it, towards the people waiting below.
function startFlood() {
  let best = -1;
  let bd = 1e9;
  let by = 0;
  for (const q of QUEB) {
    const dy = ((((q >> NS) - lead.y) % N) + N * 1.5) % N - N / 2; // the short way round, north or south
    const d = Math.abs(Math.hypot((q & NM) - lead.x, dy) - 190);
    if (d < bd) {
      bd = d;
      best = q;
      by = lead.y + dy;
    }
  }
  if (best < 0) return false;
  // downhill from there, a cell at a time; where the ground is level, rivers run west
  const path = [];
  let x = best & NM;
  let y = Math.round(by);
  for (let s = 0; s < 230; s++) {
    path.push(x + 0.5, y + 0.5);
    let bx = -1;
    let bj = 0;
    let bh = 1e9;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const h = H[cell(x + dx, y + dy)] + dx * 0.6 + rand() * 0.2;
        if (h < bh) {
          bh = h;
          bx = dx;
          bj = dy;
        }
      }
    }
    x = clamp(x + bx, 2, N - 3);
    y += bj;
  }
  for (let i = 70; i < 230; i += 45) folk.push({ x: path[i * 2], y: path[i * 2 + 1], z: groundAt(path[i * 2], path[i * 2 + 1]), i });
  em = { k: 1, t: 0, path, at: 0, saved: 0 };
  say('¡ALUVIÓN! RESCATA A LA GENTE VOLANDO BAJO', 3);
  return true;
}

function endEmergency() {
  em = null;
  fires.length = folk.length = 0;
  G.emT = 12 + rand() * 8;
}

// Water lands: every fire close by goes out.
function douse(x, y, z) {
  for (let i = 0; i < 10; i++) puff(x, y, z + 0.5, spread() * 8, spread() * 8, 4 + rand() * 8, 0.6, 3, 1.2);
  let out = 0;
  for (let i = fires.length - 1; i >= 0; i--) {
    if (Math.hypot(fires[i].x - x, fires[i].y - y) < 9) {
      fires.splice(i, 1);
      out++;
    }
  }
  if (!out) return;
  gain(150 * out, 'FUEGO APAGADO');
  if (!fires.length && em) {
    gain(800, 'INCENDIO CONTROLADO');
    heal(25);
    endEmergency();
  }
}

function simulate(dt) {
  now += dt;
  windX = (windX + dt * 2) % N;
  windY = (windY + dt * 0.8) % N;
  G.t += dt;
  G.inv -= dt;
  G.immune -= dt;
  G.msgT -= dt;
  G.shake *= Math.exp(-5 * dt);
  G.flash *= Math.exp(-4 * dt);
  const play = G.mode === PLAY;

  // ── the stick flies the condor — backwards while it is hacked. Out of play, it wanders.
  const rawX = (held.P1_R ? 1 : 0) - (held.P1_L ? 1 : 0);
  const rawY = (held.P1_U ? 1 : 0) - (held.P1_D ? 1 : 0);
  let turn = rawX;
  let lift = P.invertY ? -rawY : rawY;
  const sx = Math.sin(lead.yaw);
  const sy = -Math.cos(lead.yaw);
  const ground = Math.max(groundAt(lead.x, lead.y), groundAt(lead.x + sx * 3, lead.y + sy * 3));
  if (!play) {
    turn = Math.sin(now * 0.23) * 0.45;
    lift = clamp((Math.max(ground, groundAt(lead.x + sx * 25, lead.y + sy * 25)) + 16 - lead.z) / 6, -1, 1);
  } else if (G.hacked) {
    turn = -turn;
    lift = -lift;
  }
  lead.turn += (turn - lead.turn) * (1 - Math.exp(-6 * dt));
  lead.lift += (lift - lead.lift) * (1 - Math.exp(-5 * dt));
  lead.thr += ((play && held.P1_4 ? 1 : 0.3) - lead.thr) * (1 - Math.exp(-4 * dt));
  const push = Math.max(0, (lead.thr - 0.3) / 0.7);
  const spd = P.speed * (1 + (P.boost - 1) * push);

  lead.yaw += lead.turn * P.turnRate * dt;
  lead.bank = (lead.turn * P.bankAngle * Math.PI) / 180;
  const vz = lead.lift * P.climbRate * (spd / P.speed);
  lead.pitch = Math.atan2(vz, spd);
  lead.x += sx * spd * dt;
  lead.y += sy * spd * dt;
  G.kick *= Math.exp(-4 * dt);
  lead.z = Math.min(P.ceiling, lead.z + (vz + G.kick) * dt);

  // the ground is solid: hitting it costs shield and throws the condor back up
  let agl = lead.z - ground;
  if (agl < 1) {
    lead.z = ground + 1;
    agl = 1;
    G.kick = 34;
    G.low = 0;
    hurt(30, '¡CHOQUE!');
  }
  // flying low multiplies every reward
  if (play) {
    G.low = agl < 8 ? Math.min(10, G.low + dt) : Math.max(0, G.low - dt * 4);
    G.mult = 1 + ((G.low / 2.5) | 0);
  }

  // barrel rolls: one full turn about the nose, left or right, sliding the condor that way.
  // While it rolls, shots glance off it and laser fences cannot hold it.
  if (play && (pressed.P1_2 || pressed.P1_3) && lead.rollT <= 0) {
    lead.rollT = 1;
    lead.rollDir = pressed.P1_2 ? -1 : 1;
    tone(240, 880, 0.6, 'sine', 0.06);
  }
  if (lead.rollT > 0) {
    const was = lead.rollT;
    lead.rollT = Math.max(0, was - dt / P.rollTime);
    lead.roll = lead.rollDir * TAU * ease(1 - lead.rollT);
    // the slide is quickest half-way through the roll
    const slide = (lead.rollDir * P.rollSlide * (Math.cos(Math.PI * lead.rollT) - Math.cos(Math.PI * was))) / 2;
    lead.x -= sy * slide;
    lead.y += sx * slide;
  } else lead.roll = 0;

  // the wings bend up a little in a climb
  lead.flex += (0.02 + lead.lift * 0.05 - lead.flex) * (1 - Math.exp(-10 * dt));
  axesOf(lead);
  const nx = lead.ax[3];
  const ny = lead.ax[4];
  const nz = lead.ax[5];
  const cfx = Math.sin(cam.yaw); // the way the camera looks: enemies keep their station in front of it
  const cfy = -Math.cos(cam.yaw);

  // ── the hack: the stick is reversed and the guns are dead until the pilot shakes it off,
  // by thrashing the stick about and hammering the fire button
  if (G.hacked) {
    if (rawX && rawX !== G.dirX) {
      G.dirX = rawX;
      G.purge += 0.1;
    }
    if (rawY && rawY !== G.dirY) {
      G.dirY = rawY;
      G.purge += 0.1;
    }
    if (pressed.P1_1) G.purge += 0.07;
    G.purge = Math.max(0, G.purge - dt * 0.15);
    damage(dt * 2.5);
    if ((now * 3 | 0) !== ((now - dt) * 3 | 0)) tone(520, 260, 0.25, 'square', 0.07); // the alarm
    if (G.purge >= 1) {
      G.hacked = 0;
      G.immune = 9;
      G.flash = 1;
      for (const d of drones) if (d.k) d.hp = 0;
      gain(400, '¡HACKER EXPULSADO!');
    }
  }

  // ── guns: they track whatever enemy is nearest the line of the nose
  G.lock = null;
  let best = 0.035;
  const aim = (t) => {
    const dx = t.x - lead.x;
    const dy = t.y - lead.y;
    const dz = t.z - lead.z;
    const d = Math.hypot(dx, dy, dz);
    const off = 1 - (dx * nx + dy * ny + dz * nz) / d;
    if (d < 150 && off < best) {
      best = off;
      G.lock = t;
    }
  };
  drones.forEach(aim);
  if (sat) aim(sat);
  G.fireCd -= dt;
  if (play && held.P1_1 && !G.hacked && G.fireCd <= 0) {
    G.fireCd = 0.12;
    tone(1100, 320, 0.07, 'square', 0.03);
    shots.push({ k: 0, x: lead.x + nx * 3, y: lead.y + ny * 3, z: lead.z + nz * 3, vx: nx * SHOT, vy: ny * SHOT, vz: nz * SHOT, t: 0.7, to: G.lock });
  }

  // ── shots and loads of water
  for (let i = shots.length - 1; i >= 0; i--) {
    const s = shots[i];
    if (s.to && s.to.hp > 0) {
      const dx = s.to.x - s.x;
      const dy = s.to.y - s.y;
      const dz = s.to.z - s.z;
      const d = SHOT / Math.hypot(dx, dy, dz);
      s.vx = dx * d;
      s.vy = dy * d;
      s.vz = dz * d;
    }
    if (s.k === 2) s.vz -= 40 * dt;
    s.x += s.vx * dt;
    s.y += s.vy * dt;
    s.z += s.vz * dt;
    s.t -= dt;
    let dead = s.t <= 0;
    const gz = groundAt(s.x, s.y);
    if (s.z < gz) {
      dead = true;
      if (s.k === 2) douse(s.x, s.y, gz);
      else puff(s.x, s.y, gz + 0.3, 0, 0, 2, 0.3, 4, 0.6);
    } else if (!s.k) {
      const hit = (d) => {
        if (dead || Math.hypot(d.x - s.x, d.y - s.y, d.z - s.z) > d.r + 1) return;
        d.hp--;
        dead = true;
        puff(s.x, s.y, s.z, 0, 0, 0, 0.12, 2, 1.2);
      };
      drones.forEach(hit);
      if (sat) hit(sat);
    } else if (s.k === 1 && play && Math.hypot(lead.x - s.x, lead.y - s.y, lead.z - s.z) < 2.4) {
      dead = true;
      if (lead.rollT > 0) puff(s.x, s.y, s.z, 0, 0, 0, 0.15, 2, 1.5);
      else hurt(14, '¡IMPACTO!');
    }
    if (dead) shots.splice(i, 1);
  }
  const shootAt = (d, size) => {
    const t = Math.hypot(lead.x - d.x, lead.y - d.y, lead.z - d.z) / 70; // lead the condor a little
    const tx = lead.x + sx * spd * t * 0.8 - d.x;
    const ty = lead.y + sy * spd * t * 0.8 - d.y;
    const tz = lead.z + vz * t * 0.8 - d.z;
    const l = 70 / Math.hypot(tx, ty, tz);
    shots.push({ k: 1, x: d.x, y: d.y, z: d.z, vx: tx * l, vy: ty * l, vz: tz * l, t: 4, r: size });
  };

  // ── drones keep a station ahead of the condor, weaving about it. Shooters fire; hackers
  // need a few seconds of clear signal to break in, and a roll cuts the signal
  G.chan = 0;
  for (let i = drones.length - 1; i >= 0; i--) {
    const d = drones[i];
    if (d.hp <= 0) {
      boom(d.x, d.y, d.z, 14);
      if (play) gain(d.k ? 300 : 100, d.k ? 'HACKER DERRIBADO' : 'DRON DERRIBADO');
      drones.splice(i, 1);
      continue;
    }
    if (now > d.nt) {
      d.ta = d.k ? 36 + rand() * 12 : 32 + rand() * 40;
      d.ts = spread() * (d.k ? 14 : 32);
      d.tu = spread() * 6 + 2;
      d.nt = now + 1.5 + rand() * 2.5;
    }
    const e = 1 - Math.exp(-1.3 * dt);
    d.a += (d.ta - d.a) * e;
    d.s += (d.ts - d.s) * e;
    d.u += (d.tu - d.u) * e;
    d.x = lead.x + cfx * d.a - cfy * d.s;
    d.y = lead.y + cfy * d.a + cfx * d.s;
    d.z = Math.max(lead.z + d.u, groundAt(d.x, d.y) + 3);
    if (!play) continue;
    if (!d.k) {
      d.cd -= dt;
      if (d.cd < 0 && d.a < 90) {
        d.cd = 1.4 + rand() * 2;
        shootAt(d, 0.6);
      }
    } else if (!G.hacked && G.immune <= 0 && d.a < 70) {
      d.ch = lead.rollT > 0 ? Math.max(0, d.ch - dt * 1.5) : d.ch + dt / 3;
      G.chan = Math.max(G.chan, d.ch);
      if (d.ch >= 1) {
        d.ch = 0;
        G.hacked = 1;
        G.purge = 0;
        G.low = 0;
      }
    }
  }

  if (play) {
    G.spawnT -= dt;
    if (G.spawnT < 0 && drones.length < Math.min(6, 2 + ((G.t / 25) | 0))) {
      G.spawnT = Math.max(2.5, 7 - G.t / 30);
      spawnDrone(0);
    }

    // ── the hackers' satellite, far up in the stratosphere: while it is there it keeps
    // sending hacker drones down
    if (!sat) {
      G.satT -= dt;
      if (G.satT < 0) {
        sat = { x: lead.x + cfx * 90, y: lead.y + cfy * 90, z: 285, hp: 14, r: 4.5, cd: 3 };
        say('SATÉLITE HACKER EN LA ESTRATÓSFERA', 2.5);
      }
    } else if (sat.hp <= 0) {
      boom(sat.x, sat.y, sat.z, 40);
      gain(1500, 'SATÉLITE DESTRUIDO');
      sat = null;
      G.satT = 60;
      G.hackT = 20;
    } else {
      const e = 1 - Math.exp(-0.3 * dt);
      sat.x += (lead.x + cfx * 60 - sat.x) * e;
      sat.y += (lead.y + cfy * 60 - sat.y) * e;
      sat.cd -= dt;
      if (sat.cd < 0 && Math.hypot(lead.x - sat.x, lead.y - sat.y, lead.z - sat.z) < 130) {
        sat.cd = 1.3;
        shootAt(sat, 1);
      }
      G.hackT -= dt;
      if (G.hackT < 0) {
        G.hackT = 24;
        spawnDrone(1);
      }
    }

    // ── laser fences across the condor's path: roll through one, or go round it
    G.fenceT -= dt;
    if (G.fenceT < 0 && agl < 30 && lead.z < 100) {
      G.fenceT = 10 + rand() * 8;
      const off = spread() * 8;
      const x = lead.x + sx * 130 - sy * off;
      const y = lead.y + sy * 130 + sx * off;
      const z = Math.max(groundAt(x, y), groundAt(x - sy * 18, y + sx * 18), groundAt(x + sy * 18, y - sx * 18)) + 2;
      fences.push({ x, y, nx: sx, ny: sy, w: 22, z0: z, z1: z + 15, was: -1 });
    }
    for (let i = fences.length - 1; i >= 0; i--) {
      const f = fences[i];
      const dx = lead.x - f.x;
      const dy = lead.y - f.y;
      const along = dx * f.nx + dy * f.ny;
      if (f.was < 0 && along >= 0 && Math.abs(dy * f.nx - dx * f.ny) < f.w && lead.z > f.z0 - 1 && lead.z < f.z1 + 1) {
        if (lead.rollT > 0) {
          gain(250, '¡TONEL!');
          heal(5);
        } else hurt(22, '¡LÁSER!');
      }
      f.was = along;
      if (along > 30 || along < -250) fences.splice(i, 1);
    }

    // ── the power line: the cables and the pylons are solid; slipping under the cables pays
    const off = lead.x - lineX(lead.y);
    const span = (lead.y - 16) / PYLON;
    const j = Math.floor(span);
    const fr = span - j;
    const wire = pylonTop(j) + (pylonTop(j + 1) - pylonTop(j)) * fr - ARM - SAG * 2 * Math.min(fr, 1 - fr);
    if (Math.abs(off) < 3.4 && Math.abs(lead.z - wire) < 0.9) hurt(18, '¡CABLES!');
    else if (Math.abs(off) < 1.6 && (fr < 0.06 || fr > 0.94) && lead.z < wire + ARM) hurt(25, '¡TORRE!');
    else if (off * G.side < 0 && Math.abs(off) < 3 && lead.z < wire) gain(120, 'BAJO LOS CABLES');
    G.side = off;

    // ── buildings are solid too
    for (const t of TOWNS) {
      const dy = lead.y - t.y - Math.round((lead.y - t.y) / N) * N; // the town's nearest self, north or south
      if (Math.abs(lead.x - t.x) + Math.abs(dy) > 26) continue;
      for (let o = 0; o < t.b.length; o += 6) {
        const w = t.b[o + 4] + 0.8;
        if (Math.abs(lead.x - t.b[o]) < w && Math.abs(dy - t.b[o + 1] + t.y) < w && lead.z < t.b[o + 2] + t.b[o + 3] + 0.3) {
          hurt(25, '¡EDIFICIO!');
          G.kick = 24;
        }
      }
    }

    // ── water: skim the sea or a river to take it on, B5 to let a load go
    if (GR[cell(lead.x, lead.y)] <= G_SHALLOW * GS && agl < 3.5 && G.water < 3) {
      G.fill += dt;
      puff(lead.x, lead.y, ground + 0.3, spread() * 5 - sx * 8, spread() * 5 - sy * 8, 5 + rand() * 5, 0.5, 3, 0.8);
      if (G.fill > 0.4) {
        G.fill = 0;
        G.water++;
        say('AGUA A BORDO', 1);
        tone(300, 600, 0.12, 'sine', 0.1);
      }
    }
    if (pressed.P1_5 && G.water > 0) {
      G.water--;
      shots.push({ k: 2, x: lead.x, y: lead.y, z: lead.z - 1, vx: sx * spd, vy: sy * spd, vz: -4, t: 8 });
    }

    // ── emergencies, one at a time: a wildfire, then a mudslide, and round again
    if (!em) {
      G.emT -= dt;
      if (G.emT < 0) {
        if (G.emN++ & 1 ? startFlood() : startFire()) G.emT = 0;
        else G.emT = 2;
      }
    } else {
      em.t += dt;
      if (!em.k) {
        // the fire spreads; too many fires and it is beyond saving
        if (em.t > 5) {
          em.t = 0;
          const f = fires[(rand() * fires.length) | 0];
          const x = f.x + spread() * 10;
          const y = f.y + spread() * 10;
          if (GREEN(GR[cell(x, y)] / GS)) light(x, y);
          if (fires.length > 11) {
            say('INCENDIO FUERA DE CONTROL', 2.5);
            G.low = 0;
            endEmergency();
          }
        }
      } else {
        // the mud runs down the ravine; anyone it reaches is lost
        em.at = Math.min(em.path.length / 2 - 1, em.at + dt * 3.4);
        const o = (em.at | 0) * 2;
        em.x = em.path[o];
        em.y = em.path[o + 1];
        em.z = groundAt(em.x, em.y);
        if (rand() < dt * 14) puff(em.x + spread() * 3, em.y + spread() * 3, em.z + 1, spread() * 3, spread() * 3, 2 + rand() * 3, 1.2, 4, 1.6);
        for (let i = folk.length - 1; i >= 0; i--) {
          const f = folk[i];
          if (Math.hypot(lead.x - f.x, lead.y - f.y) < 5 && lead.z - f.z < 7) {
            folk.splice(i, 1);
            em.saved++;
            gain(500, '¡RESCATADO!');
            heal(10);
            puff(f.x, f.y, f.z + 1, 0, 0, 6, 0.4, 2, 2);
          } else if (em.at >= f.i) {
            folk.splice(i, 1);
            say('EL ALUVIÓN SE LLEVÓ A ALGUIEN', 2);
          }
        }
        if (!folk.length) {
          if (em.saved > 3) gain(600, 'TODOS A SALVO');
          endEmergency();
        }
      }
    }
  }

  // ── fires burn: flames and black smoke
  for (const f of fires) {
    if (Math.abs(f.x - lead.x) + Math.abs(f.y - lead.y) > 260) continue;
    if (rand() < dt * 9) puff(f.x + spread(), f.y + spread(), f.z + 0.5, spread(), spread(), 4 + rand() * 4, 0.6, 1, 1.3);
    if (rand() < dt * 2.5) puff(f.x, f.y, f.z + 3, 1.5 + spread(), 0.6 + spread(), 5 + rand() * 3, 2.2, 5, 1.8);
  }

  // ── wingtip trails, exhaust, and everything that drifts
  const alive = G.mode !== OVER;
  const lift2 = (WINGTIPS[1][0] - WING_ROOT) * lead.flex;
  modelPoint(lead, WINGTIPS[0][0], WINGTIPS[0][1], WINGTIPS[0][2] + lift2, lead.tip, 0);
  modelPoint(lead, WINGTIPS[1][0], WINGTIPS[1][1], WINGTIPS[1][2] + lift2, lead.tip, 3);
  if (!alive) lead.trailLen = 0;
  else if (!lead.trailLen || Math.hypot(lead.x - lead.trailX, lead.y - lead.trailY) >= TRAIL_STEP) {
    lead.trailHead = (lead.trailHead + 1) % TRAIL_N;
    if (lead.trailLen < TRAIL_N) lead.trailLen++;
    lead.trailX = lead.x;
    lead.trailY = lead.y;
    for (let s = 0; s < 2; s++) {
      const o = lead.trailHead * 3;
      lead.trail[s][o] = lead.tip[s * 3];
      lead.trail[s][o + 1] = lead.tip[s * 3 + 1];
      lead.trail[s][o + 2] = lead.tip[s * 3 + 2];
    }
  }
  smokeClock += dt;
  if (smokeClock > 0.035) {
    smokeClock = 0;
    if (alive && lead.thr > 0.6) {
      for (const nz2 of NOZZLES) {
        modelPoint(lead, nz2[0], nz2[1] - 6, nz2[2], puffs, puffHead * PUFF_F);
        const o = puffHead * PUFF_F;
        puff(puffs[o], puffs[o + 1], puffs[o + 2], -nx * 9 + spread() * 1.5, -ny * 9 + spread() * 1.5, 1 + rand() * 1.5, 0.9 + rand() * 0.6, 0, 0.5);
      }
    }
  }
  const drag = Math.exp(-3 * dt);
  for (let o = 0; o < puffs.length; o += PUFF_F) {
    if (puffs[o + 6] <= 0) continue;
    puffs[o + 6] += dt;
    if (puffs[o + 6] > puffs[o + 7]) {
      puffs[o + 6] = 0;
      continue;
    }
    puffs[o] += puffs[o + 3] * dt;
    puffs[o + 1] += puffs[o + 4] * dt;
    puffs[o + 2] += puffs[o + 5] * dt;
    puffs[o + 3] *= drag;
    puffs[o + 4] *= drag;
    if (puffs[o + 8] === 3) puffs[o + 5] -= 30 * dt; // spray falls back
  }

  // ── the camera: behind the condor and a little above, swinging round after it in a turn
  // and trailing it for a moment when it slides sideways
  cam.S = (P.chaseWidth * BW) / (MW * P.modelScale);
  cam.q = 1 / (P.chaseDist * ML * P.modelScale);
  cam.k = Math.tan((P.chaseElev * Math.PI) / 180);
  cam.cy = BH * P.chaseY + spread() * G.shake * 6;
  cam.yaw += wrapAngle(lead.yaw - cam.yaw) * (1 - Math.exp(-P.chaseFollow * dt));
  const cx = Math.cos(cam.yaw);
  const cy = Math.sin(cam.yaw);
  const aside = ((lead.x - cam.x) * cx + (lead.y - cam.y) * cy) * Math.exp(-P.chaseSlide * dt);
  cam.x = lead.x - cx * aside;
  cam.y = lead.y - cy * aside;
  cam.zr = lead.z;
}

// ───────────────────────────────────────────────────────────── drawing
//
// A world point, seen from the camera, is `across` to the right, `depth` ahead and at some
// height. It lands on screen at
//   m = S / (1 + q·depth)      x = CXS + m·across      y = cy − m·(height − zr + k·depth)
// The camera sits 1/q behind the point it follows and k/q above it, looking level: far things
// shrink, and the horizon is the row cy − S·k/q.

let FB; // the pixel buffer
const ZB = new Float32Array(BW * BH); // depth of what each pixel shows
const PC = new Uint32Array(BW * BH); // a see-through cloud waiting over a pixel: its colour …
const PA = new Uint8Array(BW * BH); // … and how much of it shows
const YB = new Int16Array(BW); // per column: the ground has filled everything from here down
const STAMP = new Uint32Array(BW * BH); // which flyer drew a pixel last (for outlines)
let stampId = 0;
const SJ = new Float32Array(16 * 6); // shadow casters this frame
let nSJ = 0;
let invMs = 1;
let fwdX = 0;
let fwdY = -1;
let rgtX = 1;
let rgtY = 0;

// Is this ground point (relative to the camera, at height h) in a flyer's shadow?
function shadowed(relX, relY, h) {
  for (let j = 0; j < nSJ; j++) {
    const o = j * 6;
    const dz = SJ[o + 2] - h;
    if (dz <= 0) continue;
    const dx = relX - SJ[o] - SUN_X * dz;
    const dy = relY - SJ[o + 1] - SUN_Y * dz;
    if (dx > 7 || dx < -7 || dy > 7 || dy < -7) continue;
    const cy = SJ[o + 3];
    const sy = SJ[o + 4];
    const i = Math.floor((dx * cy + dy * sy) * SJ[o + 5] + MCX + 0.5);
    const jj = Math.floor(MPJ - (dx * sy - dy * cy) * invMs + 0.5);
    if (i >= 0 && i < MW && jj >= 0 && jj < ML && MASK[jj * MW + i]) return 1;
  }
  return 0;
}

// The ground and the clouds, from the nearest row of cells to the farthest. A pixel that is
// already taken stays taken, so nearer things always win. Close to the camera, where one cell
// covers several pixels, heights and tones are blended between cells, so slopes come out
// smooth instead of stepped.
function drawWorld() {
  const { S, q, k, zr, cy } = cam;
  ZB.fill(EMPTY);
  YB.fill(BH);
  PA.fill(0);

  const camX = cam.x + BIG;
  const camY = cam.y - Math.floor(cam.y / N) * N + 4 * N;
  const tick = (now * 15) | 0;
  const A = S * (k + q * Math.max(zr, 1)); // screen rows of sea per unit of depth, at the flyer
  const view = VIEW_DIST + zr * 4; // the eye reaches further from higher up, and the haze starts further out
  const fogStart = view * 0.27;
  const fogK = FOG_N / (view - fogStart);

  // start where the tallest thing sits on the bottom row; a camera down among the hills and
  // clouds starts right in front of itself instead
  let v = (cy - BH - S * (ZTOP - zr)) / (S * k + (BH - cy) * q);
  const near = (NEAR_W - 1) / q;
  if (v < near || zr + k / q < ZTOP + 2) v = near;

  let open = BW;
  while (v < view && open > 0) {
    const w = 1 + q * v;
    const m = S / w;
    const inv = w / S;
    let dv = (w * w) / A;
    if (dv < DV_MIN * inv) dv = DV_MIN * inv;
    else if (dv > DV_MAX * inv) dv = DV_MAX * inv;
    const v2 = v + dv;
    const m2 = S / (1 + q * v2);
    const b1 = cy - m * (k * v - zr); // row of height 0 at the near edge of this step …
    const b2 = cy - m2 * (k * v2 - zr); // … and at its far edge
    let fog = v <= fogStart ? 0 : ((v - fogStart) * fogK) | 0;
    if (fog > FOG_N) fog = FOG_N;
    const po = fog * NR; // this step's cloud colours …
    const pg = fog * NG * NL; // … and ground colours
    const blend = m > BLEND_M; // cells are magnified here
    const cloudRow = Math.min(b1 - m * (CA + CK), b2 - m2 * (CA + CK)); // the highest a cloud can show

    let relX = fwdX * v - rgtX * CXS * inv;
    let relY = fwdY * v - rgtY * CXS * inv;
    const stepX = rgtX * inv;
    const stepY = rgtY * inv;

    for (let x = 0; x < BW; x++, relX += stepX, relY += stepY) {
      const yb = YB[x];
      if (yb <= 0) continue;
      const wx = relX + camX;
      const wy = relY + camY;
      let ix = (wx | 0) - BIG; // the map does not wrap east–west: its edges go on for ever
      ix = ix < 0 ? 0 : ix > NM ? NM : ix;
      const iy = (wy | 0) & NM;
      // nothing here can reach above what is already drawn: skip it
      if (cloudRow >= yb && b1 - m * HM[((iy >> 4) << (NS - 4)) | (ix >> 4)] * 0.5 >= yb + 0.5) continue;
      const i = (iy << NS) | ix;

      let h; // ground height here
      let g; // its place on the ground gradient
      let lit; // and its light
      let th; // cloud thickness above, in sixteenths
      let ct; // and the tone of its top
      if (blend) {
        let gx = wx - 0.5;
        let gy = wy - 0.5;
        let x0 = gx | 0;
        let y0 = gy | 0;
        let tx = gx - x0;
        let ty = gy - y0;
        let xa = x0 - BIG;
        let xb = xa + 1;
        xa = xa < 0 ? 0 : xa > NM ? NM : xa;
        xb = xb < 0 ? 0 : xb > NM ? NM : xb;
        let ra = (y0 & NM) << NS;
        let rb = ((y0 + 1) & NM) << NS;
        let p = H[ra | xa];
        let r = H[rb | xa];
        p += (H[ra | xb] - p) * tx;
        r += (H[rb | xb] - r) * tx;
        h = (p + (r - p) * ty) * 0.5;
        p = GR[ra | xa];
        r = GR[rb | xa];
        p += (GR[ra | xb] - p) * tx;
        r += (GR[rb | xb] - r) * tx;
        g = (p + (r - p) * ty + 0.5) | 0;
        p = LIT[ra | xa];
        r = LIT[rb | xa];
        p += (LIT[ra | xb] - p) * tx;
        r += (LIT[rb | xb] - r) * tx;
        lit = p + (r - p) * ty + GRAIN[(((wy * 2.5) & 63) << 6) | ((wx * 2.5) & 63)];

        gx += windX;
        gy += windY;
        x0 = gx | 0;
        y0 = gy | 0;
        tx = gx - x0;
        ty = gy - y0;
        xa = x0 & NM;
        xb = (x0 + 1) & NM;
        ra = (y0 & NM) << NS;
        rb = ((y0 + 1) & NM) << NS;
        p = CT[ra | xa];
        r = CT[rb | xa];
        p += (CT[ra | xb] - p) * tx;
        r += (CT[rb | xb] - r) * tx;
        th = p + (r - p) * ty;
        ct = CTONE[ra | xa];
      } else {
        h = H[i] * 0.5;
        g = GR[i];
        lit = LIT[i];
        const ci = ((((wy + windY) | 0) & NM) << NS) | (((wx + windX) | 0) & NM);
        th = CT[ci];
        ct = CTONE[ci];
      }

      // clouds: a sheet that swells up from CA and sags a little below it; where it is thin it
      // is see-through, held back until whatever lies behind it is drawn
      if (th > 1) {
        const t = th * 0.0625;
        const zt = CA + t;
        const zb = CA - t * 0.15;
        if (h < zt) {
          let y1 = b1 - m * zt;
          y1 = y1 < 0 ? 0 : y1 > BH ? BH : (y1 + 0.5) | 0;
          let y2 = b2 - m2 * zt;
          y2 = y2 < 0 ? 0 : y2 > BH ? BH : (y2 + 0.5) | 0;
          let c0 = b1 - m * zb;
          c0 = c0 < 0 ? 0 : c0 > BH ? BH : (c0 + 0.5) | 0;
          let c3 = b2 - m2 * zb;
          c3 = c3 < 0 ? 0 : c3 > BH ? BH : (c3 + 0.5) | 0;
          let ys = y2 < y1 ? y2 : y1;
          let ye = c3 > c0 ? c3 : c0;
          if (ye > yb) ye = yb;
          if (ys < ye) {
            const alpha = t < CLOUD_SOFT ? ((t / CLOUD_SOFT) * 255) | 0 : 255;
            const top = po + ct - (nSJ && shadowed(relX, relY, zt) ? SHADOW : 0);
            const drop = c0 > y1 ? (ct - CLOUD_LOW) / (c0 - y1) : 0; // its side darkens towards the foot
            for (let p = ys * BW + x; ys < ye; ys++, p += BW) {
              if (ZB[p] < TAKEN) continue;
              const c = PAL[ys < y1 ? top : ys < c0 ? top - (((ys - y1) * drop) | 0) : po + CLOUD_UNDER];
              const held = PA[p];
              if (alpha > 250) {
                FB[p] = held ? mix(c, PC[p], held) : c;
                ZB[p] = v;
              } else if (!held) {
                PC[p] = c;
                PA[p] = alpha;
              } else {
                // more cloud behind the cloud already waiting here: it shows through the rest
                const add = (alpha * (255 - held)) >> 8;
                const sum = held + add;
                PC[p] = mix(PC[p], c, ((add * 255) / sum) | 0);
                if (sum > 244) {
                  FB[p] = PC[p]; // enough of it to hide whatever is behind
                  ZB[p] = v;
                  PA[p] = 0;
                } else PA[p] = sum;
              }
            }
          }
        }
      }

      // ground: everything from this point's row down to where the nearer ground ended
      let ya = b1 - m * h;
      ya = ya < 0 ? 0 : (ya + 0.5) | 0;
      if (ya >= yb) continue;

      if (g < G_SHALLOW * GS && ix && ((R8[i] + tick) & 255) < 1) lit += 9; // a glint on the water
      // shadows: soft under the clouds, hard under the flyers
      const dz = CA - h;
      let dark = CT[((((wy - SUN_Y * dz + windY) | 0) & NM) << NS) | (((wx - SUN_X * dz + windX) | 0) & NM)] * 0.2;
      if (dark > LIT_SHADOW || (nSJ && shadowed(relX, relY, h))) dark = LIT_SHADOW;
      lit = (lit - dark) | 0;
      const c = GPAL[pg + g * NL + (lit < 0 ? 0 : lit)];
      for (let y = ya, p = ya * BW + x; y < yb; y++, p += BW) {
        if (ZB[p] > TAKEN) {
          FB[p] = PA[p] ? mix(c, PC[p], PA[p]) : c;
          ZB[p] = v;
        }
      }
      YB[x] = ya;
      if (ya <= 0) open--;
    }
    v = v2;
  }
}

// Whatever the ground left empty: sky above the horizon, haze below it.
function drawSky() {
  const { S, q, k } = cam;
  const hy = cam.cy - (S * k) / q;
  const hyi = Math.round(hy);

  // the sun, over the horizon opposite the shadows
  let sunX = -1e6;
  let sunY = 0;
  const d = wrapAngle(SUN_AZ - cam.yaw);
  if (Math.abs(d) < 1.3) {
    sunX = CXS + (S / q) * Math.tan(d);
    sunY = hy - ((S / q) * Math.tan(SUN_ELEV)) / Math.cos(d);
  }
  const disc = 49 * RS * RS;
  const glow = 1600 * RS * RS;
  // up in the stratosphere the sky deepens towards black and the stars come out
  const high = smooth(STRATO, SPACE, cam.zr);
  const tr = SKY_TOP[0] + (4 - SKY_TOP[0]) * high;
  const tg = SKY_TOP[1] + (8 - SKY_TOP[1]) * high;
  const tb = SKY_TOP[2] + (26 - SKY_TOP[2]) * high;
  const pan = Math.round((cam.yaw * S) / q);
  const stars = (high * 255) | 0;

  for (let y = 0, p = 0; y < BH; y++) {
    const below = y >= hyi;
    const t = clamp((hy - y) / ((130 - 70 * high) * RS), 0, 1);
    const row = below ? colHaze : pack((SKY_LOW[0] + (tr - SKY_LOW[0]) * t) | 0, (SKY_LOW[1] + (tg - SKY_LOW[1]) * t) | 0, (SKY_LOW[2] + (tb - SKY_LOW[2]) * t) | 0);
    const dy = y - sunY;
    for (let x = 0; x < BW; x++, p++) {
      if (ZB[p] < TAKEN) continue;
      let c = row;
      if (!below) {
        const dx = x - sunX;
        const dd = dx * dx + dy * dy;
        if (dd < disc) c = colSun;
        else if (dd < glow) {
          const fall = 1 - Math.sqrt((dd - disc) / (glow - disc));
          c = mix(row, colSun, (fall * fall * 200) | 0);
        } else if (stars > 40 && t > 0.3 && hash2(x + pan, y - hyi, 7) % 173 === 0) c = mix(c, colSun, stars);
      }
      FB[p] = PA[p] ? mix(c, PC[p], PA[p]) : c;
    }
  }
}

// World point → screen. Returns false when it is behind the camera.
let prX = 0;
let prY = 0;
let prV = 0;
let prM = 0;
function project(x, y, z) {
  const dx = x - cam.x;
  const dy = y - cam.y;
  const v = dx * fwdX + dy * fwdY;
  const w = 1 + cam.q * v;
  if (w < 0.12) return false;
  prM = cam.S / w;
  prV = v;
  prX = CXS + prM * (dx * rgtX + dy * rgtY);
  prY = cam.cy - prM * (z - cam.zr + cam.k * v);
  return true;
}

// Wingtip trails: a line through the points each tip has passed, thinning out with age.
function drawTrails(f) {
  for (let s = 0; s < 2; s++) {
    const t = f.trail[s];
    let ox = 0;
    let oy = 0;
    let ov = 0;
    let had = false;
    // n = 0 is the wingtip itself; then back through the stored points
    for (let n = f.trailLen; n >= 0; n--) {
      let ok;
      if (n === 0) ok = project(f.tip[s * 3], f.tip[s * 3 + 1], f.tip[s * 3 + 2]);
      else {
        const o = ((f.trailHead - (n - 1) + TRAIL_N * 2) % TRAIL_N) * 3;
        ok = project(t[o], t[o + 1], t[o + 2]);
      }
      if (ok && had) {
        const age = n / TRAIL_N;
        const keep = ((1 - age) * (1 - age) * 255) | 0;
        const thick = prM > 1.7 * RS && age < 0.5 ? 2 : 1;
        const len = Math.max(Math.abs(prX - ox), Math.abs(prY - oy)) | 0;
        if (len < 300) {
          const steps = len + 1;
          for (let i = 0; i <= steps; i++) {
            const u = i / steps;
            const x = Math.floor(ox + (prX - ox) * u);
            const y = Math.floor(oy + (prY - oy) * u);
            const dep = ov + (prV - ov) * u;
            if (y < 0 || y >= BH) continue;
            for (let j = 0; j < thick; j++) {
              const xx = x + j;
              if (xx < 0 || xx >= BW) continue;
              const p = y * BW + xx;
              if (ZB[p] > dep) FB[p] = mix(FB[p], colTrail, keep);
            }
          }
        }
      }
      had = ok;
      ox = prX;
      oy = prY;
      ov = prV;
    }
  }
}

// One flyer. Every visible voxel is placed with the flyer's own axes and drawn as a small
// square, nearest wins. Each is lit as part of a solid: by the sun, from the way its surface
// faces; darker in the creases and wherever another part of the flyer stands in its light;
// with a glint where the sun bounces towards the camera. Then a dark outline, so it reads
// over any ground, and the flames.
const LV = new Float32Array(4096); // the sun on each direction a surface can face …
const SP = new Float32Array(4096); // … and the glint there
const STEP = new Float32Array(9);
let fx0 = 0;
let fy0 = 0;
let fv0 = 0;
let fHalf = 0.5;
let bx0 = 0;
let bx1 = 0;
let by0 = 0;
let by1 = 0;

function plotVoxel(ma, mb, mc, colour, mark) {
  const sx = fx0 + ma * STEP[0] + mb * STEP[3] + mc * STEP[6];
  const sy = fy0 + ma * STEP[1] + mb * STEP[4] + mc * STEP[7];
  const dep = fv0 + ma * STEP[2] + mb * STEP[5] + mc * STEP[8];
  let xa = Math.round(sx - fHalf);
  let xb = Math.round(sx + fHalf);
  let ya = Math.round(sy - fHalf);
  let yb = Math.round(sy + fHalf);
  if (xb <= xa) xb = xa + 1;
  if (yb <= ya) yb = ya + 1;
  if (xa < 0) xa = 0;
  if (ya < 0) ya = 0;
  if (xb > BW) xb = BW;
  if (yb > BH) yb = BH;
  if (xa >= xb || ya >= yb) return;
  for (let y = ya; y < yb; y++) {
    for (let x = xa, p = y * BW + xa; x < xb; x++, p++) {
      if (ZB[p] <= dep) continue;
      ZB[p] = dep;
      FB[p] = colour;
      if (mark) STAMP[p] = mark;
    }
  }
  if (mark) {
    if (xa < bx0) bx0 = xa;
    if (xb > bx1) bx1 = xb;
    if (ya < by0) by0 = ya;
    if (yb > by1) by1 = yb;
  }
}

// Which of a flyer's voxels have another part of it between them and the sun. The light's
// direction is given in the flyer's own axes: across, towards the nose, up.
function castShadows(f, lx, ly, lz) {
  const { n, gi, gj, gk, ni } = model;
  for (let v = 0; v < n; v++) {
    const o = ni[v] * 3;
    // start just off the surface, then walk towards the sun
    let x = gi[v] + 0.5 + NQ[o] * 1.6 + lx;
    let y = gj[v] + 0.5 - NQ[o + 1] * 1.6 - ly;
    let z = gk[v] + 0.5 + NQ[o + 2] * 1.6 + lz;
    let hit = 0;
    for (let s = 0; s < 60; s++, x += lx, y -= ly, z += lz) {
      if (x < 0 || y < 0 || z < 0 || x >= GW || y >= GL || z >= GH) break;
      if (GRID[((z | 0) * GL + (y | 0)) * GW + (x | 0)]) {
        hit = 1;
        break;
      }
    }
    f.shade[v] = hit;
  }
  f.sunX = lx;
  f.sunY = ly;
  f.sunZ = lz;
}

function drawFlyer(f) {
  if (!project(f.x, f.y, f.z)) return;
  const s = prM * P.modelScale;
  const reach = s * 34;
  if (prX < -reach || prX > BW + reach || prY < -reach || prY > BH + reach) return;
  fx0 = prX;
  fy0 = prY;
  fv0 = prV;
  fHalf = Math.max(0.5, (s * 0.71) / MK);

  // each model axis as a step on screen (x, y) and in depth
  const a = f.ax;
  for (let i = 0; i < 9; i += 3) {
    const dep = a[i] * fwdX + a[i + 1] * fwdY;
    STEP[i] = s * (a[i] * rgtX + a[i + 1] * rgtY);
    STEP[i + 1] = -s * (a[i + 2] + cam.k * dep);
    STEP[i + 2] = P.modelScale * dep;
  }

  // the sun, and the direction half-way between the sun and the camera, in the flyer's own
  // axes; shadows are cast again only when the sun has moved across it
  const lx = a[0] * LIGHT[0] + a[1] * LIGHT[1] + a[2] * LIGHT[2];
  const ly = a[3] * LIGHT[0] + a[4] * LIGHT[1] + a[5] * LIGHT[2];
  const lz = a[6] * LIGHT[0] + a[7] * LIGHT[1] + a[8] * LIGHT[2];
  if (!f.shade) {
    f.shade = new Uint8Array(model.n);
    f.sunZ = 9;
  }
  if (lx * f.sunX + ly * f.sunY + lz * f.sunZ < 0.9985) castShadows(f, lx, ly, lz);
  const eye = norm3(LIGHT[0] - fwdX, LIGHT[1] - fwdY, LIGHT[2] + cam.k + 0.6);
  const hx = a[0] * eye[0] + a[1] * eye[1] + a[2] * eye[2];
  const hy = a[3] * eye[0] + a[4] * eye[1] + a[5] * eye[2];
  const hz = a[6] * eye[0] + a[7] * eye[1] + a[8] * eye[2];
  const used = model.used;
  for (let i = 0; i < used.length; i++) {
    const q = used[i];
    const o = q * 3;
    const d = NQ[o] * lx + NQ[o + 1] * ly + NQ[o + 2] * lz;
    const h = NQ[o] * hx + NQ[o + 1] * hy + NQ[o + 2] * hz;
    LV[q] = d > 0 ? d : 0;
    SP[q] = h > 0 ? Math.pow(h, 20) : 0;
  }

  const id = ++stampId;
  bx0 = BW;
  bx1 = -1;
  by0 = BH;
  by1 = -1;
  const { n, a: ma, b: mb, c: mc, w: mw, col, ni, ao } = model;
  const shade = f.shade;
  const flex = f.flex;
  for (let i = 0; i < n; i++) {
    const q = ni[i];
    const m = col[i];
    let l = shade[i] ? (0.36 + 0.1 * LV[q]) * ao[i] * 15 : (0.36 + 0.64 * LV[q]) * ao[i] * 15 + SP[q] * GLINT[m];
    if (l > NLV - 1) l = NLV - 1;
    plotVoxel(ma[i], mb[i], mc[i] + mw[i] * flex, JPAL[m * NLV + (l | 0)], id);
  }

  // outline: any free pixel that touches the flyer
  const ox0 = Math.max(1, bx0 - 1);
  const oy0 = Math.max(1, by0 - 1);
  const ox1 = Math.min(BW - 1, bx1 + 1);
  const oy1 = Math.min(BH - 1, by1 + 1);
  for (let y = oy0; y < oy1; y++) {
    for (let x = ox0, p = y * BW + ox0; x < ox1; x++, p++) {
      if (STAMP[p] === id || ZB[p] < fv0 - 20) continue;
      if (STAMP[p - 1] === id || STAMP[p + 1] === id || STAMP[p - BW] === id || STAMP[p + BW] === id) {
        FB[p] = colOutline;
        if (ZB[p] > fv0) ZB[p] = fv0;
      }
    }
  }

  // thruster flames: a flickering cone of hot voxels behind each nozzle
  fHalf = Math.max(0.5, s * 0.71);
  const tick = (now * 30) | 0;
  const len = 2 + f.thr * 11 + Math.sin(now * 47 + f.x) * 0.8;
  for (const nz of NOZZLES) {
    for (let t = 0; t < len; t += 0.8) {
      const along = t / len;
      const r = 1.7 * (1 - along * 0.85);
      for (let da = -2; da <= 2; da++) {
        for (let dc = -2; dc <= 2; dc++) {
          const dd = (da * da + dc * dc) / (r * r);
          if (dd > 1) continue;
          const heat = along * 2.6 + dd * 1.2 + (hash2(da + ((t * 5) | 0), dc, tick) & 3) * 0.2;
          plotVoxel(nz[0] + da, nz[1] - t, nz[2] + dc, FLAME[heat > 3 ? 3 : heat | 0], 0);
        }
      }
    }
  }
}

// Everything soft and round that drifts: exhaust, flames, flashes, spray, dust, black smoke.
const PUFF_COL = [colSmoke, 0, pack(255, 255, 255), pack(110, 180, 230), pack(150, 125, 95), pack(40, 44, 54)];
const FLAMES = [pack(255, 232, 120), pack(255, 150, 44), pack(214, 60, 30)];
const PUFF_DENSE = [150, 235, 255, 200, 150, 190];
function drawPuffs() {
  for (let o = 0; o < puffs.length; o += PUFF_F) {
    const age = puffs[o + 6];
    if (age <= 0 || !project(puffs[o], puffs[o + 1], puffs[o + 2])) continue;
    const life = age / puffs[o + 7];
    const kind = puffs[o + 8];
    const r = puffs[o + 9] * (0.5 + life * 1.5) * prM;
    const colour = kind === 1 ? FLAMES[(life * 3) | 0] : PUFF_COL[kind];
    const dens = (1 - life) * PUFF_DENSE[kind];
    const x0 = Math.max(0, Math.floor(prX - r));
    const x1 = Math.min(BW - 1, Math.ceil(prX + r));
    const y0 = Math.max(0, Math.floor(prY - r));
    const y1 = Math.min(BH - 1, Math.ceil(prY + r));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const dd = ((x - prX) * (x - prX) + (y - prY) * (y - prY)) / (r * r);
        if (dd > 1) continue;
        const p = y * BW + x;
        if (ZB[p] > prV) FB[p] = mix(FB[p], colour, (dens * (1 - dd)) | 0);
      }
    }
  }
}

// A ball, lit by the sun like everything else (or glowing by itself).
let sunR = 0; // the sun as the screen sees it: to the right, up, towards the camera
let sunU = 0;
let sunC = 0;
function ball(x, y, z, r, mat, glow) {
  if (!project(x, y, z)) return;
  const R = r * prM;
  if (R < 0.4 || prX < -R || prX > BW + R || prY < -R || prY > BH + R) return;
  const x0 = Math.max(0, Math.floor(prX - R));
  const x1 = Math.min(BW - 1, Math.ceil(prX + R));
  const y0 = Math.max(0, Math.floor(prY - R));
  const y1 = Math.min(BH - 1, Math.ceil(prY + R));
  const o = mat * NLV;
  for (let py = y0; py <= y1; py++) {
    for (let px = x0; px <= x1; px++) {
      const dx = (px + 0.5 - prX) / R;
      const dy = (py + 0.5 - prY) / R;
      const dd = dx * dx + dy * dy;
      if (dd > 1) continue;
      const nz = Math.sqrt(1 - dd);
      const dep = prV - nz * r;
      const p = py * BW + px;
      if (ZB[p] <= dep) continue;
      ZB[p] = dep;
      const l = dx * sunR - dy * sunU + nz * sunC;
      FB[p] = JPAL[o + (glow ? NLIT - 1 : ((0.36 + 0.64 * (l > 0 ? l : 0)) * 15) | 0)];
    }
  }
}

// A straight bar between two points in the world, `w` wide, solid or see-through.
function beam(x1, y1, z1, x2, y2, z2, w, colour, alpha) {
  if (!project(x1, y1, z1)) return;
  const ax = prX;
  const ay = prY;
  const av = prV;
  const am = prM;
  if (!project(x2, y2, z2)) return;
  const th = Math.max(1, Math.round(w * (am + prM) * 0.5));
  const len = Math.max(Math.abs(prX - ax), Math.abs(prY - ay));
  if (len > 1200) return;
  const n = Math.ceil(len / (alpha > 250 ? 1 : th)) + 1; // see-through bars are laid end to end, never doubled up
  for (let i = 0; i <= n; i++) {
    const u = i / n;
    const bx = Math.round(ax + (prX - ax) * u - th / 2);
    const by = Math.round(ay + (prY - ay) * u - th / 2);
    const dep = av + (prV - av) * u;
    for (let y = by < 0 ? 0 : by; y < by + th && y < BH; y++) {
      for (let x = bx < 0 ? 0 : bx; x < bx + th && x < BW; x++) {
        const p = y * BW + x;
        if (ZB[p] > dep) FB[p] = alpha > 250 ? colour : mix(FB[p], colour, alpha);
      }
    }
  }
}

// An upright block — a building — seen face on: lit on the sun's side, shaded on the other,
// with a dark line for its roof.
const WALLS = [
  [pack(238, 236, 228), pack(158, 166, 186)],
  [pack(216, 206, 184), pack(140, 138, 146)],
  [pack(176, 196, 216), pack(104, 124, 152)],
];
const colRoof = pack(74, 86, 110);
function slab(x, y, z, h, w, tone) {
  if (!project(x, y, z)) return;
  const hw = Math.max(0.6, w * prM);
  const x0 = Math.max(0, Math.round(prX - hw));
  const x1 = Math.min(BW, Math.round(prX + hw));
  const y0 = Math.max(0, Math.round(prY - h * prM));
  const y1 = Math.min(BH, Math.round(prY));
  const edge = prX + (sunR < 0 ? 0.25 : -0.25) * hw; // where the lit side meets the shaded one
  for (let py = y0; py < y1; py++) {
    for (let px = x0, p = py * BW + x0; px < x1; px++, p++) {
      if (ZB[p] <= prV) continue;
      ZB[p] = prV;
      FB[p] = py === y0 ? colRoof : WALLS[tone][px < edge === sunR < 0 ? 0 : 1];
    }
  }
}

const colSteel = pack(72, 86, 108);
const colCable = pack(44, 54, 72);
const colRed = pack(255, 40, 70);
const colShot = pack(200, 235, 255);
const colFire = pack(255, 160, 60);

// The cast: drones, the satellite, fires, people, the mudslide, laser fences, shots.
function drawThings() {
  for (const d of drones) {
    // a body with one eye that watches the condor, between two rotor pods; hackers are dark,
    // with a red eye and an aerial, and a beam on the condor while they break in
    const dx = lead.x - d.x;
    const dy = lead.y - d.y;
    const dz = lead.z - d.z;
    const l = (d.r * 0.8) / Math.hypot(dx, dy, dz);
    ball(d.x, d.y, d.z, d.r, d.k ? ENGINE : HEAD);
    ball(d.x + dx * l, d.y + dy * l, d.z + dz * l, d.r * 0.45, d.k ? GLOW : PLUME, d.k);
    const bob = Math.sin(now * 14 + d.s) * 0.3;
    ball(d.x + rgtX * d.r * 1.5, d.y + rgtY * d.r * 1.5, d.z + bob, d.r * 0.5, NAVY);
    ball(d.x - rgtX * d.r * 1.5, d.y - rgtY * d.r * 1.5, d.z - bob, d.r * 0.5, NAVY);
    if (d.k) {
      beam(d.x, d.y, d.z + d.r, d.x, d.y, d.z + d.r + 2.5, 0.3, colRed, 255);
      if (d.ch > 0) beam(d.x, d.y, d.z, lead.x, lead.y, lead.z, 0.5, colRed, 90 + ((d.ch * 120 + Math.sin(now * 40) * 40) | 0));
    }
  }
  if (sat) {
    ball(sat.x, sat.y, sat.z, sat.r, PLUME);
    ball(sat.x, sat.y, sat.z - sat.r * 0.8, sat.r * 0.5, GLOW, 1);
    beam(sat.x - rgtX * 14, sat.y - rgtY * 14, sat.z, sat.x + rgtX * 14, sat.y + rgtY * 14, sat.z, 2.6, JPAL[GLASS * NLV + 9], 255);
  }
  for (const f of fires) ball(f.x, f.y, f.z + 0.6, 1.3 + Math.sin(now * 17 + f.x) * 0.3, FIRE, 1);
  for (const f of folk) {
    // a light on the ground and a tall beacon above it
    ball(f.x, f.y, f.z + 0.6, 0.7, PLUME, 1);
    beam(f.x, f.y, f.z + 1, f.x, f.y, f.z + 26, 0.5, colTrail, 110 + ((Math.sin(now * 6) * 60) | 0));
  }
  if (em && em.k) {
    for (let i = 0; i < 6; i++) {
      const a = now * 2 + i * 1.05;
      ball(em.x + Math.cos(a * 1.3) * 3, em.y + Math.sin(a) * 3, em.z + 0.8 + Math.abs(Math.sin(a * 2)) * 1.2, 1.4 + (i & 1) * 0.6, MUD);
    }
  }
  // a tall light over wherever help is needed
  const goal = folk[0] || fires[0];
  if (goal) beam(goal.x, goal.y, goal.z + 30, goal.x, goal.y, goal.z + 150, 1.2, folk[0] ? colTrail : colFire, 80);

  for (const f of fences) {
    const px = -f.ny * f.w; // from the middle of the fence to a pylon
    const py = f.nx * f.w;
    for (let s = -1; s <= 1; s += 2) {
      const x = f.x + px * s;
      const y = f.y + py * s;
      beam(x, y, groundAt(x, y), x, y, f.z1 + 2, 0.7, colOutline, 255);
      ball(x, y, f.z1 + 2.5, 0.9, GLOW, 1);
    }
    for (let i = 0; i < 4; i++) {
      const z = f.z0 + ((f.z1 - f.z0) * i) / 3;
      beam(f.x - px, f.y - py, z, f.x + px, f.y + py, z, 0.3, colRed, 150 + ((Math.sin(now * 30 + i) * 80) | 0));
    }
  }
  // towns close enough to make out
  for (const t of TOWNS) {
    const ty = t.y + Math.round((lead.y - t.y) / N) * N - t.y; // shift to its nearest self, north or south
    if (Math.abs(lead.x - t.x) + Math.abs(lead.y - t.y - ty) > 320) continue;
    for (let o = 0; o < t.b.length; o += 6) slab(t.b[o], t.b[o + 1] + ty, t.b[o + 2], t.b[o + 3], t.b[o + 4], t.b[o + 5]);
  }
  // the power line: each pylon is two legs and a crossarm, with a cable from each end of the
  // arm sagging to the next pylon
  const j0 = Math.floor(lead.y / PYLON);
  for (let j = j0 - 7; j <= j0 + 7; j++) {
    const y = j * PYLON + 16;
    const x = lineX(y);
    const top = pylonTop(j);
    const x2 = lineX(y + PYLON);
    const top2 = pylonTop(j + 1);
    beam(x - 1.3, y, top - PYLON_H, x, y, top, 0.3, colSteel, 255);
    beam(x + 1.3, y, top - PYLON_H, x, y, top, 0.3, colSteel, 255);
    beam(x - 2.6, y, top - ARM, x + 2.6, y, top - ARM, 0.3, colSteel, 255);
    for (let side = -2.6; side < 3; side += 5.2) {
      const mx = (x + x2) / 2 + side;
      const mz = (top + top2) / 2 - ARM - SAG;
      beam(x + side, y, top - ARM, mx, y + PYLON / 2, mz, 0.1, colCable, 255);
      beam(mx, y + PYLON / 2, mz, x2 + side, y + PYLON, top2 - ARM, 0.1, colCable, 255);
    }
  }
  for (const s of shots) {
    if (!s.k) beam(s.x, s.y, s.z, s.x - s.vx * 0.025, s.y - s.vy * 0.025, s.z - s.vz * 0.025, 0.35, colShot, 255);
    else ball(s.x, s.y, s.z, s.k === 2 ? 1 : s.r, s.k === 2 ? GLASS : GLOW, s.k === 1);
  }
}

// The gunsight: four corners round whatever the guns are tracking, or dead ahead.
function drawSight() {
  const t = G.lock;
  const ok = t ? project(t.x, t.y, t.z) : project(lead.x + lead.ax[3] * 60, lead.y + lead.ax[4] * 60, lead.z + lead.ax[5] * 60);
  if (!ok) return;
  const r = t ? Math.max(5, t.r * prM + 3) | 0 : 4;
  const c = t ? colRed : colTrail;
  const x = prX | 0;
  const y = prY | 0;
  for (let i = 0; i < 3; i++) {
    for (let s = 0; s < 4; s++) {
      const sx = s & 1 ? 1 : -1;
      const sy = s & 2 ? 1 : -1;
      for (let n = 0; n < 2; n++) {
        const px = x + sx * (r - (n ? i : 0));
        const py = y + sy * (r - (n ? 0 : i));
        if (px >= 0 && px < BW && py >= 0 && py < BH) FB[py * BW + px] = c;
      }
    }
  }
}

// A hacked picture: rows torn sideways, bars of red.
function glitch(amount) {
  for (let n = 0; n < amount * 14; n++) {
    const y = (rand() * BH) | 0;
    const shift = ((spread() * 24 * amount) | 0) || 1;
    const row = y * BW;
    if (shift > 0) FB.copyWithin(row + shift, row, row + BW - shift);
    else FB.copyWithin(row, row - shift, row + BW);
    if (rand() < 0.3) for (let x = 0; x < BW; x++) FB[row + x] = mix(FB[row + x], colRed, 120);
  }
}

function drawFrame() {
  fwdX = Math.sin(cam.yaw);
  fwdY = -Math.cos(cam.yaw);
  rgtX = -fwdY;
  rgtY = fwdX;
  invMs = 1 / P.modelScale;
  sunR = LIGHT[0] * rgtX + LIGHT[1] * rgtY;
  sunU = LIGHT[2];
  sunC = -(LIGHT[0] * fwdX + LIGHT[1] * fwdY);
  const alive = G.mode !== OVER;

  nSJ = 0;
  if (alive) {
    SJ[0] = lead.x - cam.x;
    SJ[1] = lead.y - cam.y;
    SJ[2] = lead.z;
    SJ[3] = Math.cos(lead.yaw);
    SJ[4] = Math.sin(lead.yaw);
    SJ[5] = invMs / Math.max(0.22, Math.abs(Math.cos(lead.bank + lead.roll)));
    nSJ = 1;
  }

  drawWorld();
  drawSky();
  if (alive && (G.inv <= 0 || (now * 12) & 1)) drawFlyer(lead); // it blinks while it is safe from harm
  drawThings();
  if (alive) drawTrails(lead);
  drawPuffs();
  if (G.mode === PLAY && !G.hacked) drawSight();
  if (G.hacked || G.chan > 0.4) glitch(G.hacked ? 1 : G.chan * 0.5);
  if (G.flash > 0.02) {
    const a = (G.flash * 200) | 0;
    for (let p = 0; p < FB.length; p++) FB[p] = mix(FB[p], colTrail, a);
  }
}


// ───────────────────────────────────────────────────────────── Phaser

const config = {
  type: Phaser.AUTO,
  width: GAME_WIDTH,
  height: GAME_HEIGHT,
  parent: 'game-root',
  backgroundColor: '#000000',
  pixelArt: true,
  scale: {
    mode: Phaser.Scale.FIT,
    autoCenter: Phaser.Scale.CENTER_BOTH,
    width: GAME_WIDTH,
    height: GAME_HEIGHT,
  },
  scene: { create, update },
};

new Phaser.Game(config);

let frameTex;
let frameData;
let gfx;
let tScore;
let tMsg;
let tInfo;
let tBig;
let tHud;
let drawMs = 0;

function create() {
  frameTex = this.textures.createCanvas('frame', BW, BH);
  frameData = frameTex.context.createImageData(BW, BH);
  FB = new Uint32Array(frameData.data.buffer);
  this.add.image(0, 0, 'frame').setOrigin(0).setScale(PX);

  const text = (x, y, size, ox) =>
    this.add
      .text(x, y, '', { fontFamily: 'monospace', fontSize: size + 'px', fontStyle: 'bold', color: '#ffffff', align: 'center', stroke: '#2a4560', strokeThickness: 4 })
      .setOrigin(ox, 0);
  gfx = this.add.graphics();
  tScore = text(10, 8, 20, 0);
  tMsg = text(GAME_WIDTH / 2, 120, 22, 0.5);
  tInfo = text(GAME_WIDTH / 2, GAME_HEIGHT - 34, 15, 0.5);
  tBig = text(GAME_WIDTH / 2, 150, 54, 0.5);
  tHud = text(GAME_WIDTH - 180, 9, 12, 1).setText('ESCUDO\nAGUA').setAlign('right').setLineSpacing(4);

  AC = this.sound.context || null;
  buildPalettes();
  buildModel();
  buildWorld(P.seed);
  resetFlight();
}

function update(time, delta) {
  if (G.mode !== PLAY && G.t > 1 && (pressed.START1 || pressed.P1_1)) startGame();

  simulate(Math.min(delta / 1000, 0.05));
  const t0 = performance.now();
  drawFrame();
  drawMs += (performance.now() - t0 - drawMs) * 0.1;
  frameTex.context.putImageData(frameData, 0, 0);
  frameTex.refresh();

  // ── the panel
  const play = G.mode === PLAY;
  gfx.clear();
  tScore.setVisible(play);
  tHud.setVisible(play);
  tBig.setVisible(!play);
  tMsg.setText('');
  tInfo.setText('');
  if (!play) {
    tBig.setText(G.mode === OVER ? 'FIN DEL VUELO' : 'CÓNDOR 3000');
    tMsg.setY(240).setText(
      (G.mode === OVER ? `PUNTAJE ${G.score}\n` : '') + `RÉCORD ${G.best}\n\n` + ((now * 2) & 1 ? 'PRESIONA START' : ' '),
    );
    tInfo.setY(GAME_HEIGHT - 76).setText('PALANCA: VOLAR    B1 DISPARO    B2 / B3 TONEL    B4 IMPULSO    B5 SOLTAR AGUA\nVUELA BAJO PARA MULTIPLICAR · APAGA INCENDIOS · RESCATA GENTE · DERRIBA DRONES');
    return void clearPressed();
  }
  tScore.setText(String(G.score).padStart(6, '0') + (G.mult > 1 ? '  ×' + G.mult : ''));

  // shield, and the loads of water aboard
  gfx.lineStyle(2, 0xffffff, 1).strokeRect(GAME_WIDTH - 172, 12, 160, 14);
  gfx.fillStyle(G.shield < 30 ? 0xff2846 : 0xa8c8e0, 1).fillRect(GAME_WIDTH - 170, 14, 1.56 * G.shield, 10);
  for (let i = 0; i < 3; i++) {
    gfx.fillStyle(0x6eb4e6, i < G.water ? 1 : 0.25).fillRect(GAME_WIDTH - 172 + i * 20, 32, 14, 10);
  }

  tMsg.setY(120);
  if (G.hacked) {
    // the hack: a bar to fill by thrashing the stick and hammering the button
    tMsg.setText('¡HACKEADO!\nAGITA LA PALANCA Y MACHACA B1');
    gfx.lineStyle(2, 0xff2846, 1).strokeRect(250, 190, 300, 16);
    gfx.fillStyle(0xffffff, 1).fillRect(252, 192, 296 * Math.min(1, G.purge), 12);
  } else if (G.chan > 0) {
    tMsg.setText('HACKEO ENTRANTE: ¡TONEL O DISPARA!');
    gfx.fillStyle(0xff2846, 1).fillRect(250, 156, 300 * G.chan, 8);
  } else if (G.msgT > 0) tMsg.setText(G.msg);

  // where help is needed, or where the satellite is
  const goal = folk[0] || fires[0] || (lead.z > 120 ? sat : null);
  if (goal) {
    const dx = goal.x - lead.x;
    const dy = goal.y - lead.y;
    const side = wrapAngle(Math.atan2(dx, -dy) - lead.yaw);
    const name = folk[0] ? `ALUVIÓN · ${folk.length} POR RESCATAR` : fires[0] ? `INCENDIO · ${fires.length} FOCOS` : 'SATÉLITE HACKER';
    const far = `${name} · ${(Math.hypot(dx, dy) * 10) | 0} m`;
    tInfo.setY(GAME_HEIGHT - 34).setText(side < -0.35 ? '<<  ' + far : side > 0.35 ? far + '  >>' : far);
  } else if (sat) tInfo.setY(GAME_HEIGHT - 34).setText('SATÉLITE HACKER ARRIBA: SUBE A LA ESTRATÓSFERA');
  clearPressed();
}

function clearPressed() {
  for (const key in pressed) pressed[key] = false;
}
