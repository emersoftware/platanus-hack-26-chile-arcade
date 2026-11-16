// DARWIN 3000
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

// Everything from here on lives inside one function, so that none of its names are global and
// the minifier is free to shorten every one of them.
(() => {
// ───────────────────────────────────────────────────────────── tunables

// flight
const SPEED = 31; // world units per second
const BOOST = 1.8; // × speed while the thruster is held
const TURN_RATE = 1.25; // radians per second at full stick
const BANK_ANGLE = 52; // degrees of bank in a full turn
const CLIMB_RATE = 22; // world units per second at full stick
const INVERT_Y = false; // true: stick up dives (flight-stick style)
const CRUISE_ALT = 22;
const CEILING = 330; // the top of the stratosphere
const ROLL_TIME = 0.8; // seconds for a barrel roll
const ROLL_SLIDE = 11; // how far a barrel roll carries the condor sideways
// model: small against the land, so the valley is wide and the cordillera towers
const MODEL_SCALE = 0.2; // world units per design unit
// camera
const CHASE_Y = 0.6; // where the condor sits on screen, top to bottom
const CHASE_FOLLOW = 7; // how quickly the camera swings round behind the condor …
const CHASE_SLIDE = 5; // … and how quickly it catches up when the condor moves sideways
const CHASE_DIST = 2.6; // camera distance, in model lengths
const CHASE_ELEV = 12; // camera height above the condor, degrees
const CHASE_WIDTH = 0.27; // wingspan as a share of the screen
// world
const SEED = 3000;
const CLOUDS = 0.45;

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
const BODY = 1;
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
const NMAT = MATERIALS.length;
// The flyers' own colours, the same as their portraits': back, the line along its edge, trim,
// eyes, engines, the glow of the nozzles, the stripe down the side, and the belly.
// Darwin's frog has a leaf-green back edged in cream, a dark brown stripe, an orange-brown
// belly and golden eyes; the monito is brown with a tan edge, darker sides, a cream belly,
// pink ears and nose, and black eyes.
const ICE = [42, 69, 96, 42, 69, 96]; // a nozzle: navy round the white of the flame
const SKINS = [
  [
    [34, 84, 30, 118, 196, 72],
    [124, 118, 86, 236, 228, 180],
    [72, 38, 22, 160, 92, 50],
    [60, 40, 10, 232, 190, 84],
    [20, 12, 10, 84, 46, 32],
    ICE,
    [34, 18, 14, 84, 46, 32],
    [92, 52, 28, 206, 134, 72],
  ],
  [
    [72, 44, 28, 176, 122, 76],
    [104, 80, 56, 216, 176, 126],
    [128, 64, 84, 244, 150, 170],
    [4, 4, 8, 60, 60, 80],
    [14, 10, 10, 70, 50, 46],
    ICE,
    [50, 30, 20, 122, 78, 50],
    [126, 118, 108, 248, 240, 224],
  ],
];
const FIRE = 7;
const MUD = 8;
const SIDE = 7; // on a flyer these two are its stripe and its belly instead
const BELLY = 8;
const GLINT = [0, 4, 5, 6, 14, 3, 0, 0, 1]; // how strongly each catches a highlight
const NLIT = 16;
const NLV = 24;
const JPAL = new Uint32Array(3 * NMAT * NLV); // [the things' colours · the frog's · the monito's][material][light]
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
  for (let m = 0; m < 3 * NMAT; m++) {
    const skin = SKINS[((m / NMAT) | 0) - 1];
    const c = (skin && skin[(m % NMAT) - 1]) || MATERIALS[m % NMAT];
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
        if (e > bed) e = bed + (e - bed) * smooth(0.024, 0.14, cut);
        e = clamp(e + (SNOWFIELD - e) * edge, 0.5, HMAX) * smooth(-0.004, 0.03, u - COAST); // the land comes up out of the sea
        if (cut < 0.006 && rise > 0.4 && edge < 0.01 && r % 11 === 0) QUEB.push(i);

        // colour by height: green low down, then blue-grey rock and snow
        if (u - COAST < 0.012) g = G_SAND;
        else if (cut < 0.024 && edge < 0.01) g = G_SHALLOW - 2; // river
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
  const cover = clamp(CLOUDS * 0.36, 0, 0.9);
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

// The flyers are fighters in the likeness of two animals of the southern forests: Darwin's
// frog (player one) and the monito del monte (player two). Both share one airframe, sculpted
// in voxels — swept wings whose tips split like toes, twin fins and engines — and differ in the
// head: the frog has two bulging eyes and a long pointed snout; the monito a round head with
// big dark eyes, round ears and a pink nose, and a thick tail behind. The shape is described
// once, in design units (MW across the wings, ML nose to tail, MH tall), and cut into MK voxels
// per unit. Each voxel on the surface remembers which way it faces and how tucked-in it is,
// so it can be lit as a solid thing.
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

const MODELS = [];
const MASK = new Uint8Array(MW * ML); // a flyer from above, for its shadow on the ground
const NQ = new Float32Array(4096 * 3); // the directions a surface can face, 16 steps a side

function inEll(x, y, z, rx, ry, rz) {
  return (x / rx) ** 2 + (y / ry) ** 2 + (z / rz) ** 2 <= 1;
}

// What flyer `who` is made of at a point: x across from the centre line, y back from the
// nose, z up. 0 is empty air.
function partAt(x, y, z, who) {
  const d = Math.abs(x);
  if (who) {
    if (inEll(d - 1.6, y - 8.5, z - 6.4, 1.3, 1.7, 1.3)) return GLASS; // eyes
    if (inEll(d - 2.9, y - 13.5, z - 8.3, 1.5, 0.7, 1.6)) return HEAD; // ears
    if (inEll(x, y - 2.4, z - 5, 0.9, 1.4, 0.8)) return HEAD; // nose
    if (inEll(x, y - 8.5, z - 5.2, 3.2, 6.2, 2.9)) return BODY; // head
    if (inEll(x, y - 42, z - 6.6, 1.3, 6.5, 1.2)) return BODY; // tail
    if (inEll(x, y - 16, z - 5, 3.2, 1.5, 2.9)) return PLUME; // collar
  } else {
    if (inEll(d - 1.8, y - 13.5, z - 7.1, 1.3, 2.1, 1.25)) return GLASS; // eyes
    if (inEll(x, y - 4.5, z - 5, 1.25, 6.4, 1.15)) return BODY; // snout
  }
  if (inEll(x, y - 23, z - 5, 3.4, 21, 2.9)) return BODY;
  if (d > 3.4 && d < 5.6 && y > 18.5 && y < 23.5 && z > 2.5 && z < 5.5) return y < 19.5 ? ENGINE : BODY; // air intakes
  if (y > 29.5 && y < 47.5 && (d - 3) ** 2 + (z - 4.5) ** 2 < 5.2) return y > 46.4 ? GLOW : y > 43.5 ? ENGINE : BODY; // engines
  if (y > 35.5 && y < 46.5 && z > 5.5) {
    // twin fins, leaning outwards, tipped with the flyer's colour
    const top = Math.min(11.5, 6.5 + (y - 35.5) * 0.9);
    if (z < top && Math.abs(d - (3 + (z - 6) * 0.45)) < 0.55) return z > 8.6 && z > top - 1.6 ? HEAD : BODY;
  }
  if (d < 10.5) {
    // tailplanes
    const le = 39.5 + d * 0.55;
    if (y > le && y < 46.5 + d * 0.2 && Math.abs(z - 4) < 0.5 && (d < 7.5 || (y - le) % 3 < 2)) return BODY;
  }
  if (d < 22.5) {
    // wings: swept back, thick at the root and thin at the tips, which split like toes
    const le = 16.5 + d * 0.62;
    const te = 36.5 + d * 0.08;
    if (y > le && y < te) {
      if (d > 16.5 && ((y - le) % 3 > 2 || d > 22.5 - Math.floor((y - le) / 3) * 1.5)) return 0;
      const along = (y - le) / (te - le);
      const half = Math.max(0.5, (0.45 + 1.5 * (1 - d / 22)) * Math.sqrt(4 * along * (1 - along)));
      if (Math.abs(z - 4.2) < half) return d > 4.5 && d < 15.5 && y > te - 5 && y < te - 2 ? PLUME : BODY;
    }
  }
  return 0;
}

function buildModel(who) {
  const grid = new Uint8Array(GW * GL * GH); // the whole block, for casting the flyer's shadows on itself
  const at = (i, j, k) => (i < 0 || j < 0 || k < 0 || i >= GW || j >= GL || k >= GH ? 0 : grid[(k * GL + j) * GW + i]);
  for (let k = 0; k < GH; k++) {
    for (let j = 0; j < GL; j++) {
      for (let i = 0; i < GW; i++) {
        const v = partAt((i + 0.5) / MK - 0.5 - MCX, (j + 0.5) / MK - 0.5, (k + 0.5) / MK - 0.5, who);
        grid[(k * GL + j) * GW + i] = v;
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
  const hot = [];
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
        // the body is coloured like the animal: its back on what faces up, then the pale line,
        // the stripe down its sides, and its belly underneath
        const up = l < 0.5 ? 1 : nz / l;
        col.push(v - BODY ? v : up > 0.5 ? BODY : up > 0.28 ? PLUME : up > -0.3 ? SIDE : BELLY);
        ni.push(q);
        ao.push(share > 0.5 ? 1 - Math.min(0.5, (share - 0.5) * 1.6) : 1 + Math.min(0.14, (0.5 - share) * 0.4));
        hot.push(Math.max(0, 1 - Math.hypot(Math.abs(x) - 3, y - 47, z - 4.5) / 9)); // how close to a burner: the fire lights it
        gi.push(i);
        gj.push(j);
        gk.push(k);
        used.add(q);
      }
    }
  }
  MODELS[who] = {
    n: a.length,
    grid,
    a: Float32Array.from(a),
    b: Float32Array.from(b),
    c: Float32Array.from(c),
    w: Float32Array.from(w),
    col: Uint8Array.from(col),
    ni: Uint16Array.from(ni),
    ao: Float32Array.from(ao),
    hot: Float32Array.from(hot),
    gi: Uint8Array.from(gi),
    gj: Uint8Array.from(gj),
    gk: Uint8Array.from(gk),
    used: Uint16Array.from(used),
  };
}

// ───────────────────────────────────────────────────────────── state

const TRAIL_N = 72; // points kept per wingtip
const TRAIL_STEP = 1; // world units between them
const PUFF_N = 240; // smoke, fire, spray and dust: all the soft round things
const PUFF_F = 10;

function makeFlyer(id) {
  return {
    id, // 0: Darwin the frog, player one · 1: the monito del monte, player two
    key: 'P' + (id + 1) + '_', // its buttons
    m: null, // its model
    x: 0,
    y: 0,
    z: 0,
    s: 0, // how far to the side of the squad it flies
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
    stam: 100, // boost left for the burners
    dash: 0, // seconds of dash still to run
    rest: 0,
    kick: 0, // the bounce off the ground
    graze: 0, // counts down after a touch of the ground: forgiven at first, then not
    inv: 0, // seconds of safety after a hit
    fireCd: 0,
    lock: null, // what its guns are tracking
    side: 0, // which side of the power line it was on
    agl: 0, // its height above the ground
    dx: 0, // the last way its stick was thrown, to count the thrashing
    dy: 0,
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

const lead = makeFlyer(0);
const mate = makeFlyer(1);
const crew = [lead]; // who is flying: Darwin alone, or with the monito once player two joins
const sq = { x: 0, y: 0, z: 0, yaw: 0 }; // the squad: the point the crew fly about, which the camera follows
const puffs = new Float32Array(PUFF_N * PUFF_F);
let puffHead = 0;

const cam = { x: 0, y: 0, yaw: 0, zr: 0, S: 1, q: 0.01, k: 0.2, cy: BH / 2 };
let now = 0;
let windX = 0;
let windY = 0;

// The game: the crew fly rescue over Chile while hacker drones hunt them.
const TITLE = 0;
const PLAY = 1;
const OVER = 2;
const SHOT = 240; // how fast the crew's shots fly
// What the whole game shares, each on its own: the mode, the score, the one shield …
let gMode = TITLE;
let gT = 0; // seconds in this mode
let gScore = 0;
let gBest = 0;
let gMult = 1; // flying low multiplies every reward
let gLow = 0;
let gShield = 100; // one shield for the whole crew
let gAgl = 0; // the lowest of the crew's heights above the ground, and the ground's height, for the panel
let gGnd = 0;
let gWater = 0; // loads of water aboard
let gFill = 0;
let gHacked = 0;
let gPurge = 0; // how far the crew have shaken the hacker off
let gChan = 0; // how far a hacker has got with breaking in
let gImmune = 0;
let gSpawnT = 0;
let gHackT = 0;
let gFenceT = 0;
let gEmT = 0;
let gEmN = 0;
let gSatT = 0;
let gMsg = '';
let gMsgT = 0;
let gShake = 0;
let gFlash = 0;
const drones = [];
const shots = []; // k: 0 the crew's, 1 the enemy's, 2 a load of water
const fires = [];
const folk = []; // people waiting for rescue
const fences = [];
let sat = null; // the hackers' satellite
let em = null; // the emergency under way: k 0 a wildfire, 1 a mudslide
const ROPE = 4; // how far below a flyer its water bucket hangs
let wet = null; // while there is a fire and no water aboard: the nearest water, and when it was looked for
let wetT = 0;
const QUEB = []; // cells in the ravines of the cordillera, where mudslides start

// The crew talk: Darwin (0) and the monito (1) tell the story and say what to do. Lines wait
// their turn; one given a number is news — said next, and only once a game.
const talk = []; // who, line, who, line …
let talkT = 0;
let told = 0;
function tell(who, line, once) {
  if (told & once) return;
  told |= once;
  if (once) talk.splice(2, 0, who, line); // news comes next, ahead of the story
  else talk.push(who, line);
}

// Sound: all of it made on the spot from tones and bursts of noise — the effects, the
// engines, the crew's voices and the music.
let AC = null; // the audio context, once Phaser has one
let OUT = null; // everything plays through this, which keeps it from clipping
let NOISE = null;
let ENGINE_TONE = null;
let ENGINE_OPEN = null;
let nextBeat = 0;
let beatN = 0;
let talkC = 0;

// A tone sliding from one pitch to another as it dies away, starting `wait` seconds from now.
function tone(from, to, secs, type, vol, wait) {
  if (!OUT) return;
  const o = AC.createOscillator();
  const g = AC.createGain();
  const t = AC.currentTime + (wait || 0);
  o.type = type;
  o.frequency.setValueAtTime(from, t);
  o.frequency.exponentialRampToValueAtTime(to, t + secs);
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + secs);
  o.connect(g).connect(OUT);
  o.start(t);
  o.stop(t + secs);
}

// A burst of noise dying away: `rate` low for a rumble, high for a hiss.
function burst(secs, vol, wait, rate) {
  if (!OUT) return;
  const s = AC.createBufferSource();
  const g = AC.createGain();
  const t = AC.currentTime + (wait || 0);
  s.buffer = NOISE;
  s.playbackRate.value = rate || 0.4 + Math.random() * 0.3;
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + secs);
  s.connect(g).connect(OUT);
  s.start(t);
  s.stop(t + secs);
}

const pitch = (semitones) => 110 * 2 ** (semitones / 12); // from the A below middle C

// Every frame: set the sound up once the browser lets it play, then keep the engines and the
// music going.
function sound() {
  if (!AC || AC.state !== 'running') return;
  const t = AC.currentTime;
  if (!OUT) {
    OUT = AC.createDynamicsCompressor();
    OUT.connect(AC.destination);
    NOISE = AC.createBuffer(1, AC.sampleRate, AC.sampleRate);
    const d = NOISE.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    // the engines: a low rasp through a filter that opens with the throttle
    ENGINE_TONE = AC.createOscillator();
    ENGINE_OPEN = AC.createBiquadFilter();
    const g = AC.createGain();
    ENGINE_TONE.type = 'sawtooth';
    g.gain.value = 0.045;
    ENGINE_TONE.connect(ENGINE_OPEN).connect(g).connect(OUT);
    ENGINE_TONE.start();
  }
  const thr = gMode === OVER ? 0 : crew.reduce((sum, f) => sum + f.thr, 0) / crew.length;
  ENGINE_TONE.frequency.setTargetAtTime(44 + thr * 62, t, 0.08);
  ENGINE_OPEN.frequency.setTargetAtTime(110 + thr * 950, t, 0.08);

  // the music: sixteen steps round four chords — a bass, a climbing figure over it, and, once
  // there are enemies about, a drum and a hiss to drive it. A hack sours the harmony.
  if (nextBeat < t - 1) nextBeat = t;
  const hot = gMode === PLAY && (drones.length || gHacked);
  while (nextBeat < t + 0.1) {
    const step = beatN++ & 15;
    const root = [0, 0, -4, -2][step >> 2] + (gHacked ? 6 : 0);
    const wait = nextBeat - t;
    if (!(step & 1)) tone(pitch(root - 12), pitch(root - 12), 0.27, 'triangle', 0.1, wait);
    if (hot || !(step & 3)) tone(pitch(root + [12, 19, 24, 19][step & 3]), pitch(root + 12), 0.11, 'square', 0.016, wait);
    if (hot && !(step & 3)) tone(130, 40, 0.16, 'sine', 0.2, wait);
    if (hot && step & 1) burst(0.03, 0.03, wait, 3);
    nextBeat += 0.15;
  }
}

const rand = Math.random;
const spread = () => rand() * 2 - 1;

function cell(x, y) {
  return ((Math.floor(y) & NM) << NS) | clamp(Math.floor(x), 0, NM);
}

function say(text, secs) {
  gMsg = text;
  gMsgT = secs || 1.8;
}

function gain(points, text) {
  points *= gMult;
  gScore += points;
  say(text + ' +' + points);
  tone(660, 660, 0.07, 'triangle', 0.1); // two notes, rising
  tone(990, 990, 0.14, 'triangle', 0.1, 0.07);
}

function heal(n) {
  gShield = Math.min(100, gShield + n);
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
  tone(110, 30, 0.35, 'sine', 0.22);
}

function damage(d) {
  gShield -= d;
  if (gShield > 0 || gMode !== PLAY) return;
  gShield = 0;
  for (const f of crew) boom(f.x, f.y, f.z, 40);
  gMode = OVER;
  gT = 0;
  gHacked = 0;
  if (gScore > gBest) gBest = gScore;
}

function hurt(f, d, why) {
  if (f.inv > 0 || gMode !== PLAY) return;
  f.inv = 1;
  gShake = 1;
  gFlash = 0.5;
  say(why, 1.2);
  tone(220, 50, 0.35, 'sawtooth', 0.2);
  burst(0.15, 0.15);
  damage(d);
}

function resetFlight() {
  sq.x = N * 0.41; // over the valley, heading north: sea to the left, cordillera to the right
  sq.y = N * 0.5;
  sq.yaw = cam.yaw = 0.12;
  cam.x = sq.x;
  cam.y = sq.y;
  lead.z = CRUISE_ALT;
  lead.trailLen = 0;
  puffs.fill(0);
}

// Player two comes in: the crew spread out to either side of the squad.
function join() {
  crew[1] = mate;
  Object.assign(mate, { z: lead.z, s: 8, stam: 100, inv: 2, trailLen: 0, kick: 0, rollT: 0, x: lead.x, y: lead.y });
  lead.s = -8;
  tell(1, '¡MONITO EN EL AIRE!\nVOLEMOS JUNTOS, DARWIN.');
}

function startGame(two) {
  gMode = PLAY;
  gT = gScore = gLow = gWater = gHacked = gPurge = gChan = gImmune = gEmN = gFlash = 0;
  gMult = 1;
  gShield = 100;
  gSpawnT = 4;
  gHackT = 20;
  gFenceT = 9;
  gEmT = 10;
  gSatT = 14;
  drones.length = shots.length = fires.length = folk.length = fences.length = 0;
  sat = em = null;
  crew.length = 1;
  Object.assign(lead, { s: 0, stam: 100, inv: 2, kick: 0, z: Math.max(lead.z, groundAt(lead.x, lead.y) + 20) });
  talk.length = talkT = told = 0;
  tone(220, 880, 0.5, 'triangle', 0.1);
  tell(0, 'AÑO 3000. LAS IA ENEMIGAS\nNOS ATACAN CON SUS DRONES.');
  tell(1, 'LA BIOINGENIERÍA NOS HIZO SÚPER LISTOS:\nPILOTEAMOS MEJOR QUE CUALQUIER IA.');
  tell(0, 'DISPARA CON B1. VUELA BAJO\nPARA MULTIPLICAR LOS PUNTOS.');
  if (two) join();
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

// A point on the model (in design units from the pivot) → the world.
function modelPoint(f, ma, mb, mc, out, o) {
  const a = f.ax;
  const s = MODEL_SCALE;
  out[o] = f.x + s * (ma * a[0] + mb * a[3] + mc * a[6]);
  out[o + 1] = f.y + s * (ma * a[1] + mb * a[4] + mc * a[7]);
  out[o + 2] = f.z + s * (ma * a[2] + mb * a[5] + mc * a[8]);
}

function spawnDrone(k) {
  if (k) tell(0, '¡UN DRON HACKER! DERRÍBALO O HAZ\nUN TONEL ANTES DE QUE ENTRE.', 2);
  else tell(0, '¡DRONES IA AL FRENTE!\nAPUNTA CON LA NARIZ Y DISPARA.', 1);
  drones.push({ k, hp: k ? 4 : 2, r: k ? 1.9 : 1.5, a: 190, s: spread() * 50, u: 8, ta: 50, ts: 0, tu: 4, nt: 0, cd: 1.5 + rand(), ch: 0, x: 0, y: 0, z: 0 });
}

// A spot of ground near the squad, mostly ahead of it, that passes the test.
function landNear(near, far, test) {
  for (let n = 0; n < 80; n++) {
    const a = sq.yaw + spread() * 1.4;
    const d = near + rand() * (far - near);
    const x = sq.x + Math.sin(a) * d;
    const y = sq.y - Math.cos(a) * d;
    if (x > 4 && x < N - 4 && test(GR[cell(x, y)] / GS)) return [x, y];
  }
  return null;
}

const GREEN = (g) => g > 23 && g < 40;

function light(x, y) {
  fires.push({ x, y, z: groundAt(x, y) });
}

// A wildfire: a few fires that spread until they are put out with water from the sea or a river.
// The sea or river nearest the crew: rings of places, further and further out, each looked
// over from dead ahead round to behind, so of two as near it is the one in front.
function findWater() {
  for (let r = 6; r < 500; r += 6) {
    for (let a = 0; a < 3.2; a += 6 / r) {
      for (const t of [sq.yaw + a, sq.yaw - a]) {
        const x = sq.x + Math.sin(t) * r;
        const y = sq.y - Math.cos(t) * r;
        if (x > 4 && x < N - 4 && GR[cell(x, y)] <= G_SHALLOW * GS) return { x, y, z: groundAt(x, y) };
      }
    }
  }
}
function startFire() {
  const at = landNear(110, 260, GREEN);
  if (!at) return false;
  for (let i = 0; i < 5; i++) light(at[0] + spread() * 8, at[1] + spread() * 8);
  em = { k: 0, t: 0 };
  say('¡INCENDIO!');
  tell(1, '¡INCENDIO! SIGUE LA FLECHA AL AGUA, MOJA EL\nBALDE Y SUÉLTALA SOBRE EL FUEGO CON B5.', 8);
  return true;
}

// A mudslide: it starts high in a ravine and runs down it, towards the people waiting below.
function startFlood() {
  let best = -1;
  let bd = 1e9;
  let by = 0;
  for (const q of QUEB) {
    const dy = ((((q >> NS) - sq.y) % N) + N * 1.5) % N - N / 2; // the short way round, north or south
    const d = Math.abs(Math.hypot((q & NM) - sq.x, dy) - 190);
    if (d < bd) {
      bd = d;
      best = q;
      by = sq.y + dy;
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
  say('¡ALUVIÓN!');
  tell(1, '¡ALUVIÓN! PASA BAJITO SOBRE LAS\nBALIZAS PARA RESCATAR A LA GENTE.', 16);
  return true;
}

function endEmergency() {
  em = null;
  fires.length = folk.length = 0;
  gEmT = 12 + rand() * 8;
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
  gT += dt;
  gImmune -= dt;
  gMsgT -= dt;
  gShake *= Math.exp(-5 * dt);
  gFlash *= Math.exp(-4 * dt);
  const play = gMode === PLAY;
  if (talk[1]) {
    // each of the crew has a voice: Darwin croaks, the monito chirps, a note every few letters
    const c = ((talkT += dt) * 40) | 0;
    if (c !== talkC && c < talk[1].length && c % 3 === 0) {
      if (talk[0]) tone(1000 + rand() * 500, 1500, 0.04, 'square', 0.02);
      else tone(150 + rand() * 40, 90, 0.07, 'sawtooth', 0.045);
    }
    talkC = c;
    if (talkT > talk[1].length * 0.03 + 2.6) {
      talk.splice(0, 2); // the line has been read: on to the next
      talkT = 0;
    }
  }
  if (play && gShield < 30 && ((now * 1.6) | 0) !== (((now - dt) * 1.6) | 0)) tone(880, 880, 0.08, 'square', 0.04); // little shield left
  if (play && gShield < 35) tell(1, 'ESCUDO BAJO. LOS RESCATES Y LOS\nINCENDIOS APAGADOS LO RECUPERAN.', 128);
  if (play && !crew[1] && pressed.START2) join();
  const duo = crew.length > 1;
  const n = crew.length;
  const sx = Math.sin(sq.yaw); // the way the squad is heading …
  const sy = -Math.cos(sq.yaw);
  const rx = -sy; // … and its right

  // ── each of the crew at their stick. Alone, the stick turns the squad. With two, each
  // slides to the side on their own stick, and the squad turns the way they lean together.
  // Hacked, the sticks are reversed and the guns are dead until the crew shake it off, by
  // thrashing the sticks about and hammering their fire buttons.
  let turns = 0;
  let pushes = 0;
  for (const f of crew) {
    const k = f.key;
    const rawX = (held[k + 'R'] ? 1 : 0) - (held[k + 'L'] ? 1 : 0);
    const rawY = (held[k + 'U'] ? 1 : 0) - (held[k + 'D'] ? 1 : 0);
    let turn = rawX;
    let lift = INVERT_Y ? -rawY : rawY;
    if (!play) {
      turn = Math.sin(now * 0.23) * 0.45; // out of play, it wanders by itself
      lift = clamp((Math.max(groundAt(f.x, f.y), groundAt(f.x + sx * 25, f.y + sy * 25)) + 16 - f.z) / 6, -1, 1);
    } else if (gHacked) {
      turn = -turn;
      lift = -lift;
      if (rawX && rawX !== f.dx) {
        f.dx = rawX;
        gPurge += 0.1;
      }
      if (rawY && rawY !== f.dy) {
        f.dy = rawY;
        gPurge += 0.1;
      }
      if (pressed[k + '1']) gPurge += 0.07;
    }
    f.turn += (turn - f.turn) * (1 - Math.exp(-6 * dt));
    f.lift += (lift - f.lift) * (1 - Math.exp(-5 * dt));

    // B4: a dash throws it forward, and holding it keeps the burners lit — for as long as
    // there is boost left. Boost comes back once the burners have been off for a moment.
    let burn = 0.3;
    if (play) {
      if (pressed[k + '4'] && f.stam > 18) {
        f.dash = 0.4;
        f.stam -= 18;
        burst(0.35, 0.2);
        tone(140, 620, 0.3, 'sawtooth', 0.05);
      }
      if (held[k + '4'] && f.stam > 0) {
        burn = 1;
        f.stam = Math.max(0, f.stam - dt * 24);
        f.rest = 0.6;
      } else if (!held[k + '4'] && (f.rest -= dt) < 0) f.stam = Math.min(100, f.stam + dt * 18);
    }
    f.dash -= dt;
    if (f.dash > 0) burn = 1.9;
    f.thr += (burn - f.thr) * (1 - Math.exp((f.dash > 0 ? -16 : -4) * dt));
    const push = Math.max(0, (f.thr - 0.3) / 0.7);
    const fast = 1 + (BOOST - 1) * push;
    f.inv -= dt;
    f.bank = (f.turn * BANK_ANGLE * Math.PI) / 180;
    f.pitch = Math.atan2(f.lift * CLIMB_RATE, SPEED);
    f.kick *= Math.exp(-4 * dt);
    f.z = Math.min(CEILING, f.z + (f.lift * CLIMB_RATE * fast * (f.lift < 0 && f.agl < 4 ? Math.max(0.35, (f.agl - 1) / 3) : 1) + f.kick) * dt);
    if (duo) f.s += f.turn * 26 * dt;

    // barrel rolls: one full turn about the nose, left or right, sliding it that way. While
    // it rolls, shots glance off it and laser fences cannot hold it.
    if (play && (pressed[k + '2'] || pressed[k + '3']) && f.rollT <= 0) {
      f.rollT = 1;
      f.rollDir = pressed[k + '2'] ? -1 : 1;
      tone(240, 880, 0.6, 'sine', 0.06);
    }
    if (f.rollT > 0) {
      const was = f.rollT;
      f.rollT = Math.max(0, was - dt / ROLL_TIME);
      f.roll = f.rollDir * TAU * ease(1 - f.rollT);
      // the slide is quickest half-way through the roll
      const slide = (f.rollDir * ROLL_SLIDE * (Math.cos(Math.PI * f.rollT) - Math.cos(Math.PI * was))) / 2;
      if (duo) f.s += slide;
      else {
        sq.x += rx * slide;
        sq.y += sx * slide;
      }
    } else f.roll = 0;
    f.s = duo ? clamp(f.s, -24, 24) : 0;
    turns += f.turn / n;
    pushes += push / n;
  }
  if (gHacked) {
    gPurge = Math.max(0, gPurge - dt * 0.15);
    damage(dt * 2.5);
    if (((now * 3) | 0) !== (((now - dt) * 3) | 0)) tone(520, 260, 0.25, 'square', 0.07); // the alarm
    if (gPurge >= 1) {
      gHacked = 0;
      gImmune = 9;
      gFlash = 1;
      tone(200, 1600, 0.45, 'square', 0.07);
      for (const d of drones) if (d.k) d.hp = 0;
      gain(400, '¡HACKER EXPULSADO!');
    }
  }

  // ── the squad flies on
  const spd = SPEED * (1 + (BOOST - 1) * pushes);
  sq.yaw += turns * TURN_RATE * (duo ? 0.8 : 1) * dt;
  sq.x += sx * spd * dt;
  sq.y += sy * spd * dt;

  // ── each of the crew in the world: the ground, their guns, the things they can hit
  const mid = sq.z; // where the crew were, on average: two cannot drift far apart in height
  let top = 0;
  sq.z = 0;
  gAgl = 1e9;
  for (const f of crew) {
    f.x = sq.x + rx * f.s;
    f.y = sq.y + sx * f.s;
    f.yaw = sq.yaw + (duo ? f.turn * 0.3 : 0); // with two, the nose swings with the stick, to aim
    if (duo) f.z = clamp(f.z, mid - 14, mid + 14);

    // the ground and the water are solid, but a touch is forgiven: the flyer scrapes along
    // for a moment, bounced up a little, throwing dust or spray. Only if it is still down
    // after that, or comes down again too soon, does it cost shield and get thrown back up
    const ground = Math.max(groundAt(f.x, f.y), groundAt(f.x + sx * 3, f.y + sy * 3));
    f.graze = Math.max(0, f.graze - dt);
    if (f.z - ground < 1) {
      f.z = ground + 1;
      puff(f.x, f.y, ground + 0.3, spread() * 6, spread() * 6, 3 + rand() * 4, 0.5, GR[cell(f.x, f.y)] > G_SHALLOW * GS ? 4 : 3, 0.9);
      if (!f.graze) {
        f.graze = 1.3;
        f.kick = 12;
        say('¡ROZASTE! SUBE', 0.9);
        tone(700, 500, 0.12, 'square', 0.06);
      } else if (f.graze < 0.85) {
        f.kick = 34;
        gLow = 0;
        hurt(f, 20, '¡CHOQUE!');
      }
    }
    f.agl = f.z - ground;
    gAgl = Math.min(gAgl, f.agl);
    top = Math.max(top, f.agl);
    sq.z += f.z / n;

    // the wings bend up a little in a climb
    f.flex += (0.02 + f.lift * 0.05 - f.flex) * (1 - Math.exp(-10 * dt));
    axesOf(f);
    const nx = f.ax[3];
    const ny = f.ax[4];
    const nz = f.ax[5];

    // guns: they track whatever enemy is nearest the line of the nose
    f.lock = null;
    let best = 0.035;
    const aim = (t) => {
      const dx = t.x - f.x;
      const dy = t.y - f.y;
      const dz = t.z - f.z;
      const d = Math.hypot(dx, dy, dz);
      const off = 1 - (dx * nx + dy * ny + dz * nz) / d;
      if (d < 150 && off < best) {
        best = off;
        f.lock = t;
      }
    };
    drones.forEach(aim);
    if (sat) aim(sat);
    f.fireCd -= dt;
    if (play && held[f.key + '1'] && !gHacked && f.fireCd <= 0) {
      f.fireCd = 0.12;
      tone(1100 - f.id * 260, 320, 0.07, 'square', 0.03); // each flyer's guns have their own note
      shots.push({ k: 0, x: f.x + nx * 3, y: f.y + ny * 3, z: f.z + nz * 3, vx: nx * SHOT, vy: ny * SHOT, vz: nz * SHOT, t: 0.7, to: f.lock });
    }

    if (play) {
      // the power line: the cables and the pylons are solid; slipping under the cables pays
      const off = f.x - lineX(f.y);
      const span = (f.y - 16) / PYLON;
      const j = Math.floor(span);
      const fr = span - j;
      const wire = pylonTop(j) + (pylonTop(j + 1) - pylonTop(j)) * fr - ARM - SAG * 2 * Math.min(fr, 1 - fr);
      if (Math.abs(off) < 3.4 && Math.abs(f.z - wire) < 0.9) hurt(f, 18, '¡CABLES!');
      else if (Math.abs(off) < 1.6 && (fr < 0.06 || fr > 0.94) && f.z < wire + ARM) hurt(f, 25, '¡TORRE!');
      else if (off * f.side < 0 && Math.abs(off) < 3 && f.z < wire) gain(120, 'BAJO LOS CABLES');
      f.side = off;

      // buildings are solid too
      for (const t of TOWNS) {
        const dy = f.y - t.y - Math.round((f.y - t.y) / N) * N; // the town's nearest self, north or south
        if (Math.abs(f.x - t.x) + Math.abs(dy) > 26) continue;
        for (let o = 0; o < t.b.length; o += 6) {
          const w = t.b[o + 4] + 0.8;
          if (Math.abs(f.x - t.b[o]) < w && Math.abs(dy - t.b[o + 1] + t.y) < w && f.z < t.b[o + 2] + t.b[o + 3] + 0.3) {
            hurt(f, 25, '¡EDIFICIO!');
            f.kick = 24;
          }
        }
      }

      // water: each flyer hangs a bucket on a line, as helicopters do. Dip it in the sea or a
      // river to fill it, B5 to let a load go
      if (gWater < 3 && [0, 4, -4].some((o) => GR[cell(f.x + sy * o, f.y - sx * o)] <= G_SHALLOW * GS || GR[cell(f.x + sx * o, f.y + sy * o)] <= G_SHALLOW * GS)) {
        if (f.agl < ROPE + 2) {
          gFill += dt;
          puff(f.x - sx * 2, f.y - sy * 2, ground + 0.3, spread() * 5 - sx * 8, spread() * 5 - sy * 8, 5 + rand() * 5, 0.5, 3, 0.8);
          if (gFill > 0.08) {
            gFill = 0;
            say('AGUA EN EL BALDE ' + ++gWater + '/3', 1);
            tone(300, 600, 0.12, 'sine', 0.1);
          }
        } else if (fires[0] && f.agl < 40) say('BAJA MÁS: EL BALDE DEBE TOCAR EL AGUA', 0.3);
      }
      if (pressed[f.key + '5'] && gWater > 0) {
        gWater--;
        burst(0.3, 0.08, 0, 1.5);
        shots.push({ k: 2, x: f.x, y: f.y, z: f.z - ROPE, vx: sx * spd, vy: sy * spd, vz: -4, t: 8 });
      }
    }

    // wingtip trails and exhaust
    const up = (WINGTIPS[1][0] - WING_ROOT) * f.flex;
    modelPoint(f, WINGTIPS[0][0], WINGTIPS[0][1], WINGTIPS[0][2] + up, f.tip, 0);
    modelPoint(f, WINGTIPS[1][0], WINGTIPS[1][1], WINGTIPS[1][2] + up, f.tip, 3);
    if (gMode === OVER) f.trailLen = 0;
    else if (!f.trailLen || Math.hypot(f.x - f.trailX, f.y - f.trailY) >= TRAIL_STEP) {
      f.trailHead = (f.trailHead + 1) % TRAIL_N;
      if (f.trailLen < TRAIL_N) f.trailLen++;
      f.trailX = f.x;
      f.trailY = f.y;
      for (let s = 0; s < 2; s++) {
        const o = f.trailHead * 3;
        f.trail[s][o] = f.tip[s * 3];
        f.trail[s][o + 1] = f.tip[s * 3 + 1];
        f.trail[s][o + 2] = f.tip[s * 3 + 2];
      }
    }
    if (gMode !== OVER && f.thr > 0.6 && rand() < dt * 50) {
      for (const nz2 of NOZZLES) {
        modelPoint(f, nz2[0], nz2[1] - 6, nz2[2], TIP, 0);
        puff(TIP[0], TIP[1], TIP[2], -nx * 9 + spread() * 1.5, -ny * 9 + spread() * 1.5, 1 + rand() * 1.5, 0.9 + rand() * 0.6, 0, 0.5);
      }
    }
  }
  gGnd = groundAt(sq.x, sq.y);
  // flying low — all of the crew — multiplies every reward
  if (play) {
    gLow = top < 8 ? Math.min(10, gLow + dt) : Math.max(0, gLow - dt * 4);
    gMult = 1 + ((gLow / 2.5) | 0);
  }
  const cfx = Math.sin(cam.yaw); // the way the camera looks: enemies keep their station in front of it
  const cfy = -Math.cos(cam.yaw);

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
    const hit = (d) => {
      if (dead || Math.hypot(d.x - s.x, d.y - s.y, d.z - s.z) > (d.r || 1.4) + 1) return;
      dead = true;
      puff(s.x, s.y, s.z, 0, 0, 0, 0.14, 2, 1.3);
      if (!s.k) d.hp--;
      else if (d.rollT <= 0) hurt(d, 14, '¡IMPACTO!'); // a roll turns it aside
    };
    if (s.z < gz) {
      dead = true;
      if (s.k === 2) douse(s.x, s.y, gz);
      else puff(s.x, s.y, gz + 0.3, 0, 0, 2, 0.3, 4, 0.6);
    } else if (!s.k) {
      drones.forEach(hit);
      if (sat) hit(sat);
    } else if (s.k === 1 && play) crew.forEach(hit);
    if (dead) shots.splice(i, 1);
  }
  const shootAt = (d, size) => {
    const f = crew[(rand() * n) | 0];
    const t = Math.hypot(f.x - d.x, f.y - d.y, f.z - d.z) / 70; // lead the target a little
    const tx = f.x + sx * spd * t * 0.8 - d.x;
    const ty = f.y + sy * spd * t * 0.8 - d.y;
    const tz = f.z - d.z;
    const l = 70 / Math.hypot(tx, ty, tz);
    shots.push({ k: 1, x: d.x, y: d.y, z: d.z, vx: tx * l, vy: ty * l, vz: tz * l, t: 4, r: size });
    tone(520, 180, 0.12, 'sawtooth', 0.025);
  };

  // ── drones keep a station ahead of the squad, weaving about it. Shooters fire; hackers
  // need a few seconds of clear signal to break in, and a roll cuts the signal
  const rolling = crew.some((f) => f.rollT > 0);
  gChan = 0;
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
    d.x = sq.x + cfx * d.a - cfy * d.s;
    d.y = sq.y + cfy * d.a + cfx * d.s;
    d.z = Math.max(sq.z + d.u, groundAt(d.x, d.y) + 3);
    if (!play) continue;
    if (!d.k) {
      d.cd -= dt;
      if (d.cd < 0 && d.a < 90) {
        d.cd = 1.4 + rand() * 2;
        shootAt(d, 0.6);
      }
    } else if (!gHacked && gImmune <= 0 && d.a < 70) {
      d.ch = rolling ? Math.max(0, d.ch - dt * 1.5) : d.ch + dt / 3;
      gChan = Math.max(gChan, d.ch);
      if (d.ch >= 1) {
        d.ch = 0;
        gHacked = 1;
        gPurge = 0;
        gLow = 0;
        tell(0, '¡NOS HACKEARON! AGITA LA PALANCA\nY MACHACA B1 PARA SACARLO.', 64);
      }
    }
  }

  if (play) {
    gSpawnT -= dt;
    if (gSpawnT < 0 && drones.length < Math.min(6, 1 + n + ((gT / 25) | 0))) {
      gSpawnT = Math.max(2.5, 7 - gT / 30) / n;
      spawnDrone(0);
    }

    // ── the hackers' satellite, far up in the stratosphere: while it is there it keeps
    // sending hacker drones down
    if (!sat) {
      gSatT -= dt;
      if (gSatT < 0) {
        sat = { x: sq.x + cfx * 90, y: sq.y + cfy * 90, z: 285, hp: 14, r: 4.5, cd: 3 };
        tell(1, 'EL SATÉLITE HACKER ESTÁ EN LA\nESTRATÓSFERA. SUBE Y DESTRÚYELO.', 32);
      }
    } else if (sat.hp <= 0) {
      boom(sat.x, sat.y, sat.z, 40);
      gain(1500, 'SATÉLITE DESTRUIDO');
      sat = null;
      gSatT = 60;
      gHackT = 20;
    } else {
      const e = 1 - Math.exp(-0.3 * dt);
      sat.x += (sq.x + cfx * 60 - sat.x) * e;
      sat.y += (sq.y + cfy * 60 - sat.y) * e;
      sat.cd -= dt;
      if (sat.cd < 0 && Math.hypot(sq.x - sat.x, sq.y - sat.y, sq.z - sat.z) < 130) {
        sat.cd = 1.3;
        shootAt(sat, 1);
      }
      gHackT -= dt;
      if (gHackT < 0) {
        gHackT = 24;
        spawnDrone(1);
      }
    }

    // ── laser fences across the squad's path: roll through one, or go round it
    gFenceT -= dt;
    if (gFenceT < 0 && gAgl < 30 && sq.z < 100) {
      gFenceT = 10 + rand() * 8;
      const off = spread() * 8;
      const x = sq.x + sx * 130 + rx * off;
      const y = sq.y + sy * 130 + sx * off;
      const z = Math.max(groundAt(x, y), groundAt(x - rx * 18, y - sx * 18), groundAt(x + rx * 18, y + sx * 18)) + 2;
      fences.push({ x, y, nx: sx, ny: sy, w: duo ? 34 : 22, z0: z, z1: z + 15, was: [-1, -1] });
      tell(1, 'VALLA LÁSER ADELANTE: CRÚZALA\nHACIENDO UN TONEL CON B2 O B3.', 4);
    }
    for (let i = fences.length - 1; i >= 0; i--) {
      const f = fences[i];
      for (const c of crew) {
        const dx = c.x - f.x;
        const dy = c.y - f.y;
        const along = dx * f.nx + dy * f.ny;
        if (f.was[c.id] < 0 && along >= 0 && Math.abs(dy * f.nx - dx * f.ny) < f.w && c.z > f.z0 - 1 && c.z < f.z1 + 1) {
          if (c.rollT > 0) {
            gain(250, '¡TONEL!');
            heal(5);
          } else hurt(c, 22, '¡LÁSER!');
        }
        f.was[c.id] = along;
      }
      const gone = (sq.x - f.x) * f.nx + (sq.y - f.y) * f.ny;
      if (gone > 30 || gone < -250) fences.splice(i, 1);
    }

    // with a fire burning and the buckets dry, the crew is shown the way to the nearest water
    if (!fires[0] || gWater) wet = null;
    else if (now > wetT) {
      wetT = now + 0.4;
      wet = findWater();
    }

    // ── emergencies, one at a time: a wildfire, then a mudslide, and round again
    if (!em) {
      gEmT -= dt;
      if (gEmT < 0) {
        if (gEmN++ & 1 ? startFlood() : startFire()) gEmT = 0;
        else gEmT = 2;
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
            gLow = 0;
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
          if (crew.some((c) => Math.hypot(c.x - f.x, c.y - f.y) < 5 && c.z - f.z < 7)) {
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
    if (Math.abs(f.x - sq.x) + Math.abs(f.y - sq.y) > 260) continue;
    if (rand() < dt * 9) puff(f.x + spread(), f.y + spread(), f.z + 0.5, spread(), spread(), 4 + rand() * 4, 0.6, 1, 1.3);
    if (rand() < dt * 2.5) puff(f.x, f.y, f.z + 3, 1.5 + spread(), 0.6 + spread(), 5 + rand() * 3, 2.2, 5, 1.8);
  }

  // ── everything that drifts
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

  // ── the camera: behind the squad and a little above, swinging round after it in a turn
  // and trailing it for a moment when it slides sideways
  cam.S = (CHASE_WIDTH * BW) / (MW * MODEL_SCALE) / (duo ? 1.25 : 1); // with two, it stands further off
  cam.q = 1 / (CHASE_DIST * (1 + 0.16 * pushes) * ML * MODEL_SCALE); // it drops back as the squad surges ahead
  cam.k = Math.tan((CHASE_ELEV * Math.PI) / 180);
  cam.cy = BH * CHASE_Y + spread() * gShake * 6;
  cam.yaw += wrapAngle(sq.yaw - cam.yaw) * (1 - Math.exp(-CHASE_FOLLOW * dt));
  const cx = Math.cos(cam.yaw);
  const cy = Math.sin(cam.yaw);
  const aside = ((sq.x - cam.x) * cx + (sq.y - cam.y) * cy) * Math.exp(-CHASE_SLIDE * dt);
  cam.x = sq.x - cx * aside;
  cam.y = sq.y - cy * aside;
  cam.zr = sq.z;
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
// with a glint where the sun bounces towards the camera; and pale from its own burners, near
// them.
const LV = new Float32Array(4096); // the sun on each direction a surface can face …
const SP = new Float32Array(4096); // … and the glint there
const STEP = new Float32Array(9);
let fx0 = 0;
let fy0 = 0;
let fv0 = 0;
let fHalf = 0.5;

function plotVoxel(ma, mb, mc, colour) {
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
    }
  }
}

// Which of a flyer's voxels have another part of it between them and the sun. The light's
// direction is given in the flyer's own axes: across, towards the nose, up.
function castShadows(f, lx, ly, lz) {
  const { n, gi, gj, gk, ni, grid } = f.m;
  for (let v = 0; v < n; v++) {
    const o = ni[v] * 3;
    // start just off the surface, then walk towards the sun
    let x = gi[v] + 0.5 + NQ[o] * 1.6 + lx;
    let y = gj[v] + 0.5 - NQ[o + 1] * 1.6 - ly;
    let z = gk[v] + 0.5 + NQ[o + 2] * 1.6 + lz;
    let hit = 0;
    for (let s = 0; s < 60; s++, x += lx, y -= ly, z += lz) {
      if (x < 0 || y < 0 || z < 0 || x >= GW || y >= GL || z >= GH) break;
      if (grid[((z | 0) * GL + (y | 0)) * GW + (x | 0)]) {
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
  const s = prM * MODEL_SCALE;
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
    STEP[i + 2] = MODEL_SCALE * dep;
  }

  // the sun, and the direction half-way between the sun and the camera, in the flyer's own
  // axes; shadows are cast again only when the sun has moved across it
  const lx = a[0] * LIGHT[0] + a[1] * LIGHT[1] + a[2] * LIGHT[2];
  const ly = a[3] * LIGHT[0] + a[4] * LIGHT[1] + a[5] * LIGHT[2];
  const lz = a[6] * LIGHT[0] + a[7] * LIGHT[1] + a[8] * LIGHT[2];
  const { n, a: ma, b: mb, c: mc, w: mw, col, ni, ao, hot, used } = f.m;
  if (!f.shade) {
    f.shade = new Uint8Array(n);
    f.sunZ = 9;
  }
  if (lx * f.sunX + ly * f.sunY + lz * f.sunZ < 0.9985) castShadows(f, lx, ly, lz);
  const eye = norm3(LIGHT[0] - fwdX, LIGHT[1] - fwdY, LIGHT[2] + cam.k + 0.6);
  const hx = a[0] * eye[0] + a[1] * eye[1] + a[2] * eye[2];
  const hy = a[3] * eye[0] + a[4] * eye[1] + a[5] * eye[2];
  const hz = a[6] * eye[0] + a[7] * eye[1] + a[8] * eye[2];
  for (let i = 0; i < used.length; i++) {
    const q = used[i];
    const o = q * 3;
    const d = NQ[o] * lx + NQ[o + 1] * ly + NQ[o + 2] * lz;
    const h = NQ[o] * hx + NQ[o + 1] * hy + NQ[o + 2] * hz;
    LV[q] = d > 0 ? d : 0;
    SP[q] = h > 0 ? Math.pow(h, 20) : 0;
  }

  const shade = f.shade;
  const flex = f.flex;
  const skin = (f.id + 1) * NMAT;
  const fire = Math.min(1, f.thr) * 90; // how brightly the burners light the tail
  for (let i = 0; i < n; i++) {
    const q = ni[i];
    const m = col[i];
    let l = shade[i] ? (0.36 + 0.1 * LV[q]) * ao[i] * 15 : (0.36 + 0.64 * LV[q]) * ao[i] * 15 + SP[q] * GLINT[m];
    if (l > NLV - 1) l = NLV - 1;
    const c = JPAL[(skin + m) * NLV + (l | 0)];
    plotVoxel(ma[i], mb[i], mc[i] + mw[i] * flex, hot[i] ? mix(c, HEAT[1], (hot[i] * fire) | 0) : c);
  }
  drawFlames(f, s);
}

// Something soft and round at a place in the world: `r` across, `dens` thick at its middle.
function soft(x, y, z, r, colour, dens) {
  if (project(x, y, z)) blot(r, colour, dens);
}

// The same, at the place on screen the last projection left (prX, prY, at depth prV).
function blot(r, colour, dens) {
  r *= prM;
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

// The burners. Each flame is a slim string of soft lights from the nozzle to its tip:
// a white-hot root, then ice blue, deepening as it cools. It grows with the throttle and leaps out
// in a dash, it flickers, it shows shock diamonds when the burners are wide open, and in a
// turn it trails round the inside of the curve the flyer has flown.
const HEAT = [pack(255, 255, 255), pack(214, 240, 255), pack(150, 208, 250), pack(96, 160, 236), pack(60, 108, 204)];
const TIP = new Float32Array(3);
// `s` is the size of the flyer's design unit on screen, as it was just drawn
function drawFlames(f, s) {
  const open = Math.max(0, (f.thr - 0.3) / 0.7); // 0 idling · 1 burners lit · more in a dash
  const len = (1.1 + open * 3.8) * (1 + 0.1 * Math.sin(now * 53) + 0.06 * Math.sin(now * 31 + 2));
  for (const nz of NOZZLES) {
    for (let i = 17; i >= 0; i--) {
      // from the tip back to the root, so the white of the root is what shows from behind;
      // each light is placed in the flyer's own frame, like its voxels, so it stays on the nozzle
      const t = i / 17;
      const d = t * len;
      const wob = Math.sin(now * 37 + i * 1.7 + nz[0]) * t * 0.08 * (1 + open) * invMs;
      const ma = nz[0] + f.turn * d * d * 0.09 * invMs + wob;
      const mb = nz[1] - d * invMs;
      const mc = nz[2] + wob;
      prX = fx0 + ma * STEP[0] + mb * STEP[3] + mc * STEP[6];
      prY = fy0 + ma * STEP[1] + mb * STEP[4] + mc * STEP[7];
      prV = fv0 + ma * STEP[2] + mb * STEP[5] + mc * STEP[8];
      prM = s * invMs;
      blot((0.15 + open * 0.07) * (1 - t) + 0.04, HEAT[t < 0.07 ? 0 : Math.min(4, 1 + ((t * 3.6) | 0))], (1 - t * 0.9) * 230 * (open > 0.6 ? 0.75 + 0.25 * Math.sin(d * 5 - now * 26) : 1));
    }
  }
}

// Everything soft and round that drifts: exhaust, flames, flashes, spray, dust, black smoke.
const PUFF_COL = [pack(96, 84, 92), 0, pack(255, 255, 255), pack(110, 180, 230), pack(150, 125, 95), pack(40, 44, 54)];
const FLAMES = [pack(255, 232, 120), pack(255, 150, 44), pack(214, 60, 30)];
const PUFF_DENSE = [110, 235, 255, 200, 150, 190];
function drawPuffs() {
  for (let o = 0; o < puffs.length; o += PUFF_F) {
    const age = puffs[o + 6];
    if (age <= 0) continue;
    const life = age / puffs[o + 7];
    const kind = puffs[o + 8];
    soft(puffs[o], puffs[o + 1], puffs[o + 2], puffs[o + 9] * (0.5 + life * 1.5), kind === 1 ? FLAMES[(life * 3) | 0] : PUFF_COL[kind], (1 - life) * PUFF_DENSE[kind]);
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
    const dx = sq.x - d.x;
    const dy = sq.y - d.y;
    const dz = sq.z - d.z;
    const l = (d.r * 0.8) / Math.hypot(dx, dy, dz);
    ball(d.x, d.y, d.z, d.r, d.k ? ENGINE : HEAD);
    ball(d.x + dx * l, d.y + dy * l, d.z + dz * l, d.r * 0.45, d.k ? GLOW : PLUME, d.k);
    const bob = Math.sin(now * 14 + d.s) * 0.3;
    ball(d.x + rgtX * d.r * 1.5, d.y + rgtY * d.r * 1.5, d.z + bob, d.r * 0.5, BODY);
    ball(d.x - rgtX * d.r * 1.5, d.y - rgtY * d.r * 1.5, d.z - bob, d.r * 0.5, BODY);
    if (d.k) {
      beam(d.x, d.y, d.z + d.r, d.x, d.y, d.z + d.r + 2.5, 0.3, colRed, 255);
      if (d.ch > 0) beam(d.x, d.y, d.z, sq.x, sq.y, sq.z, 0.5, colRed, 90 + ((d.ch * 120 + Math.sin(now * 40) * 40) | 0));
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
  if (wet) beam(wet.x, wet.y, wet.z + 8, wet.x, wet.y, wet.z + 150, 1.2, WATER, 110);
  if (gMode === PLAY && (fires[0] || gWater)) {
    // the buckets: orange when empty, blue with water in them, trailing a little behind
    for (const f of crew) {
      const x = f.x - Math.sin(f.yaw) * 2;
      const y = f.y + Math.cos(f.yaw) * 2;
      const z = Math.max(groundAt(x, y) + 0.5, f.z - ROPE - (f.agl < ROPE + 2 ? 2 : 0)); // the line pays out near the ground
      beam(f.x, f.y, f.z, x, y, z, 0.12, colOutline, 255);
      ball(x, y, z, 0.55, gWater ? GLASS : FIRE);
    }
  }

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
    const ty = t.y + Math.round((sq.y - t.y) / N) * N - t.y; // shift to its nearest self, north or south
    if (Math.abs(sq.x - t.x) + Math.abs(sq.y - t.y - ty) > 320) continue;
    for (let o = 0; o < t.b.length; o += 6) slab(t.b[o], t.b[o + 1] + ty, t.b[o + 2], t.b[o + 3], t.b[o + 4], t.b[o + 5]);
  }
  // the power line: each pylon is two legs and a crossarm, with a cable from each end of the
  // arm sagging to the next pylon
  const j0 = Math.floor(sq.y / PYLON);
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

// A flyer's gunsight: four corners round whatever its guns are tracking, or dead ahead.
function drawSight(f) {
  const t = f.lock;
  const ok = t ? project(t.x, t.y, t.z) : project(f.x + f.ax[3] * 60, f.y + f.ax[4] * 60, f.z + f.ax[5] * 60);
  if (!ok) return;
  const r = t ? Math.max(5, t.r * prM + 3) | 0 : 4;
  const c = t ? colRed : f.id ? GOLD : colTrail;
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

// ── the panel: lettering, gauges, radar and markers, drawn straight into the picture

// ── the instruments: laid straight over the picture, with no panels behind them. Lettering
// and gauges carry a dark edge instead, so they read over sky, snow and grass alike

const INK = pack(240, 246, 255);
const DIM = pack(176, 208, 232);
const GOLD = pack(255, 214, 90);
const WATER = pack(110, 180, 230);
const EDGE = pack(12, 22, 38); // the dark edge (the lettering's is the same colour)
const OFF = pack(44, 62, 84); // a lamp that is not lit
const TOP = 16; // marks keep this far from the top of the screen …
const VB = BH - 16; // … and stop here at the foot

function box(x, y, w, h, colour) {
  const x0 = Math.max(0, x | 0);
  const x1 = Math.min(BW, (x + w) | 0);
  const y1 = Math.min(BH, (y + h) | 0);
  for (let py = Math.max(0, y | 0); py < y1; py++) {
    for (let p = py * BW + x0, e = py * BW + x1; p < e; p++) FB[p] = colour;
  }
}

// Lettering is the engine's own text, laid over the picture, in VT323 — a terminal typeface
// (SIL Open Font License), cut down to the characters the game uses and carried here as
// base64 with `_` standing for `/`. The labels are kept and used again every frame; one is
// only redrawn when what it says, its size or its colour changes.
const FONT =
  'd09GMgABAAAAAAesAAsAAAAAMwgAAAdgAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAABmAAgVwRCAreGMloATYCJAOBXAtwAAQgBQYHIBunJ1GUD8o8iJ8HtjH1oQVFgJYhgTKWLXFIHB7e3fW9AiEMaGDxLwhKl+69TKjR+BU6A8ksA5+RFWSFuUuFUAFRB6wuSEWrmdTO+z1j7k_sboJYVG2mnbeGy5WARte4VBHTGx4SrP8B6h93HeGxPP_7pT_Lf9QmJEqVpnEq_czsJrm0_ktTFAdy7zt338++3dCLRBjGM74LicN1oRAKozEiNpKnLEvVXRLfjV2lvIW6zyBMTBgmEA6BXcZqoO98B2IWZfgAwqNxHqjxRSf2TR7kKdH80NLUgLCkfIAAEAeM2UEaGhCAssNAQ5wNw0P4F0kjDEinhFrqmMg0zuARnrHJLoccc85VCJBGATZ1tDAJ6WMI7V+EMihXEmj+sqVc45+RII0MAHJ4v0tQQgXFlFNKGYG0+PsQTQyxxJFAIkkko2OQQhCTEYxkFAIRQiIA1QCsBMZB8h2gVwIJQBLvswE0M_QClxP4p0mwiZYEPgjCzYQ1m9AUQYU6pU14wDA+r2zU9UmNhY1fTzcsWvl3TffmgovD5cXG9LUb9EnFM_RJaqWxcrVvsL6d0tNjiisnNcSrmMzEjtYQPac4JiREz86PodSQaTGZrUYMPZuz6I+iJTEQfCVUoSuFv_tgA9EH23NyRgsEU7ohTbvwOg637CfVJExsiXM3gUFXk+iJhLfySUVjkjbKjgCxU_F9koImCIuKDGjamGE6okMczUhrcAtX8c87FakJde+NqyZa0MqgNDqWGz23gJDmZJM2pB5Y_DeljUYpv4Re1NHcSTeugWhBd25ykLBzyKgGuHR2A4T4Cq7moZ6zgGO6BvA9yWt+TJL7AqoOyA+7oF64dPy5m7UY152ikecxe3jycWacLsUQ3QMlMQw5ZLghVhSGahpZrZYqTKGeSY34ldLDPWcTvdrzOErnMSBcsPVIgyE01wVOIvZGtB+Pz6kQ6HYU0sLZ2rMUZ4mJ7hath6UXBLBja2F5oaFALaTV1fgkGgMOXMgv9iTD+II6u9qLUwN7cWKaNOy6yJ+4NrWMXzjLUxSIn3udzEhe_WCUV3t+gsEN8zhu05XrmfE2Szkwn+P86Ss_4UrPzw05uk2UzcH7ulynS5KxOyU9XY0KVeXOPaT2Bv70Hzsv2nLYWSzYI5F2WrvjsJKhJuTPQ9iaE8MBMYju5kBIrxsqLFIZH_xpXXLOkDAb6nqoBLIYMaSuuqNTTiLxc5ljny4N72seKtLVrprGF02Zvuxvk8EUE7Z4BVL37ptuL6dhJA8+f6vMyW4yg7ZjB80mkJyu0JV9+d0ZIl_JZsTEgCKndsWJDTvwVqsZl_W+ysSCiVMSC_4f26QIi+JkW6yx9cyDg0GzyW0np0j56GnTWE3jmKTrVDPxVBaLrq4UD9s5svnUQrrNk0hJdQdW9qWP+OgHjt8nFkO1YFm0WP_VK8BZPN3E4O0HOLSf7i0VJTMMF4KKwIaj56IGSBR8eQ_kLZJN4kC6OAeL_+YkaUP6lCoSonanFDD66wHWl9C9iyr_nlh6ZHhWdnhM0jWEJvLeDeg0oHTSEHmI1EPKoFN3j6QI0KDgOngdAaUvZ2QyGD5uoIVRX1wVXWJTbUk0gHPziCplDVILhpYAcLnFrSjEp0g3FE+LgFXkHTmNHZdJLiJFKDQxSF0cy4g0XkOi3CSn98qeefngdPvJCwcmak+x4IAzBoyybjp20SqkkgiLiBrxj_cw9_fQe2UP5G+e2YW_6rR4t_A94hsI1ky9+Q1DfHtzU0DDwE9objJjjAgZML1UP93I0rXH6JYc0FskLDN6oTNWS8ZY5xDSgDHFjEUUtzJVDZL5VBfZTG3+kU4MdE5YhwYTLiIRfHrHrfFL68TmMisRN3q1JzNUs46IBUHf71Hcfpiq0wPraiXekIosIwo66byuyeAif77tZo3D8zctpmzldcGtj8YzIPWFlGHMPwo0uWnrJBUhsbMDUe3HvEOV8xQBKMfWsjKIDFamHjobluS_WSJehMvmARcQj6sVHNIb5DawYP1BCWEpwPhmo5TtySrnGPe2iK7ck4S1+3i6+efDAUrui+rUwHZB4I_CyuHoIo4K394jQrK7d+zssDjIuDwNmkSpJK4JsSWW+cVvRiGYcoiufAsDvYI9VZBdF_3Tc5Xr3GxNs5zd5bUv2XPCUW5zu8Xh9zmFKYLFY7r54VDTCOFJhsGxI1KtetcbB7PM4K0Y7sPLFWDmaXSX_6o5eVQO_E1yavzGWq1p+CY6T8Bws0K3Lmv2dPguQOFVTolJQVP8vsZkbFdCdjmn7bpJmk6ZzklRkqBaPdTYMDGRxPISt0rtlNL5xTu_O8JWDee7cpoUtW8fMtCBSKrEBE6DJADIArFcS0sAATgXpT42JapHaSY_gI9nV14D+JSx++5_uSCDzxwURBIAQICWpgaIAwjL_I1K_b5YLSYA2F3W6v5MdW9OUWg3MqtM1PRayXVrCm5JOUrr38FDszveLBCvif439cP_GQRQzXesvMaufk+r2h6BdjUhKwMjYQY=';
const LABELS = [];
const SIZES = [0, 24, 42, 63, 104]; // a letter is 0.4 of its size wide: 4.8 of the picture's pixels in the smallest
let labelN = 0;
let scene;
// align: 0 from x · 1 centred on x · 2 ending at x; x and y are in the picture's own pixels
function text(str, x, y, colour, size, align) {
  let t = LABELS[labelN++];
  if (!t) LABELS.push((t = scene.add.text(0, 0, '', { fontFamily: 'V, monospace' })));
  str = String(str);
  size = SIZES[size || 1];
  if (t.text !== str) t.setText(str);
  if (t.size !== size) t.setFontSize((t.size = size)).setStroke('#0c1626', 2.5 + size / 12);
  if (t.ink !== colour) {
    t.ink = colour;
    t.setColor('#' + (((colour & 255) << 16) | (colour & 0xff00) | ((colour >> 16) & 255)).toString(16).padStart(6, '0'));
  }
  t.setOrigin((align || 0) / 2, 0.2).setPosition(x * PX, y * PX).setVisible(true);
}

// The crew's portraits, in pixel art, both in profile and with no outline: Darwin's frog — a
// leaf-green back with a pale edge, a dark stripe through a golden eye, a snout drawn out to a
// point — and the monito del monte — big black eyes in a dark ring, round pink ears, a pink
// nose. Each is 28 dots by 24, row after row: a letter is a colour, a dot is nothing, and a
// number after either repeats it.
const FACES = [
  '.89l6.21lg6l5.15lgG6g5l4.11c8Gg10.9B8c8g8.4B16c8g.3b8B5y3B8c.3b12ywk2yB2o4B.4b12yk3yb2o4.5b3Bb4Bb3yk3ybo3.7bBb2Bb6Bby3o3.9b9Bb3o5.10o7b3o6.12o2Bo10.15o5Bo4.18o7.21o7.19N12.16n14.14n14.14n14.13',
  '.6F.25F5.7F4.11F2p3F2.5F2p2F2.9F2p5F2.4Fp4F.9F2p3PpFf6p4F.9F2p2Pt9f3F.11Fp2t12f2.11F2t10d4f2.11Fft8dk4df2.10F2f2t5dw2k3d2f.9F3f7dwk5df2.8F3f7dk6d2f.8F3f7dk4d5p3.5F3f7d2k4d3p3P.5F3f8d5m4P2p.6F2f3m16.7F2f2m11F4m.9f2m15.12m14.15m12.10N17.11n19.9n19.9n19.8',
].map((s) => s.replace(/(\D)(\d+)/g, (m, c, n) => c.repeat(n)));
const FACE_INK = 'BFGNPbcdfgklmnoptwy';
const FACE_COL = '542e207a4e32429236a8c8e0c86882a05c32ece4b4261a18b07a4c76c4480e1416b2e470f8f0e0e0f0ffce8648f496aad8b07effffffe8be54'.match(/.{6}/g).map((h) => pack(parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4), 16)));
// `flip` turns it to face left
function face(who, x, y, size, flip) {
  for (let i = 0; i < 672; i++) {
    const c = FACE_INK.indexOf(FACES[who][i]);
    if (c >= 0) box(x + (flip ? 27 - (i % 28) : i % 28) * size, y + ((i / 28) | 0) * size, size, size, FACE_COL[c]);
  }
}

// A gauge: a row of lamps, lit up to `share` of the way along, in a dark frame.
function gauge(x, y, w, share, colour, h) {
  const n = (w / 6) | 0;
  box(x - 1, y - 1, n * 6 + 1, (h || 5) + 2, EDGE);
  for (let i = 0; i < n; i++) box(x + i * 6, y, 5, h || 5, i < share * n ? colour : OFF);
}

// A name beside a mark: what it is, and what to do about it.
function tag(str, x, y, colour) {
  const w = str.length * 4.8 + 6;
  text(str, clamp(x, w / 2 + 2, BW - w / 2 - 2), clamp(y, TOP + 2, VB - 13), colour, 1, 1);
}

// A mark for something the pilot cannot see: an arrowhead at the edge of the screen when it is
// out of view, a small frame where it is when it is in view but behind a hill or a cloud. Each
// carries its name plate. A place to go to (`always`) is marked even in plain sight, and says
// how far it is.
function mark(x, y, z, colour, label, always) {
  const dx = x - cam.x;
  const dy = y - cam.y;
  const v = dx * fwdX + dy * fwdY;
  const u = dx * rgtX + dy * rgtY;
  const w = 1 + cam.q * v;
  if (always) label += ' ' + ((Math.hypot(dx, dy) / 5) | 0) * 50 + ' M';
  let sx = CXS + u * 1e3; // behind the camera: it comes in from below
  let sy = BH * 3;
  if (w > 0.15) {
    sx = CXS + (cam.S / w) * u;
    sy = cam.cy - (cam.S / w) * (z - cam.zr + cam.k * v);
    if (sx > 8 && sx < BW - 8 && sy > TOP + 8 && sy < VB - 8) {
      if (always || ZB[(sy | 0) * BW + (sx | 0)] < v - 3) {
        for (let i = 0; i < 4; i++) box(sx + (i & 1 ? 3 : -4), sy + (i & 2 ? 3 : -4), 2, 2, colour);
        tag(label, sx, sy - 18, colour);
      }
      return;
    }
  }
  const mid = (TOP + VB) / 2; // the monitor's own middle and half height
  const half = mid - TOP - 9;
  const ex = sx - CXS;
  const ey = sy - mid;
  const side = Math.abs(ex) * half > Math.abs(ey) * (CXS - 9); // it leaves by the left or right edge
  const k = side ? (CXS - 9) / Math.abs(ex) : half / Math.abs(ey);
  const px = CXS + ex * k;
  const py = mid + ey * k;
  for (let i = -1; i < 14; i++) {
    // the arrowhead, twice: a dark one a size larger, then the coloured one inside it
    const n = i < 8 ? i : i - 8;
    const c = i < 8 ? EDGE : colour;
    const o = i < 8 ? -1 : 0;
    if (side) box(px - Math.sign(ex) * (n + o), py - n, 1, 2 * n + 1, c);
    else box(px - n, py - Math.sign(ey) * (n + o), 2 * n + 1, 1, c);
  }
  if (side) tag(label, px - Math.sign(ex) * (label.length * 2.4 + 12), py - 5, colour);
  else tag(label, px, py - Math.sign(ey) * 13 - 5, colour);
}

// The radar: what is around the crew, nose up, under a sweeping hand.
function radar(cx, cy, R) {
  for (let a = 0; a < TAU; a += 0.02) {
    // a ring, dark outside and pale inside, with nothing behind it
    for (let i = 0; i < 3; i++) box(cx + Math.sin(a) * (R + 1 - i), cy + Math.cos(a) * (R + 1 - i), 1, 1, i ? DIM : EDGE);
  }
  for (let i = 0; i < R; i++) box(cx + Math.sin(now * 3) * i, cy - Math.cos(now * 3) * i, 1, 1, DIM);
  const sx = Math.sin(sq.yaw);
  const sy = -Math.cos(sq.yaw);
  const blip = (t, colour, size) => {
    const dx = t.x - sq.x;
    const dy = t.y - sq.y;
    let px = ((dy * sx - dx * sy) * R) / 170;
    let py = (-(dx * sx + dy * sy) * R) / 170;
    const d = Math.hypot(px, py) / (R - 2);
    if (d > 1) {
      px /= d;
      py /= d;
    }
    box(cx + px - size / 2, cy + py - size / 2, size, size, colour);
  };
  for (const f of fires) blip(f, colFire, 2);
  for (const f of folk) blip(f, INK, 2);
  for (const f of fences) blip(f, colRed, 3);
  for (const s of shots) if (s.k === 1) blip(s, colRed, 1);
  for (const d of drones) blip(d, colRed, d.k ? 3 : 2);
  if (sat) blip(sat, INK, 3);
  crew.forEach((f, i) => blip(f, i ? GOLD : INK, 2));
}

function drawHud() {
  for (const t of LABELS) t.setVisible(false);
  labelN = 0;
  const blink = (now * 2) & 1;
  if (gMode !== PLAY) {
    const over = gMode === OVER;
    text('AÑO 3000 · DRONES DE IA ENEMIGA ATACAN CHILE', CXS, 8, INK, 1, 1);
    text('RANITAS Y MONITOS SÚPER INTELIGENTES PILOTEAN LA DEFENSA', CXS, 21, DIM, 1, 1);
    text(over ? 'FIN DEL VUELO' : 'DARWIN 3000', CXS, 62, INK, 4, 1);
    if (over) text('PUNTAJE ' + gScore + ' · RÉCORD ' + gBest, CXS, 104, GOLD, 2, 1);
    else if (blink) text('START 1: UN JUGADOR · START 2: DOS', CXS, 104, GOLD, 2, 1);
    face(0, 6, BH - 54, 2);
    face(1, BW - 62, BH - 54, 2, 1);
    text('DARWIN', 66, BH - 52, GOLD);
    text('MONITO', BW - 66, BH - 52, GOLD, 1, 2);
    text('PALANCA VOLAR · B1 DISPARO · B2/B3 TONEL', CXS, BH - 40, INK, 1, 1);
    text('B4 IMPULSO · B5 AGUA · VUELA BAJO Y RESCATA', CXS, BH - 28, DIM, 1, 1);
    if (!over) text('RÉCORD ' + gBest, CXS, BH - 16, DIM, 1, 1);
    else if (blink) text('START PARA VOLAR DE NUEVO', CXS, BH - 16, GOLD, 1, 1);
    return;
  }

  const goal = folk[0] || fires[0];

  // top left: score, the multiplier, and how long the crew has kept low
  text('PUNTAJE', 6, 5, DIM);
  if (gAgl < 8) text('VUELO BAJO', 116, 5, GOLD, 1, 2);
  text(String(gScore).padStart(6, '0'), 6, 16, INK, 2);
  text('×' + gMult, 116, 16, gMult > 1 ? GOLD : DIM, 2, 2);
  if (gLow > 0.1) {
    box(5, 32, (gLow / 10) * 110 + 2, 4, EDGE);
    box(6, 33, (gLow / 10) * 110, 2, GOLD);
  }

  // top middle: the job in hand, and how it is done
  const duty = folk[0]
    ? [`ALUVIÓN · ${folk.length} POR RESCATAR`, 'PASA BAJITO SOBRE CADA BALIZA']
    : goal
      ? [`INCENDIO · ${fires.length} FOCOS`, gWater ? 'SUELTA EL AGUA ENCIMA CON B5' : 'MOJA EL BALDE EN EL MAR O UN RÍO']
      : sat
        ? ['SATÉLITE HACKER', 'SUBE A LA ESTRATÓSFERA Y DISPARA']
        : ['PATRULLA', 'DERRIBA DRONES · VUELA BAJO'];
  text(duty[0], CXS, 5, goal || sat ? (blink ? GOLD : INK) : GOLD, 1, 1);
  text(duty[1], CXS, 17, INK, 1, 1);

  // top right: shield, boost (a row each with two aboard) and water
  text('ESCUDO', 288, 5, DIM);
  gauge(328, 7, 66, gShield / 100, gShield < 30 ? colRed : INK);
  text('IMPULSO', 288, 16, DIM);
  crew.forEach((f, i) => gauge(328, 18 + i * 4, 66, f.stam / 100, i ? GOLD : INK, crew[1] ? 2 : 5));
  text('AGUA', 288, 27, DIM);
  box(327, 28, 67, 7, EDGE);
  for (let i = 0; i < 3; i++) box(328 + i * 22, 29, 21, 5, i < gWater ? WATER : OFF);

  // bottom left: height — the ground rising from the foot of the scale, the cloud base and
  // the stratosphere ruled across it, and the crew
  const foot = BH - 6;
  const rung = (z) => foot - Math.sqrt(clamp(z, 0, CEILING) / CEILING) * 42;
  box(5, foot - 43, 6, 44, EDGE);
  box(6, foot - 42, 4, 42, OFF);
  box(6, rung(gGnd), 4, foot - rung(gGnd), DIM);
  box(4, rung(CA), 8, 1, INK);
  box(4, rung(STRATO), 8, 1, INK);
  crew.forEach((f, i) => box(3, rung(f.z) - 1, 10, 2, i ? GOLD : INK));
  text('ALTURA', 18, BH - 47, DIM);
  text((gAgl * 10) | 0, 18, BH - 37, INK, 2);
  text('METROS', 18, BH - 17, DIM);

  // bottom middle: the radio — whoever is talking and the line as far as it has been said —
  // or, with the radio quiet, what the buttons do
  if (talk[1]) {
    face(talk[0], 66, BH - 54, 2);
    text(talk[0] ? 'MONITO' : 'DARWIN', 128, BH - 52, GOLD);
    text(talk[1].slice(0, talkT * 40), 128, BH - 38, INK);
  } else {
    if (!crew[1] && blink) text('START 2: SE SUMA EL MONITO', CXS, BH - 29, GOLD, 1, 1);
    text('B1 DISPARO · B2/B3 TONEL · B4 IMPULSO · B5 AGUA', CXS, BH - 16, DIM, 1, 1);
  }
  radar(BW - 30, BH - 30, 24);

  if (gShield < 30 && (now * 4) & 1) {
    // little shield left: the frame flashes
    box(0, 0, BW, 2, colRed);
    box(0, BH - 2, BW, 2, colRed);
    box(0, 0, 2, BH, colRed);
    box(BW - 2, 0, 2, BH, colRed);
  }
  // with two aboard, each flyer wears its number
  if (crew[1]) for (const f of crew) if (project(f.x, f.y, f.z + 2.4)) text(f.id + 1, prX, prY - 8, f.id ? GOLD : INK, 1, 1);

  // what is going on, across the top of the picture
  if (gHacked) {
    text('¡HACKEADO!', CXS, 48, colRed, 3, 1);
    text('AGITA LA PALANCA Y MACHACA B1', CXS, 74, INK, 1, 1);
    gauge(CXS - 78, 88, 156, gPurge, INK);
  } else if (gChan > 0) {
    text('HACKEO ENTRANTE: TONEL O DISPARA', CXS, 48, colRed, 2, 1);
    gauge(CXS - 78, 66, 156, gChan, colRed);
  } else if (gMsgT > 0) text(gMsg, CXS, 48, INK, gMsg.length > 30 ? 1 : 2, 1);

  // marks: what cannot be seen and where to go, each with what to do
  for (const d of drones) mark(d.x, d.y, d.z, colRed, d.k ? 'HACKER' : 'DRON');
  for (const f of fences) mark(f.x, f.y, (f.z0 + f.z1) / 2, colRed, 'LÁSER: TONEL');
  if (sat) mark(sat.x, sat.y, sat.z, INK, 'SATÉLITE: SUBE', 1);
  if (folk[0]) mark(goal.x, goal.y, goal.z + 4, INK, 'RESCATE: PASA BAJITO', 1);
  else if (goal) mark(goal.x, goal.y, goal.z + 4, colFire, gWater ? 'FUEGO: SUELTA B5' : 'FUEGO', gWater);
  if (wet) mark(wet.x, wet.y, wet.z + 3, INK, 'AGUA: MOJA EL BALDE', 1);
}

function drawFrame() {
  fwdX = Math.sin(cam.yaw);
  fwdY = -Math.cos(cam.yaw);
  rgtX = -fwdY;
  rgtY = fwdX;
  invMs = 1 / MODEL_SCALE;
  sunR = LIGHT[0] * rgtX + LIGHT[1] * rgtY;
  sunU = LIGHT[2];
  sunC = -(LIGHT[0] * fwdX + LIGHT[1] * fwdY);
  const alive = gMode !== OVER;

  nSJ = 0;
  if (alive) {
    for (const f of crew) {
      const o = nSJ++ * 6;
      SJ[o] = f.x - cam.x;
      SJ[o + 1] = f.y - cam.y;
      SJ[o + 2] = f.z;
      SJ[o + 3] = Math.cos(f.yaw);
      SJ[o + 4] = Math.sin(f.yaw);
      SJ[o + 5] = invMs / Math.max(0.22, Math.abs(Math.cos(f.bank + f.roll)));
    }
  }

  drawWorld();
  drawSky();
  if (alive) {
    for (const f of crew) {
      if (f.inv > 0 && (now * 12) & 1) continue; // it blinks while it is safe from harm
      drawFlyer(f);
    }
  }
  drawThings();
  if (alive) crew.forEach(drawTrails);
  drawPuffs();
  if (gMode === PLAY && !gHacked) crew.forEach(drawSight);
  if (gHacked || gChan > 0.4) glitch(gHacked ? 1 : gChan * 0.5);
  if (gFlash > 0.02) {
    const a = (gFlash * 200) | 0;
    for (let p = 0; p < FB.length; p++) FB[p] = mix(FB[p], colTrail, a);
  }
  drawHud();
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

// The game starts once its typeface is ready (or cannot be had: then the system's will do).
const start = () => new Phaser.Game(config);
const type = new FontFace('V', Uint8Array.from(atob(FONT.replace(/_/g, '/')), (c) => c.charCodeAt(0)));
document.fonts.add(type);
type.load().then(start, start);

let frameTex;
let frameData;
let drawMs = 0;

function create() {
  frameTex = this.textures.createCanvas('frame', BW, BH);
  frameData = frameTex.context.createImageData(BW, BH);
  FB = new Uint32Array(frameData.data.buffer);
  this.add.image(0, 0, 'frame').setOrigin(0).setScale(PX);

  scene = this;
  AC = this.sound.context || null;
  buildPalettes();
  buildModel(0);
  buildModel(1);
  lead.m = MODELS[0];
  mate.m = MODELS[1];
  buildWorld(SEED);
  resetFlight();
}

function update(time, delta) {
  if (gMode !== PLAY && gT > 1 && (pressed.START1 || pressed.START2 || pressed.P1_1)) startGame(pressed.START2);

  simulate(Math.min(delta / 1000, 0.05));
  sound();
  const t0 = performance.now();
  drawFrame();
  drawMs += (performance.now() - t0 - drawMs) * 0.1;
  frameTex.context.putImageData(frameData, 0, 0);
  frameTex.refresh();

  for (const key in pressed) pressed[key] = false;
}
})();
