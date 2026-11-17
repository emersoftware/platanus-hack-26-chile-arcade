// 2075
//
// A small software renderer shown through Phaser 3. Everything is drawn into one low-resolution
// pixel buffer and scaled up with hard pixels:
//   · the world is a height and a colour per ground cell, blended into smooth slopes
//   · the flyer — a fighter with a condor's markings — is a stack of voxel slices that can yaw, bank,
//     pitch and roll
//   · clouds are a second, floating layer of domes that casts soft shadows
// The camera follows from behind and a little above.

let GAME_WIDTH = 800;
let GAME_HEIGHT = 600;

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
// Declarations are `let` throughout, never `const`: a minifier that keeps `const` as written
// would spend two more bytes on every one.
(() => {
// ───────────────────────────────────────────────────────────── tunables

// flight
let SPEED = 31; // world units per second
let BOOST = 1.8; // × speed while the thruster is held
let TURN_RATE = 1.25; // radians per second at full stick
let BANK_ANGLE = 52; // degrees of bank in a full turn
let CLIMB_RATE = 22; // world units per second at full stick
let INVERT_Y = true; // the stick flies like an aircraft's: pull back (down) to climb, push forward to dive
let CRUISE_ALT = 22;
let CEILING = 330; // the top of the stratosphere
let ROLL_TIME = 0.8; // seconds for a barrel roll
let ROLL_SLIDE = 11; // how far a barrel roll carries the condor sideways
// model: small against the land, so the valley is wide and the cordillera towers
let MODEL_SCALE = 0.2; // world units per design unit
// camera
let CHASE_Y = 0.6; // where the condor sits on screen, top to bottom
let CHASE_FOLLOW = 7; // how quickly the camera swings round behind the condor …
let CHASE_SLIDE = 5; // … and how quickly it catches up when the condor moves sideways
let CHASE_DIST = 2.6; // camera distance, in model lengths
let CHASE_ELEV = 12; // camera height above the condor, degrees
let CHASE_WIDTH = 0.27; // wingspan as a share of the screen
// world
let SEED = 3000;
let CLOUDS = 0.45;

// ───────────────────────────────────────────────────────────── constants

let PX = 2; // screen pixels per buffer pixel
let RS = 3 / PX; // sizes below were drawn for three; this scales them
let BW = Math.ceil(GAME_WIDTH / PX);
let BH = Math.ceil(GAME_HEIGHT / PX);
let CXS = BW >> 1;

// The world is a strip of Chile: sea to the west, then the coastal hills, the central valley
// and the cordillera. It repeats north–south; east–west it just goes on (open sea one way,
// a high snowfield the other).
let N = 1024; // map size in cells
let NM = N - 1;
let NS = 10;
let BIG = 1 << 20; // keeps world coordinates positive (a multiple of N)
let COAST = 0.13; // where the sea ends, as a share of the map from the west
let HMAX = 127; // tallest peak
let SNOWFIELD = 100; // height the far east levels off at
let CA = 60; // cloud base altitude
let CK = 5; // thickest cloud
let BLEND_M = 2.5; // cells drawn larger than this many pixels are blended with their neighbours
let CLOUD_SOFT = 3.2; // thinner than this, a cloud is see-through
let ZTOP = HMAX + 2; // the tallest thing in the world

let VIEW_DIST = 700; // how far the eye reaches at ground level; from higher up it sees further
let FOG_N = 24;
let STRATO = 110; // where the sky starts to darken …
let SPACE = 300; // … and where it is all but black
let NEAR_W = 0.4; // nearest thing drawn, as a share of the camera distance
let DV_MIN = 1.5; // depth step limits, in screen pixels of ground
let DV_MAX = 3;
let EMPTY = 1e9;
let TAKEN = 1e8;

let SUN_X = 0.42; // where a shadow falls, per unit of height (east, south)
let SUN_Y = 0.34;
let SUN_AZ = -Math.PI * 0.25 - 0.1; // the sun sits opposite the shadows
let SUN_ELEV = 0.4;
let LIGHT = norm3(-0.5, -0.45, 0.74);

let TAU = Math.PI * 2;

// ───────────────────────────────────────────────────────────── helpers

function norm3(x, y, z) {
  let l = Math.hypot(x, y, z);
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
  let u = 255 - t;
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
  let out = new Float32Array(N * N);
  let amp = 1;
  for (let o = 0; o < octaves; o++, cell >>= 1, amp *= 0.5) {
    let g = N / cell;
    let lat = new Float32Array(g * g);
    for (let i = 0; i < lat.length; i++) lat[i] = rnd();
    for (let y = 0; y < N; y++) {
      let gy = y / cell;
      let y0 = gy | 0;
      let ty = gy - y0;
      let sy = ty * ty * (3 - 2 * ty);
      let r0 = (y0 % g) * g;
      let r1 = ((y0 + 1) % g) * g;
      let p = y * N;
      for (let x = 0; x < N; x++, p++) {
        let gx = x / cell;
        let x0 = gx | 0;
        let tx = gx - x0;
        let sx = tx * tx * (3 - 2 * tx);
        let c0 = x0 % g;
        let c1 = (x0 + 1) % g;
        let a = lat[r0 + c0] + (lat[r0 + c1] - lat[r0 + c0]) * sx;
        let b = lat[r1 + c0] + (lat[r1 + c1] - lat[r1 + c0]) * sx;
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
  let k = 1 / (hi - lo);
  for (let i = 0; i < out.length; i++) out[i] = (out[i] - lo) * k;
  return out;
}

// The value below which `share` of the field lies.
function levelFor(field, share) {
  let hist = new Uint32Array(2048);
  for (let i = 0; i < field.length; i++) hist[(field[i] * 2047) | 0]++;
  let target = field.length * share;
  let acc = 0;
  let s = 0;
  while (s < 2047 && acc + hist[s] < target) acc += hist[s++];
  return s / 2047;
}

// ───────────────────────────────────────────────────────────── input

let KEY_TO_ARCADE = {};
for (let [code, keys] of Object.entries(CABINET_KEYS)) {
  for (let key of keys) KEY_TO_ARCADE[normalizeKey(key)] = code;
}

function normalizeKey(key) {
  return key.length === 1 ? key.toLowerCase() : key;
}

let held = Object.create(null);
let pressed = Object.create(null);

window.addEventListener('keydown', (e) => {
  let code = KEY_TO_ARCADE[normalizeKey(e.key || '')];
  if (!code) return;
  if (!held[code]) pressed[code] = true;
  held[code] = true;
});
window.addEventListener('keyup', (e) => {
  let code = KEY_TO_ARCADE[normalizeKey(e.key || '')];
  if (code) held[code] = false;
});

// ───────────────────────────────────────────────────────────── palettes

// CÓNDOR's own colours — a ramp of blues from deep navy through ice to white, and red — are
// kept for the flyer, the clouds and the sky. The ground has its own gradient, below.
let BLUES = [
  [42, 69, 96],
  [74, 111, 144],
  [112, 149, 184],
  [168, 200, 224],
  [224, 240, 255],
  [255, 255, 255],
];
let REDS = [
  [204, 51, 51],
  [255, 0, 64],
  [255, 68, 68],
];
let SKY_TOP = [36, 104, 214];
let SKY_LOW = [168, 212, 248];

let NR = 76; // steps in the ramp: 15 between each pair of blues
let WHITE = NR - 1;
let SHADOW = 13; // how many ramp steps a full shadow takes off a cloud
let CLOUD_LOW = 50; // the foot of a cloud's side
let CLOUD_UNDER = 44; // a cloud seen from below
let RAMP = [];
for (let i = 0; i < NR; i++) {
  let t = (i / (NR - 1)) * (BLUES.length - 1);
  let n = Math.min(t | 0, BLUES.length - 2);
  let a = BLUES[n];
  let b = BLUES[n + 1];
  RAMP.push([0, 1, 2].map((k) => Math.round(a[k] + (b[k] - a[k]) * (t - n))));
}

let PAL = new Uint32Array((FOG_N + 1) * NR); // [haze step][ramp step]

// The ground's colours, from the sea floor up to the snow: a place along this gradient, lit or
// shaded, gives every colour the land and the water take.
let GROUND = [
  [0, 26, 60, 106],
  [8, 44, 102, 150],
  [14, 84, 160, 190],
  [17, 240, 248, 250],
  [20, 214, 210, 198],
  [22, 150, 112, 78], // bare earth, and a river in flood
  [23, 112, 154, 84], // the green of a river's banks
  [24.5, 168, 178, 106], // grass going dry
  [30, 132, 152, 90],
  [36, 110, 124, 82],
  [38.5, 52, 88, 50], // forest
  [42, 86, 118, 142],
  [48, 112, 149, 184],
  [54, 168, 200, 224],
  [59, 224, 240, 255],
  [63, 255, 255, 255],
];
let GS = 4; // gradient places stored per unit above, so wide slopes of colour stay smooth
let NG = 63 * GS + 1;
let G_SHALLOW = 14;
let G_SURF = 17;
let G_SAND = 20;
let NL = 32; // light levels
let LIT_FLAT = 16; // level ground in the open
let LIT_SHADOW = 7; // how many levels a full shadow takes off
let GPAL = new Uint32Array((FOG_N + 1) * NG * NL); // [haze step][gradient place][light]

// What the flyer is made of. Each material runs from its colour in shadow to its colour in
// full sun (NLIT steps), then on towards white where it glints.
let BODY = 1;
let PLUME = 2;
let HEAD = 3;
let GLASS = 4;
let ENGINE = 5;
let GLOW = 6; // the hot ring of a nozzle: always bright
let MATERIALS = [
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
let NMAT = MATERIALS.length;
// The flyers' own colours, the same as their portraits': back, the line along its edge, trim,
// eyes, engines, the glow of the nozzles, the stripe down the side, and the belly.
// Darwin's frog has a leaf-green back edged in cream, a dark brown stripe, an orange-brown
// belly and golden eyes; the monito is brown with a tan edge, darker sides, a cream belly,
// pink ears and nose, and black eyes.
let ICE = [42, 69, 96, 42, 69, 96]; // a nozzle: navy round the white of the flame
let SKINS = [
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
let FIRE = 7;
let MUD = 8;
let SIDE = 7; // on a flyer these two are its stripe and its belly instead
let BELLY = 8;
let GLINT = [0, 4, 5, 6, 14, 3, 0, 0, 1]; // how strongly each catches a highlight
let NLIT = 16;
let NLV = 24;
let JPAL = new Uint32Array(3 * NMAT * NLV); // [the things' colours · the frog's · the monito's][material][light]
let colOutline = pack(RAMP[0][0], RAMP[0][1], RAMP[0][2]);
let colTrail = pack(255, 255, 255);
let colSmoke = pack(RAMP[47][0], RAMP[47][1], RAMP[47][2]);
let colSun = pack(255, 255, 255);
let colHaze = pack(SKY_LOW[0], SKY_LOW[1], SKY_LOW[2]);

function buildPalettes() {
  for (let f = 0; f <= FOG_N; f++) {
    let haze = (f / FOG_N) * 0.94;
    for (let c = 0; c < NR; c++) {
      let s = RAMP[c];
      PAL[f * NR + c] = pack(
        (s[0] + (SKY_LOW[0] - s[0]) * haze) | 0,
        (s[1] + (SKY_LOW[1] - s[1]) * haze) | 0,
        (s[2] + (SKY_LOW[2] - s[2]) * haze) | 0,
      );
    }
  }
  for (let g = 0; g < NG; g++) {
    let n = 0;
    let at = g / GS;
    while (GROUND[n + 1][0] < at) n++;
    let a = GROUND[n];
    let b = GROUND[n + 1];
    let t = (at - a[0]) / (b[0] - a[0]);
    for (let l = 0; l < NL; l++) {
      // light scales the colour; shade leans a little towards blue
      let k = 0.5 + l / 32;
      let cool = k < 1 ? 1 - k : 0;
      let r = (a[1] + (b[1] - a[1]) * t) * (k - cool * 0.1);
      let gg = (a[2] + (b[2] - a[2]) * t) * k;
      let bl = (a[3] + (b[3] - a[3]) * t) * (k + cool * 0.25);
      for (let f = 0; f <= FOG_N; f++) {
        let haze = (f / FOG_N) * 0.94;
        GPAL[(f * NG + g) * NL + l] = pack((r + (SKY_LOW[0] - r) * haze) | 0, (gg + (SKY_LOW[1] - gg) * haze) | 0, (bl + (SKY_LOW[2] - bl) * haze) | 0);
      }
    }
  }
  for (let m = 0; m < 3 * NMAT; m++) {
    let skin = SKINS[((m / NMAT) | 0) - 1];
    let c = (skin && skin[(m % NMAT) - 1]) || MATERIALS[m % NMAT];
    for (let l = 0; l < NLV; l++) {
      let t = Math.min(1, l / (NLIT - 1));
      let up = l < NLIT ? 0 : ((l - NLIT + 1) / (NLV - NLIT)) * 0.75; // towards white
      let r = c[0] + (c[3] - c[0]) * t;
      let g = c[1] + (c[4] - c[1]) * t;
      let b = c[2] + (c[5] - c[2]) * t;
      JPAL[m * NLV + l] = pack((r + (255 - r) * up) | 0, (g + (255 - g) * up) | 0, (b + (255 - b) * up) | 0);
    }
  }
}

// ───────────────────────────────────────────────────────────── world

let H = new Uint8Array(N * N); // height of each ground cell, in half units
let HM = new Uint8Array((N >> 4) * (N >> 4)); // the tallest ground in and around each 16 × 16 block
let GR = new Uint8Array(N * N); // its colour, as a place along the ground gradient
let LIT = new Uint8Array(N * N); // how much light it catches (LIT_FLAT on level ground)
let R8 = new Uint8Array(N * N); // a random byte per cell (sparkle timing)
// The same three, smoothed: far away, where a cell is smaller than a pixel, the renderer reads
// these, so that a distant range is a clean line and not a comb of needles.
let HF;
let GF;
let LF;
function soften(src) {
  let rows = new Uint16Array(N * N);
  let out = new Uint8Array(N * N);
  for (let i = 0; i < N * N; i++) {
    let x = i & NM;
    for (let d = -2; d <= 2; d++) rows[i] += src[i - x + clamp(x + d, 0, NM)];
  }
  for (let i = 0; i < N * N; i++) {
    let sum = 0;
    for (let d = -2; d <= 2; d++) sum += rows[(i + d * N) & (N * N - 1)];
    out[i] = sum / 25;
  }
  return out;
}
let RIPPLE = Int8Array.from({ length: 32 }, (v, i) => Math.round(Math.sin(i * 0.196) * 2.4)); // a swell on the water
let GRAIN = new Float32Array(4096); // fine speckle laid over the ground close by, so it has a grain to rush past
for (let i = 0; i < 4096; i++) GRAIN[i] = ((hash2(i & 63, i >> 6, 9) & 255) / 255 - 0.5) * 2.4;
let CT = new Uint8Array(N * N); // cloud thickness per cell, in sixteenths
let CTONE = new Uint8Array(N * N); // the tone of the cloud's top there

function smooth(a, b, v) {
  let t = clamp((v - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}

// How much light a slope catches (0.74 on the flat), from how fast it rises east and south.
function lightOn(gx, gy) {
  return (0.5 * gx + 0.45 * gy + 0.74) / Math.sqrt(gx * gx + gy * gy + 1);
}

function buildWorld(seed) {
  let rnd = makeRng(seed);
  let broad = fbm(256, 5, rnd);
  let fine = fbm(64, 4, rnd);
  let rough = fbm(128, 3, rnd);
  let E = new Float32Array(N * N); // elevation
  let burnt = new Uint8Array(N * N); // where a fire went through, years ago
  QUEB.length = 0;

  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      let i = (y << NS) | x;
      let r = hash2(x, y, seed);
      let jit = ((r >>> 8) & 255) / 255 - 0.5;
      let n = broad[i];
      let f = fine[i];
      // how far east this cell is; the noise bends the coast and the ranges
      let u = x / N + (n - 0.5) * 0.07 + (f - 0.5) * 0.012;
      // rivers run west from the cordillera to the sea, five to a lap of the map, each in a
      // ravine it has cut through the ranges; `cut` is how far this cell is from the nearest
      let lane = (y / N) * 5 + (n - 0.5) * 1.6 + (f - 0.5) * 0.12;
      let cut = Math.abs(lane - Math.round(lane));
      let e = 0;
      let g;
      if (x < 2 || u < COAST) {
        let d = x < 2 ? 1 : (COAST - u) / COAST;
        g = d < 0.02 ? G_SURF : G_SHALLOW * (1 - smooth(0, 0.6, d)); // surf, then deeper water
      } else {
        let ridge = 1 - Math.abs(2 * rough[i] - 1);
        let hills = Math.exp(-(((u - 0.21) / 0.04) ** 2)) * (4 + 44 * f * (0.35 + 0.65 * ridge)); // the coastal range
        let rise = smooth(0.5, 0.8, u);
        let peaks = rise * (26 + 100 * Math.pow(ridge, 1.5) * (0.5 + 0.5 * n) + (f - 0.5) * 12); // the cordillera
        let edge = smooth(0.93, 0.995, x / N); // far east: level off into a high snowfield
        e = 3 + 2 * n + hills + peaks;
        let bed = 2.5 + rise * 22; // the ground falls away into the ravine, down to the river
        if (e > bed) e = bed + (e - bed) * smooth(0.024, 0.14, cut);
        e = clamp(e + (SNOWFIELD - e) * edge, 0.5, HMAX) * smooth(-0.004, 0.03, u - COAST); // the land comes up out of the sea
        if (cut < 0.004 && u > 0.43 && u < 0.47 && r % 5 === 0) QUEB.push(i);

        // colour by height: dry grass low down, then blue-grey rock and snow
        if (u - COAST < 0.012) g = G_SAND;
        else if (cut < 0.024 && edge < 0.01) g = G_SHALLOW - 2; // river
        else {
          g = e < 6 ? 24 + e * 0.7 : e < 34 ? 28 + (e - 6) * 0.36 : e < 90 ? 38 + (e - 34) * 0.29 : 54 + (e - 90 + jit * 4) * 0.5;
          if (e < 34) g += (f - 0.5) * 7 + (rough[i] - 0.5) * 5; // lighter and darker stretches of it
          if (cut < 0.042 && e < 9) g = 23 + jit * 0.6; // it is green along the rivers …
          // … except where an old flood left its gravel and mud: bars along the banks, and a
          // fan where each river comes out of the cordillera
          let bar = cut < (u > 0.44 && u < 0.52 ? 0.11 : 0.055) && e < 12 && rough[(i + 91001) & (N * N - 1)] > 0.54;
          if (bar) g = 21 + jit;
          // forests: over the hills and in patches across the valley, clear of the rivers and
          // the beach; their canopy stands a little proud of the ground, and uneven
          if (!bar && e > 3.4 && e < 40 && cut > 0.045 && u - COAST > 0.03 && rough[(i + 300517) & (N * N - 1)] > (e > 9 ? 0.43 : 0.56)) {
            if (fine[(i + 500009) & (N * N - 1)] > 0.62) {
              // an old burn: dark bare ground where the forest was, and a few dead trunks
              g = 35.5 + jit;
              burnt[i] = 1;
              if (r % 7 === 0) e += 1.6;
            } else {
              g = 38.5 + jit * 2;
              e += 1.3 + jit * 1.8;
            }
          }
        }
        g += (63 - g) * edge;
      }
      E[i] = e;
      GR[i] = clamp(Math.round(g * GS), 0, NG - 1);
      R8[i] = r & 255;
    }
  }

  // The high ground is rounded off, in three passes each wider than the last: bare needles
  // and knife edges of rock read badly from the valley.
  for (let d of [2, 4, 6]) {
    let raw = E.slice();
    for (let i = 6 * N; i < N * N - 6 * N; i++) {
      if (raw[i] > 30) E[i] += ((raw[i - d] + raw[i + d] + raw[i - d * N] + raw[i + d * N]) / 4 - raw[i]) * smooth(30, 55, raw[i]);
    }
  }

  // Bake the light each cell catches from the way its slope faces.
  for (let y = 0; y < N; y++) {
    let up = ((y - 1) & NM) << NS;
    let dn = ((y + 1) & NM) << NS;
    for (let x = 0; x < N; x++) {
      let i = (y << NS) | x;
      let gx = (E[(y << NS) | Math.min(x + 1, NM)] - E[(y << NS) | Math.max(x - 1, 0)]) * 0.5;
      let gy = (E[dn | x] - E[up | x]) * 0.5;
      H[i] = Math.round(E[i] * 2);
      LIT[i] = clamp(Math.round(LIT_FLAT + (lightOn(gx, gy) - 0.74) * 30), 0, NL - 1) >> burnt[i]; // charred ground is dark
    }
  }

  HF = soften(H);
  LF = soften(LIT);

  // The tallest ground in each block and the blocks around it, so the renderer can tell
  // cheaply that nothing at a spot can reach into view.
  let B = N >> 4;
  let top = new Uint8Array(B * B);
  for (let i = 0; i < N * N; i++) {
    let b = ((i >> NS) >> 4) * B + ((i & NM) >> 4);
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
  let puff = fbm(64, 4, rnd);
  let cover = clamp(CLOUDS * 0.36, 0, 0.9);
  let thr = levelFor(puff, 1 - cover);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      // the noise is squeezed north–south, which draws the clouds out into long streaks
      let t = (puff[(((y * 3) & NM) << NS) | x] - thr) / (1 - thr);
      let i = (y << NS) | x;
      E[i] = t > 0 && cover > 0 ? CK * Math.pow(t, 0.6) : 0;
      CT[i] = Math.min(255, Math.round(E[i] * 16));
    }
  }
  for (let y = 0; y < N; y++) {
    let up = ((y - 1) & NM) << NS;
    let dn = ((y + 1) & NM) << NS;
    for (let x = 0; x < N; x++) {
      let i = (y << NS) | x;
      let gx = (E[(y << NS) | ((x + 1) & NM)] - E[(y << NS) | ((x - 1) & NM)]) * 0.5;
      let gy = (E[dn | x] - E[up | x]) * 0.5;
      CTONE[i] = clamp(Math.round(62 + E[i] * 3 + (lightOn(gx, gy) - 0.74) * 22), CLOUD_LOW + 2, WHITE);
    }
  }
  GF = soften(GR);
}

function groundAt(x, y) {
  return H[((Math.floor(y) & NM) << NS) | clamp(Math.floor(x), 0, NM)] * 0.5;
}

// ───────────────────────────────────────────────────────────── model

// The flyers are fighters in the likeness of two animals of the southern forests: Darwin's
// frog (player one) and the monito del monte (player two). Both share one airframe, sculpted
// in voxels — a delta wing, twin fins and engines — and differ in the
// head: the frog has two bulging eyes and a long pointed snout; the monito a round head with
// big dark eyes, round ears and a pink nose, and a thick tail behind. The shape is described
// once, in design units (MW across the wings, ML nose to tail, MH tall), and cut into MK voxels
// per unit. Each voxel on the surface remembers which way it faces and how tucked-in it is,
// so it can be lit as a solid thing.
let MW = 47;
let ML = 49;
let MH = 13;
let MK = 2; // voxels per design unit
let GW = MW * MK;
let GL = ML * MK;
let GH = MH * MK;
let MCX = 23; // centre line
let MPJ = 26; // pivot, along the body
let MPK = 4; // pivot height (wing level)
let WING_ROOT = 5; // parts further out than this bend with the wings
// points on the model, in design units from the pivot: across, towards the nose, up
let NOZZLES = [
  [-3, MPJ - 48, 0.5],
  [3, MPJ - 48, 0.5],
];
let WINGTIPS = [
  [-21, MPJ - 38.5, 0],
  [21, MPJ - 38.5, 0],
];

let MODELS = [];
let MASK = new Uint8Array(MW * ML); // a flyer from above, for its shadow on the ground
let NQ = new Float32Array(4096 * 3); // the directions a surface can face, 16 steps a side

function inEll(x, y, z, rx, ry, rz) {
  return (x / rx) ** 2 + (y / ry) ** 2 + (z / rz) ** 2 <= 1;
}

// What flyer `who` is made of at a point: x across from the centre line, y back from the
// nose, z up. 0 is empty air.
function partAt(x, y, z, who) {
  let d = Math.abs(x);
  if (who > 2) {
    // the monito's portrait: a round head with big black eyes in a dark ring, round pink ears,
    // a short muzzle and a pink nose
    if (inEll(d - 4.6, y - 18.6, z - 7.8, 2.6, 2.3, 2.6)) return GLASS;
    if (inEll(d - 4.9, y - 19.6, z - 7.5, 3.5, 2.7, 3.4)) return ENGINE;
    if (inEll(x, y - 10, z - 5.2, 1.5, 1.4, 1.3) || inEll(d - 6.8, y - 27, z - 10.6, 3, 1.3, 2.4)) return HEAD;
    return inEll(x, y - 24, z - 6.3, 7.5, 8.5, 6.2) || inEll(x, y - 14.5, z - 4.8, 3.4, 5, 2.9) ? BODY : 0;
  }
  if (who > 1) {
    // Darwin's portrait: a flat, wide head drawn out into a pointed snout, golden eyes
    // standing up at its sides
    if (inEll(d - 7.97, y - 22.5, z - 9.45, 1.35, 1.53, 1.35)) return ENGINE;
    if (inEll(d - 6.8, y - 22.5, z - 9, 2.43, 2.7, 2.43)) return GLASS;
    return inEll(x, y - 27, z - 5.6, 9.7, 9.5, 5.2) || inEll(x, y - 17, z - 5.5, 5.4, 8, 2.4) || inEll(x, y - 9.5, z - 6.7, 1.8, 3.6, 1.13) ? BODY : 0;
  }
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
    let top = Math.min(11.5, 6.5 + (y - 35.5) * 0.9);
    if (z < top && Math.abs(d - (3 + (z - 6) * 0.45)) < 0.55) return z > 8.6 && z > top - 1.6 ? HEAD : BODY;
  }
  if (d < 22.5) {
    // one delta wing: its leading edges run straight back from the nose to the tips, so from
    // above the flyer is a triangle; thick at the root and thin at the tips
    let le = 7 + d * 1.45;
    let te = 41 - d * 0.1;
    if (y > le && y < te) {
      let along = (y - le) / (te - le);
      let half = Math.max(0.5, (0.45 + 1.5 * (1 - d / 22)) * Math.sqrt(4 * along * (1 - along)));
      if (Math.abs(z - 4.2) < half) return d > 4.5 && d < 17 && y > te - 5 && y < te - 2 ? PLUME : BODY;
    }
  }
  return 0;
}

function buildModel(who) {
  let grid = new Uint8Array(GW * GL * GH); // the whole block, for casting the flyer's shadows on itself
  let at = (i, j, k) => (i < 0 || j < 0 || k < 0 || i >= GW || j >= GL || k >= GH ? 0 : grid[(k * GL + j) * GW + i]);
  for (let k = 0; k < GH; k++) {
    for (let j = 0; j < GL; j++) {
      for (let i = 0; i < GW; i++) {
        let v = partAt((i + 0.5) / MK - 0.5 - MCX, (j + 0.5) / MK - 0.5, (k + 0.5) / MK - 0.5, who);
        grid[(k * GL + j) * GW + i] = v;
        if (v && who < 2) MASK[((j / MK) | 0) * MW + ((i / MK) | 0)] = 1;
      }
    }
  }
  for (let q = 0; q < 4096; q++) {
    let x = (q & 15) - 7.5;
    let y = ((q >> 4) & 15) - 7.5;
    let z = (q >> 8) - 7.5;
    let l = Math.hypot(x, y, z);
    NQ[q * 3] = x / l;
    NQ[q * 3 + 1] = y / l;
    NQ[q * 3 + 2] = z / l;
  }

  // keep only the voxels that can be seen
  let a = [];
  let b = [];
  let c = [];
  let w = [];
  let col = [];
  let ni = [];
  let ao = [];
  let hot = [];
  let gi = [];
  let gj = [];
  let gk = [];
  let used = new Set();
  for (let k = 0; k < GH; k++) {
    for (let j = 0; j < GL; j++) {
      for (let i = 0; i < GW; i++) {
        let v = at(i, j, k);
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
        let l = Math.hypot(nx, ny, nz);
        if (l < 0.5) nz = 1;
        let s = 7.5 / (l < 0.5 ? 1 : l);
        let q = Math.round(nx * s + 7.5) | (Math.round(ny * s + 7.5) << 4) | (Math.round(nz * s + 7.5) << 8);
        let share = full / 125;
        let x = (i + 0.5) / MK - 0.5 - MCX;
        let y = (j + 0.5) / MK - 0.5;
        let z = (k + 0.5) / MK - 0.5;
        a.push(x);
        b.push(MPJ - y);
        c.push(z - MPK);
        w.push(y < 42 && z < 6 ? Math.max(0, Math.abs(x) - WING_ROOT) : 0);
        // the body is coloured like the animal: its back on what faces up, then the pale line,
        // the stripe down its sides, and its belly underneath
        let up = l < 0.5 ? 1 : nz / l;
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

let TRAIL_N = 72; // points kept per wingtip
let TRAIL_STEP = 1; // world units between them
let PUFF_N = 240; // smoke, fire, spray and dust: all the soft round things
let PUFF_F = 10;

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
    hard: 0, // how long the stick has been held over one way: the turn tightens with it
    lift: 0,
    rollT: 0,
    rollDir: 1,
    flex: 0.02, // how far the wings are bent up
    stam: 100, // boost left for the burners
    dash: 0, // seconds of dash still to run
    rest: 0,
    kick: 0, // the bounce off the ground
    sc: 0, // what this one has scored
    graze: 0, // counts down after a touch of the ground: forgiven at first, then not
    inv: 0, // seconds of safety after a hit
    fireCd: 0,
    lock: null, // what its guns are tracking
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

let lead = makeFlyer(0);
let mate = makeFlyer(1);
let crew = [lead]; // who is flying: Darwin alone, or with the monito once player two joins
let sq = { x: 0, y: 0, z: 0, yaw: 0 }; // the squad: the point the crew fly about, which the camera follows
let puffs = new Float32Array(PUFF_N * PUFF_F);
let puffHead = 0;

let cam = { x: 0, y: 0, yaw: 0, zr: 0, S: 1, q: 0.01, k: 0.2, cy: BH / 2 };
let now = 0;
let windX = 0;
let windY = 0;

// The game: the crew fly rescue over Chile while hacker drones hunt them.
let TITLE = 0;
let PLAY = 1;
let OVER = 2;
let SHOT = 240; // how fast the crew's shots fly
// What the whole game shares, each on its own: the mode, the score, the one shield …
let gMode = TITLE;
let gT = 0; // seconds in this mode
let gScore = 0;
let gName = ''; // initials being entered for the table of records, if the flight earned a place
let gPos = 0; // which of the three is being chosen
// The five best flights, [initials, score], best first: kept by the cabinet between visits
// (or by the browser, away from it).
let BEST = [];
let KEY = '2075.top';
function loadTop() {
  let take = (v) => {
    if (Array.isArray(v)) BEST = v.filter((e) => Array.isArray(e) && e[1] > 0).slice(0, 5);
  };
  try {
    let safe = window.platanusArcadeStorage;
    if (safe) safe.get(KEY).then((r) => r.found && take(r.value), () => {});
    else take(JSON.parse(localStorage.getItem(KEY)));
  } catch (e) {}
}
function saveTop() {
  BEST.push([gName, gScore]);
  BEST.sort((a, b) => b[1] - a[1]).length = Math.min(5, BEST.length);
  try {
    let safe = window.platanusArcadeStorage;
    if (safe) safe.set(KEY, BEST).catch(() => {});
    else localStorage.setItem(KEY, JSON.stringify(BEST));
  } catch (e) {}
}
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
let gEmT = 0;
let gEmN = 0;
let gSatT = 0;
let gMsg = '';
let gMsgT = 0;
let gShake = 0;
let gFlash = 0;
let demo = 0; // the title's show: which turn it is — a fire, or a rescue …
let demoT = 0; // … and how long it has been going
let gHit = 0; // the flash is a hit (red) and not a burst of light
let gWhy = ''; // what hurt the crew last
let pop = null; // points won, shown for a moment where they were won
let gRain = 0; // how hard it is raining, 0 to 1
let gWet = 0; // … as the crew gets it: none of it, once they are up through the clouds
let drones = [];
let shots = []; // k: 0 the crew's, 1 the enemy's, 2 a load of water
let fires = [];
let folk = []; // people waiting for rescue
let sat = null; // the hackers' satellite
let em = null; // the emergency under way: k 0 a wildfire, 1 a mudslide
let ROPE = 4; // how far below a flyer its water bucket hangs
let wet = null; // while there is a fire and no water aboard: the nearest water, and when it was looked for
let wetT = 0;
let QUEB = []; // cells on the rivers where they come out into the valley: where a flood starts

// The crew talk: Darwin (0) and the monito (1) tell the story and say what to do. Lines wait
// their turn; one given a number is news — said next, and only once a game.
let talk = []; // who, line, who, line …
let talkT = 0;
let told = 0;
let news = 0; // lines of news waiting their turn
function tell(who, line, once) {
  if (told & once) return;
  told |= once;
  if (once) talk.splice(2 + 2 * news++, 0, who, line); // news comes ahead of the story, in the order it happened
  else talk.push(who, line);
}

// Sound: all of it made on the spot from tones and bursts of noise — the effects, the
// engines, the crew's voices and the music.
let AC = null; // the audio context, once Phaser has one
let OUT = null; // everything plays through this, which keeps it from clipping
let NOISE = null;
let ENGINE_TONE = null;
let ENGINE_OPEN = null;
let RAIN = null;
let nextBeat = 0;
let beatN = 0;
let talkC = 0;

// A tone sliding from one pitch to another as it dies away, starting `wait` seconds from now.
function tone(from, to, secs, type, vol, wait) {
  if (!OUT) return;
  let o = AC.createOscillator();
  let g = AC.createGain();
  let t = AC.currentTime + (wait || 0);
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
  let s = AC.createBufferSource();
  let g = AC.createGain();
  let t = AC.currentTime + (wait || 0);
  s.buffer = NOISE;
  s.playbackRate.value = rate || 0.4 + Math.random() * 0.3;
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + secs);
  s.connect(g).connect(OUT);
  s.start(t);
  s.stop(t + secs);
}

let pitch = (semitones) => 110 * 2 ** (semitones / 12); // from the A below middle C

// Every frame: set the sound up once the browser lets it play, then keep the engines and the
// music going.
function sound() {
  if (!AC || AC.state !== 'running') return;
  let t = AC.currentTime;
  if (!OUT) {
    OUT = AC.createDynamicsCompressor();
    OUT.connect(AC.destination);
    NOISE = AC.createBuffer(1, AC.sampleRate, AC.sampleRate);
    let d = NOISE.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    // the engines: a low rasp through a filter that opens with the throttle
    ENGINE_TONE = AC.createOscillator();
    ENGINE_OPEN = AC.createBiquadFilter();
    let g = AC.createGain();
    ENGINE_TONE.type = 'sawtooth';
    g.gain.value = 0.045;
    ENGINE_TONE.connect(ENGINE_OPEN).connect(g).connect(OUT);
    ENGINE_TONE.start();
    // rain: the same noise, thinned to a hiss, turned up while it falls
    let hiss = AC.createBufferSource();
    let thin = AC.createBiquadFilter();
    RAIN = AC.createGain();
    hiss.buffer = NOISE;
    hiss.loop = true;
    thin.type = 'highpass';
    thin.frequency.value = 2200;
    hiss.connect(thin).connect(RAIN).connect(OUT);
    hiss.start();
  }
  RAIN.gain.setTargetAtTime(gWet * 0.05, t, 0.3);
  let thr = gMode === OVER ? 0 : crew.reduce((sum, f) => sum + f.thr, 0) / crew.length;
  ENGINE_TONE.frequency.setTargetAtTime(44 + thr * 62, t, 0.08);
  ENGINE_OPEN.frequency.setTargetAtTime(110 + thr * 950, t, 0.08);

  // the music: sixteen steps round four chords — a bass, a climbing figure over it, and, once
  // there are enemies about, a drum and a hiss to drive it. A hack sours the harmony.
  if (nextBeat < t - 1) nextBeat = t;
  let hot = gMode === PLAY && (drones.length || gHacked);
  while (nextBeat < t + 0.1) {
    let step = beatN++ & 15;
    let root = [0, 0, -4, -2][step >> 2] + (gHacked ? 6 : 0);
    let wait = nextBeat - t;
    if (!(step & 1)) tone(pitch(root - 12), pitch(root - 12), 0.27, 'triangle', 0.1, wait);
    if (hot || !(step & 3)) tone(pitch(root + [12, 19, 24, 19][step & 3]), pitch(root + 12), 0.11, 'square', 0.016, wait);
    if (hot && !(step & 3)) tone(130, 40, 0.16, 'sine', 0.2, wait);
    if (hot && step & 1) burst(0.03, 0.03, wait, 3);
    nextBeat += 0.15;
  }
}

let rand = Math.random;
let spread = () => rand() * 2 - 1;

function cell(x, y) {
  return ((Math.floor(y) & NM) << NS) | clamp(Math.floor(x), 0, NM);
}

function say(text, secs) {
  gMsg = text;
  gMsgT = secs || 1.8;
}

// `who` earned them (the whole crew, if no one in particular)
function gain(points, text, who) {
  points *= gMult;
  gScore += points;
  for (let f of who ? [who] : crew) f.sc += points;
  say(text + ' +' + points);
  tone(660, 660, 0.07, 'triangle', 0.1); // two notes, rising
  tone(990, 990, 0.14, 'triangle', 0.1, 0.07);
}

function heal(n) {
  gShield = Math.min(100, gShield + n);
}

// kind: 0 exhaust · 1 flame · 2 flash · 3 water · 4 dust · 5 black smoke
function puff(x, y, z, vx, vy, vz, life, kind, size) {
  let o = puffHead * PUFF_F;
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
  for (let f of crew) boom(f.x, f.y, f.z, 40);
  gMode = OVER;
  gT = 0;
  gHacked = 0;
  gName = gScore && (!BEST[4] || gScore > BEST[4][1]) ? 'AAA' : ''; // a place in the table: initials, then
  gPos = 0;
}

function hurt(f, d, why) {
  if (f.inv > 0 || gMode !== PLAY) return;
  f.inv = 1;
  gShake = 1;
  gFlash = 0.5;
  gHit = 1;
  gWhy = why;
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
  Object.assign(mate, { z: lead.z, s: 8, sc: 0, stam: 100, inv: 2, trailLen: 0, kick: 0, rollT: 0, x: lead.x, y: lead.y });
  lead.s = -8;
  tell(1, '¡MONITO EN EL AIRE!\nVOLEMOS JUNTOS, DARWIN.');
}

function startGame(two) {
  gMode = PLAY;
  gT = gScore = gLow = gWater = gHacked = gPurge = gChan = gImmune = gEmN = gFlash = gRain = 0;
  gMult = 1;
  gShield = 100;
  gSpawnT = 3; // one thing at a time: drones first, then an emergency, and the satellite last
  gHackT = 20;
  gEmT = 40;
  gSatT = 110;
  drones.length = shots.length = fires.length = folk.length = 0;
  sat = em = null;
  crew.length = 1;
  Object.assign(lead, { s: 0, sc: 0, stam: 100, inv: 2, kick: 0, z: groundAt(lead.x, lead.y) + 20 });
  talk.length = talkT = told = news = 0;
  tone(220, 880, 0.5, 'triangle', 0.1);
  // the briefing: what there is to do and how, one thing at a time, before anything happens
  tell(0, 'AÑO 2075. FUEGO, ALUVIONES Y DRONES DE IA\nENEMIGA: NOSOTROS SOMOS EL RESCATE.');
  tell(1, 'PALANCA: ATRÁS SUBE, ADELANTE BAJA.\nMANTENLA A UN LADO PARA VIRAR EN SECO.');
  tell(0, 'BOTÓN 1 DISPARA. LOS DRONES ORBITAN Y SE\nLANZAN: DERRÍBALOS O ESQUIVA CON 2 O 3.');
  tell(1, 'BOTÓN 4 DA IMPULSO. VOLAR BAJO\nMULTIPLICA LOS PUNTOS.');
  tell(0, 'SIGUE LAS FLECHAS: MOJA EL BALDE Y SUELTA EL\nAGUA CON EL 5. PASA BAJITO SOBRE LA GENTE.');
  if (two) join();
}

// ───────────────────────────────────────────────────────────── simulation

function axesOf(f) {
  let cy = Math.cos(f.yaw);
  let sy = Math.sin(f.yaw);
  let cp = Math.cos(f.pitch);
  let sp = Math.sin(f.pitch);
  let r = f.bank + f.roll;
  let cr = Math.cos(r);
  let sr = Math.sin(r);
  // level flight: wing = (cy, sy, 0), nose = (sy, −cy, 0), up = (0, 0, 1)
  let ux = -sy * sp; // up, after pitching
  let uy = cy * sp;
  let uz = cp;
  let a = f.ax;
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
  let a = f.ax;
  let s = MODEL_SCALE;
  out[o] = f.x + s * (ma * a[0] + mb * a[3] + mc * a[6]);
  out[o + 1] = f.y + s * (ma * a[1] + mb * a[4] + mc * a[7]);
  out[o + 2] = f.z + s * (ma * a[2] + mb * a[5] + mc * a[8]);
}

function spawnDrone(k) {
  if (k) tell(0, '¡UN DRON HACKER! DERRÍBALO O HAZ UN\nGIRO (BOTÓN 2 O 3) ANTES DE QUE ENTRE.', 2);
  // they come in from one flank or the other, tougher as the flight goes on. A drone loiters,
  // circling the crew (for less time the longer the flight has lasted), and then dives at one
  // of them; a hacker takes enough killing to get its hack started
  let side = rand() < 0.5 ? -1 : 1;
  drones.push({ k, hp: k ? 12 : 2 + Math.min(3, (gT / 90) | 0), r: k ? 1.9 : 1.5, a: 40 + rand() * 40, s: side * 110, o: side * 1.3, w: side * 0.7, u: 8, ta: 50, ts: 0, tu: 4, nt: 0, cd: Math.max(4, 9 - gT / 40) + rand() * 2, ch: 0, x: 0, y: 0, z: sq.z + 8 });
}

// A spot of ground near the squad, mostly ahead of it, that passes the test.
function landNear(near, far, test) {
  for (let n = 0; n < 80; n++) {
    let a = sq.yaw + spread() * 1.4;
    let d = near + rand() * (far - near);
    let x = sq.x + Math.sin(a) * d;
    let y = sq.y - Math.cos(a) * d;
    if (x > 4 && x < N - 4 && test(x, y)) return [x, y];
  }
  return null;
}

// Where a fire can take: in a forest, low enough down to be fought.
let WOOD = (x, y) => GR[cell(x, y)] > 37 * GS && GR[cell(x, y)] < 40 * GS && groundAt(x, y) < 16;

function light(x, y) {
  fires.push({ x, y, z: groundAt(x, y) });
  for (let i = 0; i < 9; i++) GR[cell(x + (i % 3) - 1, y + ((i / 3) | 0) - 1)] = 142; // it leaves the ground charred
}

// Fire weather, worse as the flight goes on: 0 a mild day, 1 the worst — heat, dry air and wind.
let dry = () => Math.min(1, gT / 300);
// A wildfire: a few fires in a forest, which spread through it until they are put out with
// water from the sea or a river.
// The sea or river nearest the crew: rings of places, further and further out, each looked
// over from dead ahead round to behind, so of two as near it is the one in front.
function findWater() {
  for (let r = 6; r < 500; r += 6) {
    for (let a = 0; a < 3.2; a += 6 / r) {
      for (let t of [sq.yaw + a, sq.yaw - a]) {
        let x = sq.x + Math.sin(t) * r;
        let y = sq.y - Math.cos(t) * r;
        if (x > 4 && x < N - 4 && GR[cell(x, y)] <= G_SHALLOW * GS) return { x, y, z: groundAt(x, y) };
      }
    }
  }
}
function siren() {
  tone(880, 440, 0.4, 'square', 0.06);
  tone(880, 440, 0.4, 'square', 0.06, 0.45);
}
function startFire() {
  let at = landNear(110, 260, WOOD);
  if (!at) return false;
  for (let i = 0; i < 5; i++) {
    let x = at[0] + (i && spread() * 8);
    let y = at[1] + (i && spread() * 8);
    if (WOOD(x, y)) light(x, y);
  }
  em = { k: 0, t: 0 };
  siren();
  say('¡INCENDIO FORESTAL!');
  tell(1, '¡INCENDIO! SIGUE LA FLECHA AL AGUA, MOJA EL\nBALDE Y SUÉLTALA SOBRE EL FUEGO CON B5.', 8);
  if (dry() > 0.3) tell(0, 'ALTAS TEMPERATURAS, BAJA HUMEDAD Y VIENTO\nFUERTE: EL FUEGO AVANZA MÁS RÁPIDO.', 512);
  return true;
}

// A storm, and then a flood: it rains until a river bursts its banks where it comes out into
// the valley, and the brown water runs down it towards the people stranded on its banks.
function startFlood() {
  let best = -1;
  let bd = 1e9;
  let by = 0;
  for (let q of QUEB) {
    let dy = ((((q >> NS) - sq.y) % N) + N * 1.5) % N - N / 2; // the short way round, north or south
    let d = Math.abs(Math.hypot((q & NM) - sq.x, dy) - 190);
    if (d < bd) {
      bd = d;
      best = q;
      by = sq.y + dy;
    }
  }
  if (best < 0) return false;
  // downstream is west: column by column, the water nearest to where it was in the last
  let path = [];
  let x = best & NM;
  let y = Math.round(by);
  for (let s = 0; s < 200; s++, x--) {
    for (let d = 0; d < 12; d++) {
      if (GR[cell(x, y + d)] <= G_SHALLOW * GS) {
        y += d;
        break;
      }
      if (GR[cell(x, y - d)] <= G_SHALLOW * GS) {
        y -= d;
        break;
      }
    }
    path.push(x, y);
  }
  for (let i = 60; i < 200; i += 45) {
    // someone on the bank: out of the water to one side or the other, and a little way up it
    x = path[i * 2];
    y = path[i * 2 + 1];
    for (let n = 0; n < 60 && (n < 2 || GR[cell(x, y - 2)] <= G_SHALLOW * GS || GR[cell(x, y + 2)] <= G_SHALLOW * GS); n++) y += (i & 1) * 2 - 1;
    folk.push({ x, y, z: groundAt(x, y), i });
  }
  em = { k: 1, t: 0, path, at: 0, saved: 0, done: 0, was: [] };
  siren();
  say('¡TORMENTA!');
  tell(1, 'LLUEVE FUERTE Y EL RÍO SE VA A DESBORDAR:\nPASA BAJITO Y SACA A LA GENTE DE LA ORILLA.', 16);
  return true;
}

function endEmergency() {
  if (em && em.k) for (let i = 0; i < em.was.length; i += 2) GR[em.was[i]] = em.was[i + 1]; // the river goes back into its bed
  em = null;
  fires.length = folk.length = 0;
  gEmT = 12 + rand() * 8;
}

// Water lands: every fire close by goes out.
function douse(x, y, z, by) {
  for (let i = 0; i < 10; i++) puff(x, y, z + 0.5, spread() * 8, spread() * 8, 4 + rand() * 8, 0.6, 3, 1.2);
  let out = 0;
  for (let i = fires.length - 1; i >= 0; i--) {
    if (Math.hypot(fires[i].x - x, fires[i].y - y) < 9) {
      fires.splice(i, 1);
      out++;
    }
  }
  if (!out) return;
  gain(300 * out, 'FUEGO APAGADO', by);
  if (!fires.length && em) {
    gain(1500, 'INCENDIO CONTROLADO');
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
  gRain += ((em && em.k ? 1 : 0) - gRain) * (1 - Math.exp(-0.8 * dt));
  gWet = gRain * clamp((CA + 3 - sq.z) / 6, 0, 1);
  let play = gMode === PLAY;
  if (talk[1]) {
    // each of the crew has a voice: Darwin croaks, the monito chirps, a note every few letters
    if (crew[1]) talk.length = 2; // with two aboard there is no radio: the line in hand is dropped at once
    let c = ((talkT += crew[1] ? 99 : dt) * 40) | 0;
    if (c !== talkC && c < talk[1].length && c % 3 === 0) {
      if (talk[0]) tone(1000 + rand() * 500, 1500, 0.04, 'square', 0.02);
      else tone(150 + rand() * 40, 90, 0.07, 'sawtooth', 0.045);
    }
    talkC = c;
    if (talkT > talk[1].length * 0.03 + 2.6 || pressed.P1_6) {
      talk.splice(0, 2); // the line has been read: on to the next
      if (news) news--;
      talkT = 0;
    }
  }
  if (play && gShield < 30 && ((now * 1.6) | 0) !== (((now - dt) * 1.6) | 0)) tone(880, 880, 0.08, 'square', 0.04); // little shield left
  if (play && gShield < 35) tell(1, 'ESCUDO BAJO. LOS RESCATES Y LOS\nINCENDIOS APAGADOS LO RECUPERAN.', 128);
  if (play && !crew[1] && pressed.START2) join();
  let duo = crew.length > 1;
  let n = crew.length;
  let sx = Math.sin(sq.yaw); // the way the squad is heading …
  let sy = -Math.cos(sq.yaw);
  let rx = -sy; // … and its right

  // ── each of the crew at their stick. Alone, the stick turns the squad. With two, each
  // slides to the side on their own stick, and the squad turns the way they lean together.
  // Hacked, the sticks are reversed and the guns are dead until the crew shake it off, by
  // thrashing the sticks about and hammering their fire buttons.
  let turns = 0;
  let pushes = 0;
  for (let f of crew) {
    let k = f.key;
    let rawX = (held[k + 'R'] ? 1 : 0) - (held[k + 'L'] ? 1 : 0);
    let rawY = (held[k + 'U'] ? 1 : 0) - (held[k + 'D'] ? 1 : 0);
    let turn = rawX;
    let lift = INVERT_Y ? -rawY : rawY;
    f.free = !rawY;
    if (!play) {
      // out of play it flies itself: wandering, or on the title making for the next thing to do
      let g = fires[0] || folk[0];
      turn = g ? clamp(wrapAngle(Math.atan2(g.x - f.x, f.y - g.y) - sq.yaw) * 2, -1, 1) : Math.sin(now * 0.23) * 0.45;
      lift = clamp((Math.max(groundAt(f.x, f.y), groundAt(f.x + sx * 25, f.y + sy * 25)) + (g ? 8 : 16) - f.z) / 6, -1, 1);
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
    // a tap of the stick is a fine correction; held over, the turn tightens until the flyer
    // comes about in little more than its own length
    f.hard = play && rawX && rawX === f.dir ? Math.min(1, f.hard + dt) : 0;
    f.dir = rawX;
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
    let push = Math.max(0, (f.thr - 0.3) / 0.7);
    let fast = 1 + (BOOST - 1) * push;
    f.inv -= dt;
    f.bank = (f.turn * BANK_ANGLE * Math.PI) / 180;
    f.pitch = Math.atan2(f.lift * CLIMB_RATE, SPEED);
    f.kick *= Math.exp(-4 * dt);
    f.z = Math.min(CEILING, f.z + (f.lift * CLIMB_RATE * fast * (f.lift < 0 && f.agl < 4 ? Math.max(0.35, (f.agl - 1) / 3) : 1) + f.kick) * dt);
    if (duo) f.s += f.turn * 26 * dt;

    // barrel rolls: one full turn about the nose, left or right, sliding it that way. While
    // it rolls, shots glance off it and a hacker's signal cannot hold it.
    if (play && (pressed[k + '2'] || pressed[k + '3']) && f.rollT <= 0) {
      f.rollT = 1;
      f.rollDir = pressed[k + '2'] ? -1 : 1;
      tone(240, 880, 0.6, 'sine', 0.06);
    }
    if (f.rollT > 0) {
      let was = f.rollT;
      f.rollT = Math.max(0, was - dt / ROLL_TIME);
      f.roll = f.rollDir * TAU * ease(1 - f.rollT);
      // the slide is quickest half-way through the roll
      let slide = (f.rollDir * ROLL_SLIDE * (Math.cos(Math.PI * f.rollT) - Math.cos(Math.PI * was))) / 2;
      if (duo) f.s += slide;
      else {
        sq.x += rx * slide;
        sq.y += sx * slide;
      }
    } else f.roll = 0;
    if (!rawX) f.s += ((f.id ? 8 : -8) - f.s) * dt * 1.2; // hands off, it drifts back to its own side
    f.s = duo ? clamp(f.s, f.id ? lead.s + 10 : -15, f.id ? 15 : 5) : 0; // on screen, and never through its partner
    turns += (f.turn * (1 + f.hard * 1.3)) / n;
    pushes += push / n;
  }
  if (gHacked) {
    gPurge = Math.max(0, gPurge - dt * 0.15);
    gWhy = 'HACK';
    damage(dt * 2.5);
    if (((now * 3) | 0) !== (((now - dt) * 3) | 0)) tone(520, 260, 0.25, 'square', 0.07); // the alarm
    if (gPurge >= 1) {
      gHacked = 0;
      gImmune = 9;
      gFlash = 1;
      gHit = 0;
      tone(200, 1600, 0.45, 'square', 0.07);
      for (let d of drones) if (d.k) d.hp = 0;
      gain(400, '¡HACKER EXPULSADO!');
    }
  }

  // ── the squad flies on
  let spd = SPEED * (1 + (BOOST - 1) * pushes);
  sq.yaw += turns * TURN_RATE * (duo ? 0.8 : 1) * dt;
  // the map has edges: far out to sea, or on the snowfield beyond the cordillera, the squad is turned back
  let out = sq.x < 40 ? 1 : sq.x > N - 70 ? -1 : 0;
  if (play && out) {
    sq.yaw += wrapAngle(out * 1.57 - sq.yaw) * dt * 2;
    say('FUERA DE ZONA: DE VUELTA AL VALLE', 0.5);
  }
  sq.x += sx * spd * dt;
  sq.y += sy * spd * dt;

  // ── each of the crew in the world: the ground, their guns, the things they can hit
  let mid = sq.z; // where the crew were, on average: two cannot drift far apart in height
  let top = 0;
  sq.z = 0;
  gAgl = 1e9;
  for (let f of crew) {
    f.x = sq.x + rx * f.s;
    f.y = sq.y + sx * f.s;
    f.yaw = sq.yaw + (duo ? f.turn * 0.3 : 0); // with two, the nose swings with the stick, to aim
    if (duo) f.z = clamp(f.z, mid - 14, mid + 14);

    // the ground and the water are solid, but a touch is forgiven: the flyer scrapes along
    // for a moment, bounced up a little, throwing dust or spray. Only if it is still down
    // after that, or comes down again too soon, does it cost shield and get thrown back up
    let ground = Math.max(groundAt(f.x, f.y), groundAt(f.x + sx * 3, f.y + sy * 3));
    // hands off the stick, it will not fly into the ground: it is carried over what is ahead,
    // nose level, so the guns stay where they were pointing
    let floor = Math.max(ground, groundAt(f.x + sx * 14, f.y + sy * 14)) + 5;
    if (play && f.free && f.z < floor) f.z += Math.min(floor - f.z, dt * 16);
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
    let nx = f.ax[3];
    let ny = f.ax[4];
    let nz = f.ax[5];

    // guns: they track whatever enemy is nearest the line of the nose
    f.lock = null;
    let best = 0.035;
    let aim = (t) => {
      let dx = t.x - f.x;
      let dy = t.y - f.y;
      let dz = t.z - f.z;
      let d = Math.hypot(dx, dy, dz);
      let off = 1 - (dx * nx + dy * ny + dz * nz) / d;
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
      shots.push({ k: 0, x: f.x + nx * 3, y: f.y + ny * 3, z: f.z + nz * 3, vx: nx * SHOT, vy: ny * SHOT, vz: nz * SHOT, t: 0.7, to: f.lock, by: f });
    }

    if (play) {
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
        shots.push({ k: 2, x: f.x, y: f.y, z: f.z - ROPE, vx: sx * spd, vy: sy * spd, vz: -4, t: 8, by: f });
      }
    }

    // wingtip trails and exhaust
    let up = (WINGTIPS[1][0] - WING_ROOT) * f.flex;
    modelPoint(f, WINGTIPS[0][0], WINGTIPS[0][1], WINGTIPS[0][2] + up, f.tip, 0);
    modelPoint(f, WINGTIPS[1][0], WINGTIPS[1][1], WINGTIPS[1][2] + up, f.tip, 3);
    if (gMode === OVER) f.trailLen = 0;
    else if (!f.trailLen || Math.hypot(f.x - f.trailX, f.y - f.trailY) >= TRAIL_STEP) {
      f.trailHead = (f.trailHead + 1) % TRAIL_N;
      if (f.trailLen < TRAIL_N) f.trailLen++;
      f.trailX = f.x;
      f.trailY = f.y;
      for (let s = 0; s < 2; s++) {
        let o = f.trailHead * 3;
        f.trail[s][o] = f.tip[s * 3];
        f.trail[s][o + 1] = f.tip[s * 3 + 1];
        f.trail[s][o + 2] = f.tip[s * 3 + 2];
      }
    }
    if (gMode !== OVER && f.thr > 0.6 && rand() < dt * 50) {
      for (let nz2 of NOZZLES) {
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
  let cfx = Math.sin(cam.yaw); // the way the camera looks: enemies keep their station in front of it
  let cfy = -Math.cos(cam.yaw);

  // ── the title's own show never stops: a forest fire put out with the bucket, then someone
  // lifted off a river bank, and round again (a thing not reached in a while is dropped)
  if (gMode === TITLE) {
    let g = fires[0] || folk[0];
    demoT += dt;
    if (!g || demoT > 16) {
      fires.length = folk.length = demoT = 0;
      gWater = 3;
      let at = landNear(70, 120, demo ? (x, y) => x > 170 && GR[cell(x, y)] <= G_SHALLOW * GS : WOOD); // (a river, not the sea)
      if (at) {
        if (demo) {
          for (let n = 0; n < 40 && GR[cell(at[0], at[1])] <= G_SHALLOW * GS; n++) at[1]++; // out of the water, onto its bank
          folk.push({ x: at[0], y: at[1] + 2, z: groundAt(at[0], at[1] + 2) });
        } else for (let i = 0; i < 5; i++) light(at[0] + spread() * 5, at[1] + spread() * 5);
        demo ^= 1; // the other one next
      }
    } else if (Math.hypot(g.x - lead.x, g.y - lead.y) < 7) {
      if (fires[0]) douse(g.x, g.y, g.z);
      else {
        folk.length = 0;
        puff(g.x, g.y, g.z + 1, 0, 0, 6, 0.5, 2, 2.4);
      }
    }
  }

  // ── shots and loads of water
  for (let i = shots.length - 1; i >= 0; i--) {
    let s = shots[i];
    if (s.to && s.to.hp > 0) {
      let dx = s.to.x - s.x;
      let dy = s.to.y - s.y;
      let dz = s.to.z - s.z;
      let d = SHOT / Math.hypot(dx, dy, dz);
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
    let gz = groundAt(s.x, s.y);
    let hit = (d) => {
      if (dead || Math.hypot(d.x - s.x, d.y - s.y, d.z - s.z) > (d.r || 1.4) + 1) return;
      dead = true;
      puff(s.x, s.y, s.z, 0, 0, 0, 0.14, 2, 1.3);
      if (!s.k) {
        d.hp--;
        d.by = s.by;
      }
      else if (d.rollT <= 0) hurt(d, 9, '¡IMPACTO!'); // a roll turns it aside
    };
    if (s.z < gz) {
      dead = true;
      if (s.k === 2) douse(s.x, s.y, gz, s.by);
      else puff(s.x, s.y, gz + 0.3, 0, 0, 2, 0.3, 4, 0.6);
    } else if (!s.k) {
      drones.forEach(hit);
      if (sat) hit(sat);
    } else if (s.k === 1 && play) crew.forEach(hit);
    if (dead) shots.splice(i, 1);
  }
  let shootAt = (d, size) => {
    let f = crew[(rand() * n) | 0];
    let t = Math.hypot(f.x - d.x, f.y - d.y, f.z - d.z) / 70; // lead the target a little
    let tx = f.x + sx * spd * t * 0.8 - d.x;
    let ty = f.y + sy * spd * t * 0.8 - d.y;
    let tz = f.z - d.z;
    let l = 70 / Math.hypot(tx, ty, tz);
    shots.push({ k: 1, x: d.x, y: d.y, z: d.z, vx: tx * l, vy: ty * l, vz: tz * l, t: 4, r: size });
    tone(520, 180, 0.12, 'sawtooth', 0.025);
  };

  // ── drones circle the squad and then dive at it; hackers keep a station ahead, and
  // need a few seconds of clear signal to break in, and a roll cuts the signal
  let rolling = crew.some((f) => f.rollT > 0);
  gChan = 0;
  for (let i = drones.length - 1; i >= 0; i--) {
    let d = drones[i];
    if (d.hp <= 0) {
      boom(d.x, d.y, d.z, 30);
      if (play) {
        gShake = 0.4;
        pop = { x: d.x, y: d.y, z: d.z, t: now + 1, s: '+' + (d.k ? 300 : 100) * gMult };
        gain(d.k ? 300 : 100, d.k ? 'HACKER DERRIBADO' : 'DRON DERRIBADO', d.by);
      }
      drones.splice(i, 1);
      continue;
    }
    if (now > d.nt) {
      d.ta = 36 + rand() * 12;
      d.ts = spread() * 12;
      d.tu = spread() * 6 + 2;
      d.nt = now + 1.5 + rand() * 2.5;
    }
    if (!d.k) {
      // its orbit: an oval out ahead of the crew, where it never comes between them and the camera
      d.o += d.w * dt;
      d.ta = 48 + 20 * Math.cos(d.o);
      d.ts = 34 * Math.sin(d.o);
    }
    let kz = d.kz; // whoever it is diving at
    if (kz) {
      // a straight run at them. Shot down, it is gone; a roll throws it wide; else it hits
      let da = -d.a;
      let ds = kz.s - d.s;
      let du = kz.z - sq.z - d.u;
      let l = Math.hypot(da, ds, du);
      let k = Math.min(1, (95 * dt) / l);
      d.a += da * k;
      d.s += ds * k;
      d.u += du * k;
      if (l < 2.6) {
        boom(d.x, d.y, d.z, 30);
        if (kz.rollT > 0) gain(150, '¡ESQUIVADO!', kz);
        else hurt(kz, 18, '¡KAMIKAZE!');
        drones.splice(i, 1);
        continue;
      }
    } else {
      let e = 1 - Math.exp(-1.3 * dt);
      d.a += (d.ta - d.a) * e;
      d.s += (d.ts - d.s) * e;
      d.u += (d.tu - d.u) * e;
    }
    d.x = sq.x + cfx * d.a - cfy * d.s;
    d.y = sq.y + cfy * d.a + cfx * d.s;
    // over the ground, and over whatever stands between it and the crew — easing up and
    // down, never jumping
    d.z += (Math.max(sq.z + d.u, groundAt(d.x, d.y) + 4, groundAt((d.x + sq.x) / 2, (d.y + sq.y) / 2) + 2) - d.z) * Math.min(1, dt * 5);
    if (!play) continue;
    if (!d.k) {
      d.cd -= dt;
      if (d.cd < 0 && !kz) {
        d.kz = crew[(rand() * n) | 0];
        tone(300, 1100, 0.5, 'sawtooth', 0.07); // it winds up
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
    // nothing new begins while the radio is talking over a quiet sky
    let tick = talk[1] && !drones[0] && !em ? 0 : dt;
    gSpawnT -= tick;
    if (gSpawnT < 0 && drones.length < Math.min(6, 1 + n + ((gT / 25) | 0))) {
      gSpawnT = Math.max(2.5, 7 - gT / 30) / n;
      spawnDrone(0);
    }

    // ── the hackers' satellite, far up in the stratosphere: while it is there it keeps
    // sending hacker drones down
    if (!sat) {
      gSatT -= tick;
      if (gSatT < 0) {
        sat = { x: sq.x + cfx * 90, y: sq.y + cfy * 90, z: 285, hp: 40, r: 4.5, cd: 3 };
        tell(1, 'EL SATÉLITE HACKER ESTÁ EN LA\nESTRATÓSFERA. SUBE Y DESTRÚYELO.', 32);
      }
    } else if (sat.hp <= 0) {
      boom(sat.x, sat.y, sat.z, 40);
      gain(1500, 'SATÉLITE DESTRUIDO', sat.by);
      sat = null;
      gSatT = 60;
      gHackT = 20;
    } else {
      let e = 1 - Math.exp(-3 * dt);
      sat.x += (sq.x + cfx * 60 - sat.x) * e;
      sat.y += (sq.y + cfy * 60 - sat.y) * e;
      sat.cd -= dt;
      if (sat.cd < 0 && Math.abs(sq.z - sat.z) < 40) {
        sat.cd = 1.3;
        shootAt(sat, 1);
      }
      gHackT -= dt;
      if (gHackT < 0) {
        gHackT = 24;
        spawnDrone(1);
      }
    }

    // with a fire burning and the buckets dry, the crew is shown the way to the nearest water
    if (!fires[0] || gWater) wet = null;
    else if (now > wetT) {
      wetT = now + 0.4;
      wet = findWater();
    }

    // ── emergencies, one at a time: a wildfire, then a mudslide, and round again
    if (!em) {
      gEmT -= tick;
      if (gEmT < 0) {
        if (gEmN++ & 1 ? startFlood() : startFire()) gEmT = 0;
        else gEmT = 2;
      }
    } else {
      em.t += dt;
      if (!em.k) {
        // the fire spreads, faster in fire weather and downwind; too many fires and it is
        // beyond saving
        if (em.t > 5 - dry() * 3) {
          em.t = 0;
          let f = fires[(rand() * fires.length) | 0];
          let x = f.x + spread() * 10 - dry() * 7;
          let y = f.y + spread() * 10 - dry() * 3;
          if (WOOD(x, y)) light(x, y);
          if (fires.length > 11) {
            say('INCENDIO FUERA DE CONTROL', 2.5);
            damage(15);
            gLow = 0;
            endEmergency();
          }
        }
      } else {
        // it rains for a while; then the river bursts its banks and the brown water runs down
        // it, wider than the bed was. Anyone it reaches is lost
        if (em.t > 8) {
          if (!em.at) say('¡SE DESBORDÓ EL RÍO!');
          em.at = Math.min(em.path.length / 2 - 1, em.at + dt * 3);
          for (; em.done < em.at; em.done++) {
            // from one bank to the other here, and four cells beyond each
            let x = em.path[em.done * 2];
            let lo = em.path[em.done * 2 + 1];
            let hi = lo;
            for (let n = 0; n < 16 && GR[cell(x, lo - 1)] <= G_SHALLOW * GS; n++) lo--;
            for (let n = 0; n < 16 && GR[cell(x, hi + 1)] <= G_SHALLOW * GS; n++) hi++;
            for (let y = lo - 4; y <= hi + 4; y++) {
              let i = cell(x, y);
              if (GR[i] - 22 * GS) {
                em.was.push(i, GR[i]);
                GR[i] = 22 * GS;
              }
            }
          }
        }
        if (rand() < dt * 0.3) {
          gFlash = 0.6; // lightning, and its thunder a moment after
          gHit = 0;
          burst(1.6, 0.3, 0.4, 0.1);
        }
        let o = (em.at | 0) * 2;
        em.x = em.path[o];
        em.y = em.path[o + 1];
        em.z = groundAt(em.x, em.y);
        if (rand() < dt * 14) puff(em.x + spread() * 3, em.y + spread() * 3, em.z + 1, spread() * 3, spread() * 3, 2 + rand() * 3, 1.2, 4, 1.6);
        for (let i = folk.length - 1; i >= 0; i--) {
          let f = folk[i];
          let by = crew.find((c) => Math.hypot(c.x - f.x, c.y - f.y) < 5 && c.z - f.z < 7);
          if (by) {
            folk.splice(i, 1);
            em.saved++;
            gain(800, '¡RESCATADO!', by);
            heal(10);
            puff(f.x, f.y, f.z + 1, 0, 0, 6, 0.4, 2, 2);
          } else if (em.at >= f.i) {
            folk.splice(i, 1);
            say('EL ALUVIÓN SE LLEVÓ A ALGUIEN', 2);
            damage(8);
          }
        }
        if (!folk.length) {
          if (em.saved > 3) gain(1500, 'TODOS A SALVO');
          endEmergency();
        }
      }
    }
  }

  // ── fires burn: flames and black smoke
  for (let f of fires) {
    if (Math.abs(f.x - sq.x) + Math.abs(f.y - sq.y) > 260) continue;
    if (rand() < dt * 9) puff(f.x + spread(), f.y + spread(), f.z + 0.5, spread(), spread(), 4 + rand() * 4, 0.6, 1, 1.3);
    if (rand() < dt * 2.5) puff(f.x, f.y, f.z + 3, 1.5 + spread(), 0.6 + spread(), 5 + rand() * 3, 2.2, 5, 1.8);
  }

  // ── everything that drifts
  let drag = Math.exp(-3 * dt);
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
  let cx = Math.cos(cam.yaw);
  let cy = Math.sin(cam.yaw);
  let aside = ((sq.x - cam.x) * cx + (sq.y - cam.y) * cy) * Math.exp(-CHASE_SLIDE * dt);
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
let ZB = new Float32Array(BW * BH); // depth of what each pixel shows
let PC = new Uint32Array(BW * BH); // a see-through cloud waiting over a pixel: its colour …
let PA = new Uint8Array(BW * BH); // … and how much of it shows
let YB = new Int16Array(BW); // per column: the ground has filled everything from here down
let SJ = new Float32Array(16 * 6); // shadow casters this frame
let nSJ = 0;
let invMs = 1;
let fwdX = 0;
let fwdY = -1;
let rgtX = 1;
let rgtY = 0;

// Is this ground point (relative to the camera, at height h) in a flyer's shadow?
function shadowed(relX, relY, h) {
  for (let j = 0; j < nSJ; j++) {
    let o = j * 6;
    let dz = SJ[o + 2] - h;
    if (dz <= 0) continue;
    let dx = relX - SJ[o] - SUN_X * dz;
    let dy = relY - SJ[o + 1] - SUN_Y * dz;
    if (dx > 7 || dx < -7 || dy > 7 || dy < -7) continue;
    let cy = SJ[o + 3];
    let sy = SJ[o + 4];
    let i = Math.floor((dx * cy + dy * sy) * SJ[o + 5] + MCX + 0.5);
    let jj = Math.floor(MPJ - (dx * sy - dy * cy) * invMs + 0.5);
    if (i >= 0 && i < MW && jj >= 0 && jj < ML && MASK[jj * MW + i]) return 1;
  }
  return 0;
}

// The ground and the clouds, from the nearest row of cells to the farthest. A pixel that is
// already taken stays taken, so nearer things always win. Close to the camera, where one cell
// covers several pixels, heights and tones are blended between cells, so slopes come out
// smooth instead of stepped.
// The part of the buffer the world is drawn into: all of it, or (for a split screen) the
// columns VX0 to VX1 and the rows above VYB.
let coarse = 1; // how much longer than usual the steps into the distance are: more, on a slow machine
let VX0 = 0;
let VX1 = BW;
let VYB = BH;
function drawWorld() {
  let { S, q, k, zr, cy } = cam;
  ZB.fill(EMPTY);
  YB.fill(VYB);
  PA.fill(0);

  let camX = cam.x + BIG;
  let camY = cam.y - Math.floor(cam.y / N) * N + 4 * N;
  let tick = (now * 15) | 0;
  let over = gRain * 56; // a storm closes the sky: this much more cloud everywhere, in sixteenths
  let A = S * (k + q * Math.max(zr, 1)); // screen rows of sea per unit of depth, at the flyer
  let view = VIEW_DIST + zr * 4; // the eye reaches further from higher up, and the haze starts further out
  let fogStart = view * 0.27;
  let fogK = FOG_N / (view - fogStart);

  // start where the tallest thing sits on the bottom row; a camera down among the hills and
  // clouds starts right in front of itself instead
  let v = (cy - BH - S * (ZTOP - zr)) / (S * k + (BH - cy) * q);
  let near = (NEAR_W - 1) / q;
  if (v < near || zr + k / q < ZTOP + 2) v = near;

  let cs = coarse > 1.7 ? 2 : 1; // a machine well behind draws every other column only
  let open = VX1 - VX0;
  while (v < view && open > 0) {
    let w = 1 + q * v;
    let m = S / w;
    let inv = w / S;
    let dv = (w * w) / A;
    if (dv < DV_MIN * inv * coarse) dv = DV_MIN * inv * coarse;
    else if (dv > DV_MAX * inv * coarse) dv = DV_MAX * inv * coarse;
    let v2 = v + dv;
    let m2 = S / (1 + q * v2);
    let b1 = cy - m * (k * v - zr); // row of height 0 at the near edge of this step …
    let b2 = cy - m2 * (k * v2 - zr); // … and at its far edge
    let fog = v <= fogStart ? 0 : ((v - fogStart) * fogK) | 0;
    if (fog > FOG_N) fog = FOG_N;
    let po = fog * NR; // this step's cloud colours …
    let pg = fog * NG * NL; // … and ground colours
    let blend = m > BLEND_M; // cells are magnified here
    let sharp = m > 1.7 ? 1 : m < 0.9 ? 0 : (m - 0.9) * 1.25; // … and here they are too small to tell apart
    let cloudRow = Math.min(b1 - m * (CA + CK), b2 - m2 * (CA + CK)); // the highest a cloud can show

    let relX = fwdX * v - rgtX * (CXS - VX0) * inv;
    let relY = fwdY * v - rgtY * (CXS - VX0) * inv;
    let stepX = rgtX * inv * cs;
    let stepY = rgtY * inv * cs;

    for (let x = VX0; x < VX1; x += cs, relX += stepX, relY += stepY) {
      let yb = YB[x];
      if (yb <= 0) continue;
      let wx = relX + camX;
      let wy = relY + camY;
      let ix = (wx | 0) - BIG; // the map does not wrap east–west: its edges go on for ever
      ix = ix < 0 ? 0 : ix > NM ? NM : ix;
      let iy = (wy | 0) & NM;
      // nothing here can reach above what is already drawn: skip it
      if (cloudRow >= yb && b1 - m * HM[((iy >> 4) << (NS - 4)) | (ix >> 4)] * 0.5 >= yb + 0.5) continue;
      let i = (iy << NS) | ix;

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
        th = p + (r - p) * ty + over;
        ct = CTONE[ra | xa];
      } else {
        h = (HF[i] + (H[i] - HF[i]) * sharp) * 0.5;
        g = sharp > 0.5 ? GR[i] : GF[i];
        lit = sharp > 0.5 ? LIT[i] : LF[i];
        let ci = ((((wy + windY) | 0) & NM) << NS) | (((wx + windX) | 0) & NM);
        th = CT[ci] + over;
        ct = CTONE[ci];
      }

      // clouds: a sheet that swells up from CA and sags a little below it; where it is thin it
      // is see-through, held back until whatever lies behind it is drawn
      if (th > 1) {
        let t = th * 0.0625;
        let zt = CA + t;
        let zb = CA - t * 0.15;
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
            let alpha = t < CLOUD_SOFT ? ((t / CLOUD_SOFT) * 255) | 0 : 255;
            let top = po + ct - (nSJ && shadowed(relX, relY, zt) ? SHADOW : 0);
            let drop = c0 > y1 ? (ct - CLOUD_LOW) / (c0 - y1) : 0; // its side darkens towards the foot
            for (let p = ys * BW + x; ys < ye; ys++, p += BW) {
              if (ZB[p] < TAKEN) continue;
              let c = PAL[ys < y1 ? top : ys < c0 ? top - (((ys - y1) * drop) | 0) : po + CLOUD_UNDER];
              let held = PA[p];
              if (alpha > 250) {
                FB[p] = held ? mix(c, PC[p], held) : c;
                ZB[p] = v;
              } else if (!held) {
                PC[p] = c;
                PA[p] = alpha;
              } else {
                // more cloud behind the cloud already waiting here: it shows through the rest
                let add = (alpha * (255 - held)) >> 8;
                let sum = held + add;
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

      // water moves: two swells crossing each other, and here and there a glint
      if (g < G_SHALLOW * GS && ix) lit += RIPPLE[(wx * 3 + wy + now * 9) & 31] + RIPPLE[(wy * 2.3 - wx - now * 6) & 31] + (((R8[i] + tick) & 255) < 2 ? 9 : 0);
      // shadows: soft under the clouds, hard under the flyers
      let dz = CA - h;
      let dark = (CT[((((wy - SUN_Y * dz + windY) | 0) & NM) << NS) | (((wx - SUN_X * dz + windX) | 0) & NM)] + over) * 0.2;
      if (dark > LIT_SHADOW || (nSJ && shadowed(relX, relY, h))) dark = LIT_SHADOW;
      lit = (lit - dark) | 0;
      let c = GPAL[pg + g * NL + (lit < 0 ? 0 : lit)];
      for (let y = ya, p = ya * BW + x; y < yb; y++, p += BW) {
        if (ZB[p] > TAKEN) {
          FB[p] = PA[p] ? mix(c, PC[p], PA[p]) : c;
          ZB[p] = v;
        }
      }
      YB[x] = ya;
      if (ya <= 0) open -= cs;
    }
    v = v2;
  }
  // at half width, each column drawn stands for the one beside it too
  if (cs > 1) {
    for (let p = 0; p < BW * BH; p += 2) {
      FB[p + 1] = FB[p];
      ZB[p + 1] = ZB[p];
      PA[p + 1] = PA[p];
      PC[p + 1] = PC[p];
    }
  }
}

// Whatever the ground left empty: sky above the horizon, haze below it.
function drawSky() {
  let { S, q, k } = cam;
  let hy = cam.cy - (S * k) / q;
  let hyi = Math.round(hy);

  // the sun, over the horizon opposite the shadows
  let sunX = -1e6;
  let sunY = 0;
  let d = wrapAngle(SUN_AZ - cam.yaw);
  if (Math.abs(d) < 1.3) {
    sunX = CXS + (S / q) * Math.tan(d);
    sunY = hy - ((S / q) * Math.tan(SUN_ELEV)) / Math.cos(d);
  }
  let disc = 49 * RS * RS;
  let glow = 1600 * RS * RS;
  // up in the stratosphere the sky deepens towards black and the stars come out
  let high = smooth(STRATO, SPACE, cam.zr);
  let tr = SKY_TOP[0] + (4 - SKY_TOP[0]) * high;
  let tg = SKY_TOP[1] + (8 - SKY_TOP[1]) * high;
  let tb = SKY_TOP[2] + (26 - SKY_TOP[2]) * high;
  let pan = Math.round((cam.yaw * S) / q);
  let stars = (high * 255) | 0;

  for (let y = 0, p = 0; y < BH; y++) {
    let below = y >= hyi;
    let t = clamp((hy - y) / ((130 - 70 * high) * RS), 0, 1);
    let row = below ? colHaze : pack((SKY_LOW[0] + (tr - SKY_LOW[0]) * t) | 0, (SKY_LOW[1] + (tg - SKY_LOW[1]) * t) | 0, (SKY_LOW[2] + (tb - SKY_LOW[2]) * t) | 0);
    let dy = y - sunY;
    for (let x = 0; x < BW; x++, p++) {
      if (ZB[p] < TAKEN) continue;
      let c = row;
      if (!below) {
        let dx = x - sunX;
        let dd = dx * dx + dy * dy;
        if (dd < disc) c = colSun;
        else if (dd < glow) {
          let fall = 1 - Math.sqrt((dd - disc) / (glow - disc));
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
  let dx = x - cam.x;
  let dy = y - cam.y;
  let v = dx * fwdX + dy * fwdY;
  let w = 1 + cam.q * v;
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
    let t = f.trail[s];
    let ox = 0;
    let oy = 0;
    let ov = 0;
    let had = false;
    // n = 0 is the wingtip itself; then back through the stored points
    for (let n = f.trailLen; n >= 0; n--) {
      let ok;
      if (n === 0) ok = project(f.tip[s * 3], f.tip[s * 3 + 1], f.tip[s * 3 + 2]);
      else {
        let o = ((f.trailHead - (n - 1) + TRAIL_N * 2) % TRAIL_N) * 3;
        ok = project(t[o], t[o + 1], t[o + 2]);
      }
      if (ok && had) {
        let age = n / TRAIL_N;
        let keep = ((1 - age) * (1 - age) * 255) | 0;
        let thick = prM > 1.7 * RS && age < 0.5 ? 2 : 1;
        let len = Math.max(Math.abs(prX - ox), Math.abs(prY - oy)) | 0;
        if (len < 300) {
          let steps = len + 1;
          for (let i = 0; i <= steps; i++) {
            let u = i / steps;
            let x = Math.floor(ox + (prX - ox) * u);
            let y = Math.floor(oy + (prY - oy) * u);
            let dep = ov + (prV - ov) * u;
            if (y < 0 || y >= BH) continue;
            for (let j = 0; j < thick; j++) {
              let xx = x + j;
              if (xx < 0 || xx >= BW) continue;
              let p = y * BW + xx;
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
let LV = new Float32Array(4096); // the sun on each direction a surface can face …
let SP = new Float32Array(4096); // … and the glint there
let STEP = new Float32Array(9);
let fx0 = 0;
let fy0 = 0;
let fv0 = 0;
let fHalf = 0.5;

function plotVoxel(ma, mb, mc, colour) {
  let sx = fx0 + ma * STEP[0] + mb * STEP[3] + mc * STEP[6];
  let sy = fy0 + ma * STEP[1] + mb * STEP[4] + mc * STEP[7];
  let dep = fv0 + ma * STEP[2] + mb * STEP[5] + mc * STEP[8];
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
  let { n, gi, gj, gk, ni, grid } = f.m;
  for (let v = 0; v < n; v++) {
    let o = ni[v] * 3;
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
  let s = prM * MODEL_SCALE;
  let reach = s * 34;
  if (prX < -reach || prX > BW + reach || prY < -reach || prY > BH + reach) return;
  paint(f, prX, prY, prV, s);
  drawFlames(f, s);
}

// A model with its pivot at a place on screen and a depth, `s` pixels to its design unit.
function paint(f, x, y, v, s) {
  fx0 = x;
  fy0 = y;
  fv0 = v;
  fHalf = Math.max(0.5, (s * 0.71) / MK);

  // each model axis as a step on screen (x, y) and in depth
  let a = f.ax;
  for (let i = 0; i < 9; i += 3) {
    let dep = a[i] * fwdX + a[i + 1] * fwdY;
    STEP[i] = s * (a[i] * rgtX + a[i + 1] * rgtY);
    STEP[i + 1] = -s * (a[i + 2] + cam.k * dep);
    STEP[i + 2] = MODEL_SCALE * dep;
  }

  // the sun, and the direction half-way between the sun and the camera, in the flyer's own
  // axes; shadows are cast again only when the sun has moved across it
  let lx = a[0] * LIGHT[0] + a[1] * LIGHT[1] + a[2] * LIGHT[2];
  let ly = a[3] * LIGHT[0] + a[4] * LIGHT[1] + a[5] * LIGHT[2];
  let lz = a[6] * LIGHT[0] + a[7] * LIGHT[1] + a[8] * LIGHT[2];
  let { n, a: ma, b: mb, c: mc, w: mw, col, ni, ao, hot, used } = f.m;
  if (!f.shade) {
    f.shade = new Uint8Array(n);
    f.sunZ = 9;
  }
  if (lx * f.sunX + ly * f.sunY + lz * f.sunZ < 0.9985) castShadows(f, lx, ly, lz);
  let eye = norm3(LIGHT[0] - fwdX, LIGHT[1] - fwdY, LIGHT[2] + cam.k + 0.6);
  let hx = a[0] * eye[0] + a[1] * eye[1] + a[2] * eye[2];
  let hy = a[3] * eye[0] + a[4] * eye[1] + a[5] * eye[2];
  let hz = a[6] * eye[0] + a[7] * eye[1] + a[8] * eye[2];
  for (let i = 0; i < used.length; i++) {
    let q = used[i];
    let o = q * 3;
    let d = NQ[o] * lx + NQ[o + 1] * ly + NQ[o + 2] * lz;
    let h = NQ[o] * hx + NQ[o + 1] * hy + NQ[o + 2] * hz;
    LV[q] = d > 0 ? d : 0;
    SP[q] = h > 0 ? Math.pow(h, 20) : 0;
  }

  let shade = f.shade;
  let flex = f.flex;
  let skin = (f.id + 1) * NMAT;
  let fire = Math.min(1, f.thr) * 90; // how brightly the burners light the tail
  for (let i = 0; i < n; i++) {
    let q = ni[i];
    let m = col[i];
    let l = shade[i] ? (0.36 + 0.1 * LV[q]) * ao[i] * 15 : (0.36 + 0.64 * LV[q]) * ao[i] * 15 + SP[q] * GLINT[m];
    if (l > NLV - 1) l = NLV - 1;
    let c = JPAL[(skin + m) * NLV + (l | 0)];
    plotVoxel(ma[i], mb[i], mc[i] + mw[i] * flex, hot[i] ? mix(c, HEAT[1], (hot[i] * fire) | 0) : c);
  }
}

// Something soft and round at a place in the world: `r` across, `dens` thick at its middle.
function soft(x, y, z, r, colour, dens) {
  if (project(x, y, z)) blot(r, colour, dens);
}

// The same, at the place on screen the last projection left (prX, prY, at depth prV).
function blot(r, colour, dens) {
  r *= prM;
  let x0 = Math.max(0, Math.floor(prX - r));
  let x1 = Math.min(BW - 1, Math.ceil(prX + r));
  let y0 = Math.max(0, Math.floor(prY - r));
  let y1 = Math.min(BH - 1, Math.ceil(prY + r));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      let dd = ((x - prX) * (x - prX) + (y - prY) * (y - prY)) / (r * r);
      if (dd > 1) continue;
      let p = y * BW + x;
      if (ZB[p] > prV) FB[p] = mix(FB[p], colour, (dens * (1 - dd)) | 0);
    }
  }
}

// The burners. Each flame is a slim string of soft lights from the nozzle to its tip:
// a white-hot root, then yellow and orange, deepening as it cools. It grows with the throttle and leaps out
// in a dash, it flickers, it shows shock diamonds when the burners are wide open, and in a
// turn it trails round the inside of the curve the flyer has flown.
let HEAT = [pack(255, 250, 220), pack(255, 214, 110), pack(255, 160, 50), pack(244, 112, 30), pack(190, 70, 24)];
let TIP = new Float32Array(3);
// `s` is the size of the flyer's design unit on screen, as it was just drawn
function drawFlames(f, s) {
  let open = Math.max(0, (f.thr - 0.3) / 0.7); // 0 idling · 1 burners lit · more in a dash
  let len = (1.1 + open * 3.8) * (1 + 0.1 * Math.sin(now * 53) + 0.06 * Math.sin(now * 31 + 2));
  for (let nz of NOZZLES) {
    for (let i = 17; i >= 0; i--) {
      // from the tip back to the root, so the white of the root is what shows from behind;
      // each light is placed in the flyer's own frame, like its voxels, so it stays on the nozzle
      let t = i / 17;
      let d = t * len;
      let wob = Math.sin(now * 37 + i * 1.7 + nz[0]) * t * 0.08 * (1 + open) * invMs;
      let ma = nz[0] + f.turn * d * d * 0.09 * invMs + wob;
      let mb = nz[1] - d * invMs;
      let mc = nz[2] + wob;
      prX = fx0 + ma * STEP[0] + mb * STEP[3] + mc * STEP[6];
      prY = fy0 + ma * STEP[1] + mb * STEP[4] + mc * STEP[7];
      prV = fv0 + ma * STEP[2] + mb * STEP[5] + mc * STEP[8];
      prM = s * invMs;
      blot((0.15 + open * 0.07) * (1 - t) + 0.04, HEAT[t < 0.07 ? 0 : Math.min(4, 1 + ((t * 3.6) | 0))], (1 - t * 0.9) * 230 * (open > 0.6 ? 0.75 + 0.25 * Math.sin(d * 5 - now * 26) : 1));
    }
  }
}

// Everything soft and round that drifts: exhaust, flames, flashes, spray, dust, black smoke.
let PUFF_COL = [pack(96, 84, 92), 0, pack(255, 255, 255), pack(110, 180, 230), pack(150, 125, 95), pack(40, 44, 54)];
let FLAMES = [pack(255, 232, 120), pack(255, 150, 44), pack(214, 60, 30)];
let PUFF_DENSE = [110, 235, 255, 200, 150, 190];
function drawPuffs() {
  for (let o = 0; o < puffs.length; o += PUFF_F) {
    let age = puffs[o + 6];
    if (age <= 0) continue;
    let life = age / puffs[o + 7];
    let kind = puffs[o + 8];
    soft(puffs[o], puffs[o + 1], puffs[o + 2], puffs[o + 9] * (0.5 + life * 1.5), kind === 1 ? FLAMES[(life * 3) | 0] : PUFF_COL[kind], (1 - life) * PUFF_DENSE[kind]);
  }
}

// A ball, lit by the sun like everything else (or glowing by itself).
let sunR = 0; // the sun as the screen sees it: to the right, up, towards the camera
let sunU = 0;
let sunC = 0;
function ball(x, y, z, r, mat, glow) {
  if (!project(x, y, z)) return;
  let R = r * prM;
  if (R < 0.4 || prX < -R || prX > BW + R || prY < -R || prY > BH + R) return;
  let x0 = Math.max(0, Math.floor(prX - R));
  let x1 = Math.min(BW - 1, Math.ceil(prX + R));
  let y0 = Math.max(0, Math.floor(prY - R));
  let y1 = Math.min(BH - 1, Math.ceil(prY + R));
  let o = mat * NLV;
  for (let py = y0; py <= y1; py++) {
    for (let px = x0; px <= x1; px++) {
      let dx = (px + 0.5 - prX) / R;
      let dy = (py + 0.5 - prY) / R;
      let dd = dx * dx + dy * dy;
      if (dd > 1) continue;
      let nz = Math.sqrt(1 - dd);
      let dep = prV - nz * r;
      let p = py * BW + px;
      if (ZB[p] <= dep) continue;
      ZB[p] = dep;
      let l = dx * sunR - dy * sunU + nz * sunC;
      FB[p] = JPAL[o + (glow ? NLIT - 1 : ((0.36 + 0.64 * (l > 0 ? l : 0)) * 15) | 0)];
    }
  }
}

// A straight bar between two points in the world, `w` wide, solid or see-through.
function beam(x1, y1, z1, x2, y2, z2, w, colour, alpha) {
  if (!project(x1, y1, z1)) return;
  let ax = prX;
  let ay = prY;
  let av = prV;
  let am = prM;
  if (!project(x2, y2, z2)) return;
  let th = Math.max(1, Math.round(w * (am + prM) * 0.5));
  let len = Math.max(Math.abs(prX - ax), Math.abs(prY - ay));
  if (len > 1200) return;
  let n = Math.ceil(len / (alpha > 250 ? 1 : th)) + 1; // see-through bars are laid end to end, never doubled up
  for (let i = 0; i <= n; i++) {
    let u = i / n;
    let bx = Math.round(ax + (prX - ax) * u - th / 2);
    let by = Math.round(ay + (prY - ay) * u - th / 2);
    let dep = av + (prV - av) * u;
    for (let y = by < 0 ? 0 : by; y < by + th && y < BH; y++) {
      for (let x = bx < 0 ? 0 : bx; x < bx + th && x < BW; x++) {
        let p = y * BW + x;
        if (ZB[p] > dep) FB[p] = alpha > 250 ? colour : mix(FB[p], colour, alpha);
      }
    }
  }
}

// An upright block — a building — seen face on: lit on the sun's side, shaded on the other,
// with a dark line for its roof.
let colRed = pack(255, 40, 70);
let colShot = pack(200, 235, 255);
let colMud = pack(120, 86, 58);
let colFoam = pack(206, 184, 150);
let STORM = pack(56, 66, 92);
let colFire = pack(255, 160, 60);

// The cast: drones, the satellite, fires, people, the flood, shots.
function drawThings() {
  for (let d of drones) {
    // a body with one eye that watches the condor, between two rotor pods; hackers are dark,
    // with a red eye and an aerial, and a beam on the condor while they break in
    let dx = sq.x - d.x;
    let dy = sq.y - d.y;
    let dz = sq.z - d.z;
    let l = (d.r * 0.8) / Math.hypot(dx, dy, dz);
    ball(d.x, d.y, d.z, d.r, d.k ? ENGINE : d.kz && (now * 12) & 1 ? GLOW : HEAD, d.kz); // diving, it flashes
    ball(d.x + dx * l, d.y + dy * l, d.z + dz * l, d.r * 0.45, d.k ? GLOW : PLUME, d.k);
    let bob = Math.sin(now * 14 + d.s) * 0.3;
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
  for (let f of fires) {
    // three tongues of flame each, yellow at the root and red at the tip, licking about
    for (let j = 0; j < 3; j++) {
      let tall = 0.75 + 0.3 * Math.sin(now * 9 + f.x * 7 + j * 2);
      for (let i = 0; i < 5; i++) {
        soft(f.x + (j - 1) * 1.1 + Math.sin(now * 7 + i + j * 3) * i * 0.12, f.y + ((j * 7) % 3) - 1, f.z + 0.4 + i * tall, 1.2 - i * 0.2, FLAMES[i >> 1], 235 - i * 25);
      }
    }
  }
  for (let f of folk) {
    // a light on the ground and a tall beacon above it
    ball(f.x, f.y, f.z + 0.6, 0.7, PLUME, 1);
    beam(f.x, f.y, f.z + 1, f.x, f.y, f.z + 26, 0.5, colTrail, 110 + ((Math.sin(now * 6) * 60) | 0));
  }
  if (em && em.k) {
    // a wall of brown water from bank to bank, under a ragged crest of foam
    beam(em.x, em.y - 10, em.z + 1, em.x, em.y + 10, em.z + 1, 2.2, colMud, 255);
    for (let i = -5; i < 5; i++) {
      let lift = (j) => em.z + 2.2 + Math.sin(now * 7 + j * 1.9) * 0.45;
      beam(em.x - 0.4, em.y + i * 2, lift(i), em.x - 0.4, em.y + i * 2 + 2, lift(i + 1), 0.5, colFoam, 255);
    }
  }
  // a tall light over wherever help is needed
  let goal = folk[0] || fires[0];
  if (goal) beam(goal.x, goal.y, goal.z + 30, goal.x, goal.y, goal.z + 150, 1.2, folk[0] ? colTrail : colFire, 80);
  if (wet) beam(wet.x, wet.y, wet.z + 8, wet.x, wet.y, wet.z + 150, 1.2, WATER, 110);
  if (gMode !== OVER && (fires[0] || gWater)) {
    // the buckets: pale when empty, blue with water in them, trailing a little behind
    for (let f of crew) {
      let x = f.x - Math.sin(f.yaw) * 2;
      let y = f.y + Math.cos(f.yaw) * 2;
      let z = Math.max(groundAt(x, y) + 0.5, f.z - ROPE - (f.agl < ROPE + 2 ? 2 : 0)); // the line pays out near the ground
      beam(f.x, f.y, f.z, x, y, z, 0.12, colOutline, 255);
      ball(x, y, z, 0.55, gWater ? GLASS : PLUME);
    }
  }

  for (let s of shots) {
    if (!s.k) beam(s.x, s.y, s.z, s.x - s.vx * 0.025, s.y - s.vy * 0.025, s.z - s.vz * 0.025, 0.6, colFire, 255);
    else ball(s.x, s.y, s.z, s.k === 2 ? 1 : s.r, s.k === 2 ? GLASS : GLOW, s.k === 1);
  }
}

// A flyer's gunsight: four corners round whatever its guns are tracking, or dead ahead.
function drawSight(f) {
  let t = f.lock;
  let ok = t ? project(t.x, t.y, t.z) : project(f.x + f.ax[3] * 60, f.y + f.ax[4] * 60, f.z + f.ax[5] * 60);
  if (!ok) return;
  let r = t ? Math.max(5, t.r * prM + 3) | 0 : 4;
  let c = t ? colRed : f.id ? GOLD : colTrail;
  let x = prX | 0;
  let y = prY | 0;
  for (let i = 0; i < 3; i++) {
    for (let s = 0; s < 4; s++) {
      let sx = s & 1 ? 1 : -1;
      let sy = s & 2 ? 1 : -1;
      for (let n = 0; n < 2; n++) {
        let px = x + sx * (r - (n ? i : 0));
        let py = y + sy * (r - (n ? 0 : i));
        if (px >= 0 && px < BW && py >= 0 && py < BH) FB[py * BW + px] = c;
      }
    }
  }
}

// A hacked picture: rows torn sideways, bars of red.
function glitch(amount) {
  for (let n = 0; n < amount * 14; n++) {
    let y = (rand() * BH) | 0;
    let shift = ((spread() * 24 * amount) | 0) || 1;
    let row = y * BW;
    if (shift > 0) FB.copyWithin(row + shift, row, row + BW - shift);
    else FB.copyWithin(row, row - shift, row + BW);
    if (rand() < 0.3) for (let x = 0; x < BW; x++) FB[row + x] = mix(FB[row + x], colRed, 120);
  }
}

// ── the panel: lettering, gauges, radar and markers, drawn straight into the picture

// ── the instruments: laid straight over the picture, with no panels behind them. Lettering
// and gauges carry a dark edge instead, so they read over sky, snow and grass alike

let INK = pack(240, 246, 255);
let DIM = pack(176, 208, 232);
let GOLD = pack(255, 214, 90);
let WATER = pack(110, 180, 230);
let EDGE = pack(12, 22, 38); // the dark edge (the lettering's is the same colour)
let OFF = pack(44, 62, 84); // a lamp that is not lit
let TOP = 16; // marks keep this far from the top of the screen …
let VB = BH - 62; // … and stop here, clear of the instruments, the radio and the panel at the foot
let HW = CXS; // … and this far either side of the middle
let TX = 0; // lettering is shifted by this much: where a view drawn in the middle of the buffer ends up
let TY = 0;

function box(x, y, w, h, colour) {
  let x0 = Math.max(0, x | 0);
  let x1 = Math.min(BW, (x + w) | 0);
  let y1 = Math.min(BH, (y + h) | 0);
  for (let py = Math.max(0, y | 0); py < y1; py++) {
    for (let p = py * BW + x0, e = py * BW + x1; p < e; p++) FB[p] = colour;
  }
}

// Lettering is the engine's own text, laid over the picture, in VT323 — a terminal typeface
// (SIL Open Font License), cut down to the characters the game uses and carried here as
// base64 with `_` standing for `/`. The labels are kept and used again every frame; one is
// only redrawn when what it says, its size or its colour changes.
let FONT =
  'd09GMgABAAAAAAesAAsAAAAAMwgAAAdgAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAABmAAgVwRCAreGMloATYCJAOBXAtwAAQgBQYHIBunJ1GUD8o8iJ8HtjH1oQVFgJYhgTKWLXFIHB7e3fW9AiEMaGDxLwhKl+69TKjR+BU6A8ksA5+RFWSFuUuFUAFRB6wuSEWrmdTO+z1j7k_sboJYVG2mnbeGy5WARte4VBHTGx4SrP8B6h93HeGxPP_7pT_Lf9QmJEqVpnEq_czsJrm0_ktTFAdy7zt338++3dCLRBjGM74LicN1oRAKozEiNpKnLEvVXRLfjV2lvIW6zyBMTBgmEA6BXcZqoO98B2IWZfgAwqNxHqjxRSf2TR7kKdH80NLUgLCkfIAAEAeM2UEaGhCAssNAQ5wNw0P4F0kjDEinhFrqmMg0zuARnrHJLoccc85VCJBGATZ1tDAJ6WMI7V+EMihXEmj+sqVc45+RII0MAHJ4v0tQQgXFlFNKGYG0+PsQTQyxxJFAIkkko2OQQhCTEYxkFAIRQiIA1QCsBMZB8h2gVwIJQBLvswE0M_QClxP4p0mwiZYEPgjCzYQ1m9AUQYU6pU14wDA+r2zU9UmNhY1fTzcsWvl3TffmgovD5cXG9LUb9EnFM_RJaqWxcrVvsL6d0tNjiisnNcSrmMzEjtYQPac4JiREz86PodSQaTGZrUYMPZuz6I+iJTEQfCVUoSuFv_tgA9EH23NyRgsEU7ohTbvwOg637CfVJExsiXM3gUFXk+iJhLfySUVjkjbKjgCxU_F9koImCIuKDGjamGE6okMczUhrcAtX8c87FakJde+NqyZa0MqgNDqWGz23gJDmZJM2pB5Y_DeljUYpv4Re1NHcSTeugWhBd25ykLBzyKgGuHR2A4T4Cq7moZ6zgGO6BvA9yWt+TJL7AqoOyA+7oF64dPy5m7UY152ikecxe3jycWacLsUQ3QMlMQw5ZLghVhSGahpZrZYqTKGeSY34ldLDPWcTvdrzOErnMSBcsPVIgyE01wVOIvZGtB+Pz6kQ6HYU0sLZ2rMUZ4mJ7hath6UXBLBja2F5oaFALaTV1fgkGgMOXMgv9iTD+II6u9qLUwN7cWKaNOy6yJ+4NrWMXzjLUxSIn3udzEhe_WCUV3t+gsEN8zhu05XrmfE2Szkwn+P86Ss_4UrPzw05uk2UzcH7ulynS5KxOyU9XY0KVeXOPaT2Bv70Hzsv2nLYWSzYI5F2WrvjsJKhJuTPQ9iaE8MBMYju5kBIrxsqLFIZH_xpXXLOkDAb6nqoBLIYMaSuuqNTTiLxc5ljny4N72seKtLVrprGF02Zvuxvk8EUE7Z4BVL37ptuL6dhJA8+f6vMyW4yg7ZjB80mkJyu0JV9+d0ZIl_JZsTEgCKndsWJDTvwVqsZl_W+ysSCiVMSC_4f26QIi+JkW6yx9cyDg0GzyW0np0j56GnTWE3jmKTrVDPxVBaLrq4UD9s5svnUQrrNk0hJdQdW9qWP+OgHjt8nFkO1YFm0WP_VK8BZPN3E4O0HOLSf7i0VJTMMF4KKwIaj56IGSBR8eQ_kLZJN4kC6OAeL_+YkaUP6lCoSonanFDD66wHWl9C9iyr_nlh6ZHhWdnhM0jWEJvLeDeg0oHTSEHmI1EPKoFN3j6QI0KDgOngdAaUvZ2QyGD5uoIVRX1wVXWJTbUk0gHPziCplDVILhpYAcLnFrSjEp0g3FE+LgFXkHTmNHZdJLiJFKDQxSF0cy4g0XkOi3CSn98qeefngdPvJCwcmak+x4IAzBoyybjp20SqkkgiLiBrxj_cw9_fQe2UP5G+e2YW_6rR4t_A94hsI1ky9+Q1DfHtzU0DDwE9objJjjAgZML1UP93I0rXH6JYc0FskLDN6oTNWS8ZY5xDSgDHFjEUUtzJVDZL5VBfZTG3+kU4MdE5YhwYTLiIRfHrHrfFL68TmMisRN3q1JzNUs46IBUHf71Hcfpiq0wPraiXekIosIwo66byuyeAif77tZo3D8zctpmzldcGtj8YzIPWFlGHMPwo0uWnrJBUhsbMDUe3HvEOV8xQBKMfWsjKIDFamHjobluS_WSJehMvmARcQj6sVHNIb5DawYP1BCWEpwPhmo5TtySrnGPe2iK7ck4S1+3i6+efDAUrui+rUwHZB4I_CyuHoIo4K394jQrK7d+zssDjIuDwNmkSpJK4JsSWW+cVvRiGYcoiufAsDvYI9VZBdF_3Tc5Xr3GxNs5zd5bUv2XPCUW5zu8Xh9zmFKYLFY7r54VDTCOFJhsGxI1KtetcbB7PM4K0Y7sPLFWDmaXSX_6o5eVQO_E1yavzGWq1p+CY6T8Bws0K3Lmv2dPguQOFVTolJQVP8vsZkbFdCdjmn7bpJmk6ZzklRkqBaPdTYMDGRxPISt0rtlNL5xTu_O8JWDee7cpoUtW8fMtCBSKrEBE6DJADIArFcS0sAATgXpT42JapHaSY_gI9nV14D+JSx++5_uSCDzxwURBIAQICWpgaIAwjL_I1K_b5YLSYA2F3W6v5MdW9OUWg3MqtM1PRayXVrCm5JOUrr38FDszveLBCvif439cP_GQRQzXesvMaufk+r2h6BdjUhKwMjYQY=';
let LABELS = [];
let SIZES = [0, 24, 42, 63, 104]; // a letter is 0.4 of its size wide: 4.8 of the picture's pixels in the smallest
let labelN = 0;
let lit = 0; // the buttons that lettering on screen names this frame, a bit each …
let was = 0; // … and those it named in the last: the panel shows them lit
let scene;
// align: 0 from x · 1 centred on x · 2 ending at x; x and y are in the picture's own pixels
// `plain` leaves off the dark edge, for lettering that has something solid behind it
function text(str, x, y, colour, size, align, plain) {
  let t = LABELS[labelN++];
  if (!t) LABELS.push((t = scene.add.text(0, 0, '', { fontFamily: 'V, monospace' })));
  str = String(str);
  size = SIZES[size || 1];
  let edge = plain ? 0 : Math.min(10, 2.5 + size / 12);
  for (let m of str.matchAll(/B(?:OTÓN )?([1-6])|(?:CON|EL|O) ([1-6])\b/g)) lit |= 1 << (m[1] || m[2]);
  if (t.text !== str) t.setText(str);
  if (t.size !== size) t.setFontSize((t.size = size));
  if (t.edge !== edge) t.setStroke('#0c1626', (t.edge = edge)).setLineSpacing(-edge * 2 - 4); // (the edge would space the lines out)
  if (t.ink !== colour) {
    t.ink = colour;
    t.setColor('#' + (((colour & 255) << 16) | (colour & 0xff00) | ((colour >> 16) & 255)).toString(16).padStart(6, '0'));
  }
  t.setOrigin((align || 0) / 2, 0.2).setPosition((x + TX) * PX, (y + TY) * PX).setVisible(true);
}

// The crew's portraits: their heads as voxel models, lit like the flyers, painted in front
// of everything — in profile, turned a little towards the viewer and never quite still.
// `flip` faces it left.
let HEADS = [0, 1].map((id) => ({ id, ax: new Float32Array(9), thr: 0, flex: 0 }));
function face(who, x, y, s, flip) {
  let f = HEADS[who];
  let t = 0.85 + Math.sin(now * 1.4 + who) * 0.15;
  let c = Math.cos(t) * (flip ? -1 : 1);
  let n = Math.sin(t);
  let a = f.ax;
  a[3] = rgtX * c - fwdX * n; // its nose points across the screen, and out of it a little
  a[4] = rgtY * c - fwdY * n;
  a[0] = -a[4];
  a[1] = a[3];
  a[2] = a[5] = a[6] = a[7] = 0;
  a[8] = 1;
  for (let i = 0; i < 9; i += 3) {
    // tipped a little towards the viewer, to show the top of the head
    let d = a[i] * fwdX + a[i + 1] * fwdY;
    let tc = who ? 0.95 : 1; // (the monito; the frog is seen level)
    let ts = who ? 0.31 : 0;
    let e = d * tc - a[i + 2] * ts - d;
    a[i + 2] = d * ts + a[i + 2] * tc;
    a[i] += fwdX * e;
    a[i + 1] += fwdY * e;
  }
  f.m = MODELS[who + 2];
  paint(f, x, y, -500, who ? s * 1.2 : s);
}

// A gauge: a row of lamps, lit up to `share` of the way along, in a dark frame.
function gauge(x, y, w, share, colour, h) {
  let n = (w / 6) | 0;
  box(x - 1, y - 1, n * 6 + 1, (h || 5) + 2, EDGE);
  for (let i = 0; i < n; i++) box(x + i * 6, y, 5, h || 5, i < share * n ? colour : OFF);
}

function disc(x, y, r, colour) {
  for (let d = -r; d <= r; d++) {
    let w = Math.sqrt(r * r - d * d) | 0;
    box(x - w, y + d, 2 * w + 1, 1, colour);
  }
}
// One of the cabinet's buttons, by its number — or, for 0, its stick.
function key(n, x, y) {
  disc(x, y, 6, INK);
  disc(x, y, 5, n ? EDGE : OFF);
  if (n) text(n, x, y - 5, GOLD, 1, 1);
  else {
    box(x - 1, y - 5, 2, 6, DIM);
    disc(x, y - 6, 3, INK);
  }
}
// The cabinet's panel as it is laid out, with what each control does: the stick to the left,
// and two rows of three buttons (the sixth has no use).
let PANEL = ['DISPARO', 'GIRO IZQ', 'GIRO DER', 'IMPULSO', 'AGUA'];
// Any button that lettering on screen names is ringed in gold. Given an `x`, it is a small
// panel there, with no names: shown wherever a button is spoken of.
function panel(y, x) {
  let g = x ? 15 : 52; // from one button to the next …
  let r = x ? 14 : 24; // … and from one row to the other
  x = x || CXS - 30;
  key(0, x - g - (g > 15 ? 0 : 3), y + 6 + r / 2);
  if (g > 15) text('VOLAR', x - g, y + 26, INK, 1, 1);
  for (let n = 0; n < 6; n++) {
    let px = x + (n % 3) * g;
    let py = y + 6 + ((n / 3) | 0) * r;
    if ((was >> (n + 1)) & 1) disc(px, py, 8, GOLD);
    if (n < 5 || was & 64) key(n + 1, px, py);
    else disc(px, py, 5, OFF);
    if (g > 15 && n < 5) text(PANEL[n], px, py + 7, INK, 1, 1);
  }
}

// The game's name, in numerals of its own: slabs on a grid three cells by five, heavy and
// square, red, with a black body running back to a vanishing point under the middle of it.
let SLABS = ['111001111100111', '111101101101111', '111001001001001', '111100111001111']; // 2 0 7 5
function logo(y) {
  for (let i = 14; i >= 0; i--) {
    let k = 1 - i * 0.018;
    SLABS.forEach((d, n) => {
      for (let c = 0; c < 15; c++) {
        if (d[c] > 0) box(CXS + (n * 40 - 77 + (c % 3) * 11.5) * k, y + i * 1.6 + ((c / 3) | 0) * 9 * k, 12 * k + 1, 9 * k + 1, i ? 0xff000000 : colRed);
      }
    });
  }
}

// A name beside a mark: what it is, and what to do about it.
function tag(str, x, y, colour) {
  let w = str.length * 4.8 + 6;
  text(str, clamp(x, CXS - HW + w / 2 + 2, CXS + HW - w / 2 - 2), clamp(y, TOP + 2, VB - 13), colour, 1, 1);
}

// A mark for something the pilot cannot see: an arrowhead at the edge of the screen when it is
// out of view, a small frame where it is when it is in view but behind a hill or a cloud. Each
// carries its name plate. A place to go to (`always`) is marked even in plain sight, and says
// how far it is.
function mark(x, y, z, colour, label, always) {
  let dx = x - cam.x;
  let dy = y - cam.y;
  let v = dx * fwdX + dy * fwdY;
  let u = dx * rgtX + dy * rgtY;
  let w = 1 + cam.q * v;
  if (always) label += ' ' + ((Math.hypot(dx, dy) / 5) | 0) * 50 + ' M';
  let sx = CXS + u * 1e3; // behind the camera: it comes in from below
  let sy = BH * 3;
  if (w > 0.15) {
    sx = CXS + (cam.S / w) * u;
    sy = cam.cy - (cam.S / w) * (z - cam.zr + cam.k * v);
    if (sx > CXS - HW + 8 && sx < CXS + HW - 8 && sy > TOP + 8 && sy < VB - 8) {
      if (always || ZB[(sy | 0) * BW + (sx | 0)] < v - 3) {
        for (let i = 0; i < 4; i++) box(sx + (i & 1 ? 3 : -4), sy + (i & 2 ? 3 : -4), 2, 2, colour);
        tag(label, sx, sy - 18, colour);
      }
      return;
    }
  }
  let mid = (TOP + VB) / 2; // the monitor's own middle and half height
  let half = mid - TOP - 9;
  let ex = sx - CXS;
  let ey = sy - mid;
  let side = Math.abs(ex) * half > Math.abs(ey) * (HW - 9); // it leaves by the left or right edge
  let k = side ? (HW - 9) / Math.abs(ex) : half / Math.abs(ey);
  let px = CXS + ex * k;
  let py = mid + ey * k;
  for (let i = -1; i < 14; i++) {
    // the arrowhead, twice: a dark one a size larger, then the coloured one inside it
    let n = i < 8 ? i : i - 8;
    let c = i < 8 ? EDGE : colour;
    let o = i < 8 ? -1 : 0;
    if (side) box(px - Math.sign(ex) * (n + o), py - n, 1, 2 * n + 1, c);
    else box(px - n, py - Math.sign(ey) * (n + o), 2 * n + 1, 1, c);
  }
  if (side) tag(label, px - Math.sign(ex) * (label.length * 2.4 + 12), py - 5, colour);
  else tag(label, px, py - Math.sign(ey) * 13 - 5, colour);
}

// The radar: what is around `o` — one of the crew — nose up.
function radar(cx, cy, R, o) {
  for (let a = 0; a < TAU; a += 0.02) {
    // a ring, dark outside and pale inside, with nothing behind it
    for (let i = 0; i < 3; i++) box(cx + Math.sin(a) * (R + 1 - i), cy + Math.cos(a) * (R + 1 - i), 1, 1, i ? DIM : EDGE);
  }
  let sx = Math.sin(sq.yaw);
  let sy = -Math.cos(sq.yaw);
  let blip = (t, colour, size) => {
    let dx = t.x - o.x;
    let dy = t.y - o.y;
    let px = ((dy * sx - dx * sy) * R) / 170;
    let py = (-(dx * sx + dy * sy) * R) / 170;
    let d = Math.hypot(px, py) / (R - 2);
    if (d > 1) {
      px /= d;
      py /= d;
    }
    box(cx + px - size / 2 - 1, cy + py - size / 2 - 1, size + 2, size + 2, EDGE);
    box(cx + px - size / 2, cy + py - size / 2, size, size, colour);
  };
  for (let f of fires) blip(f, colFire, 2);
  for (let f of folk) blip(f, INK, 2);
  for (let s of shots) if (s.k === 1) blip(s, colRed, 1);
  for (let d of drones) blip(d, colRed, d.k ? 3 : 2);
  if (sat) blip(sat, colRed, 3);
  if (wet) blip(wet, WATER, 3);
  // the crew, and at the middle an arrowhead, nose up, for whose radar it is; north, round the rim
  for (let f of crew) blip(f, f.id ? GOLD : INK, 3);
  for (let n = 1; n < 4; n++) box(cx - n + 0.5, cy + n - 4, n * 2 - 1, 1, o.id ? GOLD : INK);
  text('N', cx - sx * (R + 6), cy + sy * (R + 6) - 5, INK, 1, 1);
}

function drawHud() {
  let blink = (now * 2) & 1;
  if (gMode !== PLAY) {
    let over = gMode === OVER;
    text('INCENDIOS, ALUVIONES Y DRONES DE IA ENEMIGA ASOLAN CHILE', CXS, 8, INK, 1, 1);
    text('RANITAS Y MONITOS SÚPER INTELIGENTES PILOTEAN LA DEFENSA', CXS, 21, DIM, 1, 1);
    if (over) text('FIN DEL VUELO', CXS, 62, INK, 4, 1);
    else {
      logo(44);
      text('RESCATE ENTRE DESASTRES NATURALES', CXS, 106, INK, 2, 1);
    }
    let naming = over && gName && gPos < 3;
    if (over) text('PUNTAJE ' + gScore, CXS, 104, GOLD, 2, 1);
    else if (blink) text('START 1: UN JUGADOR · START 2: DOS', CXS, 142, GOLD, 2, 1);
    if (naming) {
      text('¡ENTRASTE AL RANKING! TUS INICIALES:', CXS, 126, INK, 1, 1);
      text([...gName].map((c, i) => (i === gPos && blink ? ' ' : c)).join(' '), CXS, 140, GOLD, 3, 1);
      key(0, CXS - 60, 180);
      text('LETRA', CXS - 50, 176, DIM);
      key(1, CXS + 16, 180);
      text('SIGUIENTE', CXS + 26, 176, DIM);
    } else {
      if (over)
        text(
          gWhy === '¡KAMIKAZE!'
            ? 'CONSEJO: DERRIBA LOS DRONES ANTES DE QUE SE LANCEN, O ESQUÍVALOS CON UN GIRO'
            : gWhy === 'HACK'
              ? 'CONSEJO: SI TE HACKEAN, AGITA LA PALANCA Y MACHACA EL BOTÓN 1'
              : 'CONSEJO: TIRA LA PALANCA HACIA ATRÁS PARA SUBIR',
          CXS,
          124,
          INK,
          1,
          1,
        );
      // the table of records
      // (under the advice at the end of a flight; on the title down the left, clear of the show)
      if (BEST[0] && !over) text('MEJORES VUELOS', 10, 168, INK);
      BEST.forEach((e, i) => text(i + 1 + '. ' + e[0] + ' ' + String(e[1]).padStart(6, '0'), over ? CXS : 10, (over ? 142 : 183) + i * 12, i ? DIM : GOLD, 1, over));
    }
    face(0, 34, BH - 28, 2.5);
    face(1, BW - 34, BH - 28, 2.5, 1);
    text('DARWIN', 66, BH - 52, GOLD);
    text('MONITO', BW - 66, BH - 52, GOLD, 1, 2);
    panel(BH - 60);
    if (over && !naming && blink) text('START PARA VOLAR DE NUEVO', CXS, BH - 72, GOLD, 1, 1);
    return;
  }

  let goal = folk[0] || fires[0];
  let duty = folk[0]
    ? [(em.at ? 'ALUVIÓN' : 'TORMENTA') + ` · ${folk.length} POR RESCATAR`, 'PASA BAJITO SOBRE CADA BALIZA']
    : goal
      ? [`INCENDIO · ${fires.length} FOCOS`, gWater ? 'SUELTA EL AGUA ENCIMA CON B5' : 'MOJA EL BALDE EN EL MAR O UN RÍO']
      : sat
        ? ['SATÉLITE HACKER', 'SUBE A LA ESTRATÓSFERA Y DISPARA']
        : ['PATRULLA', 'DERRIBA DRONES · VUELA BAJO'];
  let weather = `CALOR ${(30 + dry() * 12) | 0} · HUMEDAD ${(30 - dry() * 20) | 0} · VIENTO ${(20 + dry() * 50) | 0}`;
  // With two aboard the picture is split — a view each, one above the other — and each has
  // the same instruments beside their own view, in a column down the right: D is how far
  // right that is (0 alone). There a long line is broken in two, to fit.
  let D = crew[1] ? 260 : 0;
  let fit = (s) => {
    let i = s.lastIndexOf(' ', s.length / 2 + 4);
    return s.length > 26 ? s.slice(0, i) + '\n' + s.slice(i + 1) : s;
  };
  if (D) {
    box(260, 0, 140, BH, 0xff000000);
    box(0, 149, BW, 2, OFF);
  }
  (D ? crew : [lead]).forEach((f, i) => {
    let oy = i * 150;
    let ink = f.id ? GOLD : INK;
    // the score (their own, with two), the multiplier, and how long the crew has kept low
    text('PUNTAJE', D + 6, oy + 5, DIM);
    if (gAgl < 8) text('VUELO BAJO', D + 116, oy + 5, GOLD, 1, 2);
    text(String(D ? f.sc : gScore).padStart(6, '0'), D + 6, oy + 16, ink, 2);
    text('×' + gMult, D + 116, oy + 16, gMult > 1 ? GOLD : DIM, 2, 2);
    if (gLow > 0.1) {
      box(D + 5, oy + 32, (gLow / 10) * 110 + 2, 4, EDGE);
      box(D + 6, oy + 33, (gLow / 10) * 110, 2, GOLD);
    }

    // shield and water (the crew's), and their own boost
    let gy = oy + (D ? 32 : 0);
    let lx = D ? 266 : 288; // in the column they line up with the rest, and run its width
    let gx = lx + (D ? 50 : 40);
    let gw = D ? 78 : 66;
    text('ESCUDO', lx, gy + 5, DIM);
    gauge(gx, gy + 7, gw, gShield / 100, gShield < 30 ? colRed : INK);
    text('IMPULSO', lx, gy + 16, DIM);
    gauge(gx, gy + 18, gw, f.stam / 100, ink);
    text('AGUA', lx, gy + 27, DIM);
    box(gx - 1, gy + 28, gw + 1, 7, EDGE);
    for (let n = 0; n < 3; n++) box(gx + (n * gw) / 3, gy + 29, gw / 3 - 1, 5, n < gWater ? WATER : OFF);

    // height: the ground rising from the foot of the scale, the cloud base and the
    // stratosphere ruled across it, and the flyer
    let foot = D ? oy + 145 : BH - 6;
    let rung = (z) => foot - Math.sqrt(clamp(z, 0, CEILING) / CEILING) * 34;
    box(D + 5, foot - 35, 6, 36, OFF);
    box(D + 6, rung(gGnd), 4, foot - rung(gGnd), DIM);
    box(D + 4, rung(CA), 8, 1, INK);
    box(D + 4, rung(STRATO), 8, 1, INK);
    box(D + 3, rung(f.z) - 1, 10, 2, ink);
    text('ALTURA', D + 18, foot - (D ? 34 : 38), DIM);
    text((f.agl | 0) * 10, D + 18, foot - (D ? 24 : 28), INK, 2); // in tens: every change of a label is a redraw of it
    radar(D ? 374 : BW - 30, D ? oy + 127 : BH - 30, D ? 17 : 24, f);
    if (D) {
      // which view is whose; the job in hand; and the news, or how the job is done
      text(i + 1, 4, oy + 3, ink);
      if (was) panel(oy + 4, 214);
      text(duty[0], 266, oy + 73, GOLD);
      text(fit(gHacked ? 'HACKEADO: AGITA LA PALANCA Y MACHACA B1' : gChan > 0 ? 'HACKEO ENTRANTE: GIRA O DISPARA' : gMsgT > 0 ? gMsg : fires[0] ? weather : duty[1]), 266, oy + 85, gHacked || gChan > 0 ? colRed : fires[0] && gMsgT <= 0 ? colFire : INK);
    }
  });

  if (gShield < 30 && (now * 4) & 1) {
    // little shield left: the frame flashes
    box(0, 0, BW, 2, colRed);
    box(0, BH - 2, BW, 2, colRed);
    box(0, 0, 2, BH, colRed);
    box(BW - 2, 0, 2, BH, colRed);
  }
  if (D) return;

  // alone: the job in hand across the top, and how it is done; with a fire burning, the
  // weather it burns in
  text(duty[0], CXS, 5, goal || sat ? (blink ? GOLD : INK) : GOLD, 1, 1);
  text(duty[1], CXS, 17, INK, 1, 1);
  if (fires[0]) text(weather, CXS, 29, colFire, 1, 1);
  text('METROS', 18, BH - 17, DIM);

  // bottom middle: the radio — whoever is talking and the line as far as it has been said —
  // or, with the radio quiet, what the buttons do
  if (talk[1]) {
    // dark words on a white card of their own — a thin black edge, its corners a little
    // rounded — as wide as the longer line, so nothing in the scene shows through them (the
    // marks and their names keep above it); the head stands free
    let w = Math.max(...talk[1].split('\n').map((l) => l.length)) * 4.8 + 22;
    box(113, BH - 61, w - 2, 56, 0xff000000);
    box(112, BH - 60, w, 54, 0xff000000);
    box(114, BH - 60, w - 4, 54, INK);
    box(113, BH - 59, w - 2, 52, INK);
    face(talk[0], 82, BH - 30, 2.5);
    text((talk[0] ? 'MONITO' : 'DARWIN') + ' · BOTÓN 6: SALTAR', 123, BH - 54, colRed, 1, 0, 1);
    text(talk[1].slice(0, ((talkT * 13) | 0) * 3), 123, BH - 40, EDGE, 1, 0, 1);
  } else if (gT < 60) {
    // with the radio quiet, for the first minute: what the buttons do
    if (gScore && blink) text('START 2: SE SUMA EL MONITO', CXS, BH - 72, GOLD, 1, 1);
    panel(BH - 60);
  } else if (was) panel(BH - 98, 332);
  if (was && talk[1]) panel(BH - 98, 332);
  if (!gScore && drones[0] && blink) {
    key(1, CXS - 112, BH - 71);
    text('MANTÉN APRETADO Y DISPARA', CXS + 8, BH - 78, GOLD, 2, 1);
  }
  if (pop && now < pop.t && project(pop.x, pop.y, pop.z)) text(pop.s, prX, prY - 22 + (pop.t - now) * 10, GOLD, 2, 1);
  marks();

  // what is going on, across the top of the picture
  if (gHacked) {
    text('¡HACKEADO!', CXS, 48, colRed, 3, 1);
    text('AGITA LA PALANCA Y MACHACA B1', CXS, 74, INK, 1, 1);
    gauge(CXS - 78, 88, 156, gPurge, INK);
  } else if (gChan > 0) {
    text('HACKEO ENTRANTE: GIRA O DISPARA', CXS, 48, colRed, 2, 1);
    gauge(CXS - 78, 66, 156, gChan, colRed);
  } else if (gMsgT > 0) text(gMsg, CXS, 48, INK, gMsg.length > 30 ? 1 : 2, 1);
}

// Marks: what cannot be seen and where to go, each with what to do.
function marks() {
  let goal = folk[0] || fires[0];
  for (let d of drones) mark(d.x, d.y, d.z, colRed, d.k ? 'HACKER' : d.kz ? '¡KAMIKAZE! GIRA' : 'DRON', d.kz);
  if (sat) mark(sat.x, sat.y, sat.z, colRed, sat.z - sq.z > 30 ? 'SATÉLITE: SUBE' : 'SATÉLITE: DISPARA', 1);
  if (folk[0]) mark(goal.x, goal.y, goal.z + 4, INK, 'RESCATE: PASA BAJITO', 1);
  else if (goal) mark(goal.x, goal.y, goal.z + 4, colFire, gWater ? 'FUEGO: SUELTA B5' : 'FUEGO', gWater);
  if (wet) mark(wet.x, wet.y, wet.z + 3, WATER, 'AGUA: MOJA EL BALDE', 1);
}

// The scene as the camera stands: the land, the sky, and everything in them.
function view(alive) {
  nSJ = 0;
  if (alive) {
    for (let f of crew) {
      let o = nSJ++ * 6;
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
    for (let f of crew) {
      if (f.inv > 0 && (now * 12) & 1) continue; // it blinks while it is safe from harm
      drawFlyer(f);
    }
  }
  drawThings();
  if (alive) crew.forEach(drawTrails);
  drawPuffs();
  if (gWet > 0.02) {
    // under a storm the light goes grey and the rain comes down slanting (above its clouds
    // there is none of it)
    for (let p = 0; p < FB.length; p++) FB[p] = mix(FB[p], STORM, (gWet * 100) | 0);
    for (let n = 0; n < gWet * 160; n++) {
      let x = (n * 53.7 + now * 90) % (BW + 40);
      let y = (n * 97.3 + now * (520 + (n % 7) * 45)) % (BH + 30);
      for (let i = 0; i < 8; i++) {
        let px = (x - i * 0.5) | 0;
        let py = (y - i * 2) | 0;
        if (px >= 0 && px < BW && py >= 0 && py < BH) FB[py * BW + px] = mix(FB[py * BW + px], colShot, 90);
      }
    }
  }
  if (gMode === PLAY && !gHacked) crew.forEach(drawSight);
}

let KEEP = new Uint32Array(BW * BH); // the two views of a split screen, while they are put together
function drawFrame() {
  fwdX = Math.sin(cam.yaw);
  fwdY = -Math.cos(cam.yaw);
  rgtX = -fwdY;
  rgtY = fwdX;
  invMs = 1 / MODEL_SCALE;
  sunR = LIGHT[0] * rgtX + LIGHT[1] * rgtY;
  sunU = LIGHT[2];
  sunC = -(LIGHT[0] * fwdX + LIGHT[1] * fwdY);
  let alive = gMode !== OVER;

  for (let t of LABELS) t.setVisible(false);
  labelN = 0;
  was = lit;
  lit = 0;
  if (gMode === PLAY && crew[1]) {
    // two aboard: a view each, 260 by 150, cut from the middle of the picture as each one's
    // own camera sees it and laid one above the other down the left
    let { x, y, zr } = cam;
    VX0 = 70;
    VX1 = 330;
    VYB = VB = 240;
    TOP = 92;
    HW = 130;
    TX = -70;
    crew.forEach((f, i) => {
      cam.x = x + f.x - sq.x;
      cam.y = y + f.y - sq.y;
      cam.zr = f.z;
      TY = i * 150 - 90;
      view(alive);
      marks();
      for (let r = 0; r < 150; r++) KEEP.set(FB.subarray((90 + r) * BW + 70, (90 + r) * BW + 330), (i * 150 + r) * BW);
    });
    cam.x = x;
    cam.y = y;
    cam.zr = zr;
    VX0 = TX = TY = 0;
    VX1 = BW;
    VYB = BH;
    TOP = 16;
    VB = BH - 62;
    HW = CXS;
    FB.set(KEEP);
  } else view(alive);
  if (gHacked || gChan > 0.4) glitch(gHacked ? 1 : gChan * 0.5);
  if (gFlash > 0.02) {
    let a = (gFlash * 200) | 0;
    for (let p = 0; p < FB.length; p++) FB[p] = mix(FB[p], gHit ? colRed : colTrail, a);
  }
  drawHud();
}


// ───────────────────────────────────────────────────────────── Phaser

let config = {
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
let start = () => new Phaser.Game(config);
let type = new FontFace('V', Uint8Array.from(atob(FONT.replace(/_/g, '/')), (c) => c.charCodeAt(0)));
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
  for (let i = 0; i < 4; i++) buildModel(i);
  lead.m = MODELS[0];
  mate.m = MODELS[1];
  buildWorld(SEED);
  resetFlight();
  loadTop();
}

function update(time, delta) {
  let go = pressed.START1 || pressed.START2 || pressed.P1_1 || pressed.P2_1;
  if (gMode === OVER && gName && gPos < 3) {
    // initials for the table: the stick changes the letter, a button takes it (and a
    // cabinet left alone takes them as they stand)
    let up = pressed.P1_D || pressed.P2_D;
    if (up || pressed.P1_U || pressed.P2_U) gName = gName.slice(0, gPos) + String.fromCharCode(65 + ((gName.charCodeAt(gPos) - 65 + (up ? 1 : 25)) % 26)) + gName.slice(gPos + 1);
    if ((go || gT > 40) && ++gPos > 2) saveTop();
  } else if (gMode !== PLAY && gT > 1 && go) startGame(pressed.START2);
  else if (gMode === OVER && gT > 25) {
    // left alone, the end screen gives way to the title and its show
    gMode = TITLE;
    crew.length = 1;
    drones.length = 0;
    em = sat = null;
    resetFlight();
  }

  let dt = Math.min(delta / 1000, 0.1);
  if (dt > 0.05) {
    // a slow machine keeps real time: a long frame is flown in two steps
    dt /= 2;
    simulate(dt);
    for (let key in pressed) pressed[key] = false;
  }
  simulate(dt);
  sound();
  let t0 = performance.now();
  drawFrame();
  drawMs += (performance.now() - t0 - drawMs) * 0.1;
  coarse = clamp(coarse + (drawMs > 12 ? 0.03 : drawMs < 5 ? -0.03 : 0), 1, 2.4); // a slow machine draws the distance in longer steps, and then at half width
  frameTex.context.putImageData(frameData, 0, 0);
  frameTex.refresh();

  for (let key in pressed) pressed[key] = false;
}
})();
