/*
 * Iced Letters — every typed character freezes into a carved block of ice,
 * with ice flowers growing on its strokes.
 *
 * Keyboard: only typing and deleting do anything.
 *   typing      frost mist outlines the glyph, contracts into clear ice
 *   space       a small snowflake drifts down through the gap
 *   enter       a line break: the rest continues on the next line
 *   backspace   the last character melts away from the top down
 * Touch / mouse:
 *   tap         that character crumbles
 *   double tap  everything crumbles
 *   long press  that character melts
 *   drag        wipes the frost off the window
 */
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import opentype from 'opentype';


// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------
const TAU = Math.PI * 2;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const sat = v => clamp(v, 0, 1);
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (a, b, v) => { const t = sat((v - a) / (b - a)); return t * t * (3 - 2 * t); };
const easeOutCubic = t => 1 - Math.pow(1 - sat(t), 3);
const easeOutBack = t => { t = sat(t); const c = 1.6; return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2); };
const now = () => performance.now() / 1000;

function mulberry32(a) {
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hash2(i, j, seed) {
  let h = (Math.imul(i, 374761393) + Math.imul(j, 668265263) + seed) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
// Tileable value noise on a period-p lattice
function tnoise(x, y, p, seed) {
  const i = Math.floor(x), j = Math.floor(y), fx = x - i, fy = y - j;
  const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
  const m = k => ((k % p) + p) % p;
  const a = hash2(m(i), m(j), seed), b = hash2(m(i + 1), m(j), seed);
  const c = hash2(m(i), m(j + 1), seed), d = hash2(m(i + 1), m(j + 1), seed);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
// 1D value noise, for things that drift along a line
const noise1 = (x, seed) => tnoise(x, 0.5, 1 << 20, seed);

function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

const IS_MOBILE = matchMedia('(pointer: coarse)').matches;
// Render resolution: full detail (2x on a computer, 1.5x on a phone). The GPU
// is spared by drawing fewer frames at rest instead (see pacing()); only if
// full-rate frames still can't keep up does the resolution step down.
let PR = Math.min(window.devicePixelRatio || 1, IS_MOBILE ? 1.5 : 2);

// -----------------------------------------------------------------------------
// Renderer, scene, camera
// -----------------------------------------------------------------------------
const glCanvas = document.getElementById('gl');
const renderer = new THREE.WebGLRenderer({ canvas: glCanvas, antialias: false, powerPreference: 'high-performance' });
renderer.setPixelRatio(PR);
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.setClearColor(0x050a18, 1);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(32, innerWidth / innerHeight, 0.1, 100);
camera.position.set(0, 0, 8);

const rt = new THREE.WebGLRenderTarget(innerWidth * PR, innerHeight * PR, {
  type: THREE.HalfFloatType, samples: IS_MOBILE ? 0 : 4,
});
const composer = new EffectComposer(renderer, rt);
composer.setPixelRatio(PR);
composer.setSize(innerWidth, innerHeight);
composer.addPass(new RenderPass(scene, camera));
// Guard against stray invalid pixels: a single NaN/Inf from any shader would
// be smeared by the bloom into a block that flashes for a frame. Zero them,
// and cap extreme highlights so additive sparkles can't blow out either.
composer.addPass(new ShaderPass({
  uniforms: { tDiffuse: { value: null } },
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: `uniform sampler2D tDiffuse; varying vec2 vUv;
    void main(){
      vec4 c = texture2D(tDiffuse, vUv);
      bool bad = any(isnan(c)) || any(isinf(c));
      gl_FragColor = bad ? vec4(0.0, 0.0, 0.0, 1.0) : min(c, vec4(24.0));
    }`,
}));
const bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.5, 0.5, 0.86);
composer.addPass(bloom);
composer.addPass(new OutputPass());

// -----------------------------------------------------------------------------
// Environment: a cold "HDRI" built procedurally and prefiltered with PMREM.
// Big cool softboxes give the ice its crisp highlights; a warm band low behind
// stands in for the city lights.
// -----------------------------------------------------------------------------
function buildEnvironment() {
  const s = new THREE.Scene();
  s.add(new THREE.Mesh(
    new THREE.SphereGeometry(50, 48, 24),
    new THREE.ShaderMaterial({
      side: THREE.BackSide,
      vertexShader: 'varying vec3 vP; void main(){ vP = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: `varying vec3 vP;
        void main(){
          float y = vP.y;
          vec3 low = vec3(0.04, 0.06, 0.12), mid = vec3(0.12, 0.18, 0.32), hi = vec3(0.4, 0.55, 0.8);
          vec3 c = y < 0.0 ? mix(mid, low, -y) : mix(mid, hi, pow(y, 0.8));
          gl_FragColor = vec4(c, 1.0);
        }`,
    }),
  ));
  const panel = (w, h, hex, k, x, y, z) => {
    const m = new THREE.Mesh(
      new THREE.PlaneGeometry(w, h),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(hex).multiplyScalar(k), side: THREE.DoubleSide }),
    );
    m.position.set(x, y, z);
    m.lookAt(0, 0, 0);
    s.add(m);
  };
  panel(18, 10, 0xe2efff, 9, -14, 15, 18);   // key softbox, upper left front
  panel(4, 26, 0xbcd6ff, 7, 20, 3, 6);
  panel(22, 5, 0xd8e8ff, 4, 0, -4, 24);    // soft fill from the front, below
  panel(30, 14, 0x9fc0f0, 0.9, 4, 8, 30);   // broad cool sheen behind the viewer      // tall cool strip, right
  panel(26, 2.5, 0xffffff, 3.5, 0, 22, -4); // ceiling strip
  panel(4, 14, 0xa9c8ff, 3, -22, -2, -6);   // cool rim, left back
  panel(16, 4, 0xffa35a, 4.5, 16, -3, -16); // warm city glow, low behind right
  const R = mulberry32(42);
  for (let i = 0; i < 16; i++) {
    const a = R() * TAU, e = -0.25 + R() * 0.35;
    const m = new THREE.Mesh(
      new THREE.SphereGeometry(0.5 + R() * 0.9, 12, 8),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(R() < 0.7 ? 0xffb066 : 0xbfdcff).multiplyScalar(4 + R() * 6) }),
    );
    // Warm lights stay behind the text, so they only show through edges
    m.position.set(Math.cos(a) * 30 * Math.cos(e), Math.sin(e) * 30, -Math.abs(Math.sin(a)) * 30 * Math.cos(e) - 8);
    s.add(m);
  }
  const pm = new THREE.PMREMGenerator(renderer);
  const tex = pm.fromScene(s, 0.015).texture;
  pm.dispose();
  return tex;
}
// The environment (reflections on the ice) is built just after the first
// frame: nothing on screen needs it before a letter is typed

// Warm light grazing the ice from the side, behind: edges glow amber
const warmLight = new THREE.PointLight(0xffa760, 7, 0, 2);
warmLight.position.set(3.4, 1.2, -2.2);
scene.add(warmLight);
const keyDir = new THREE.Vector3(-0.55, 0.62, 0.72).normalize(); // matches the key softbox
const keyLight = new THREE.DirectionalLight(0xdfeeff, 0.6);
keyLight.position.copy(keyDir).multiplyScalar(10);
scene.add(keyLight);

// -----------------------------------------------------------------------------
// Background: a frosted window at dusk, painted procedurally.
//   1. the scene behind the glass — sky, bare trees, a snowy house with one
//      lit window — painted tiny and upscaled, so it is heavily out of focus
//   2. a thin, uneven fog on the glass
//   3. feathery frost ferns growing in from every edge, thinning toward the middle
// -----------------------------------------------------------------------------
const BG_Z = -9;
// Two paintings of the window: frosted, and the same glass wiped clear. A small
// mask canvas (red = wiped) blends them: fingers wipe it, and it slowly
// fades back to frost.
const bgMat = new THREE.ShaderMaterial({
  uniforms: {
    map: { value: null }, clearMap: { value: null }, mask: { value: null },
    uTexel: { value: new THREE.Vector2(1 / 384, 1 / 384) }, uAspect: { value: 1 },
  },
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  // mask.r: where a finger has wiped the glass
  fragmentShader: `uniform sampler2D map, clearMap, mask; uniform vec2 uTexel; uniform float uAspect; varying vec2 vUv;
    float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
    float vnoise(vec2 p) {
      vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
      return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
    }
    void main(){
      vec4 mk = texture2D(mask, vUv);
      vec2 g = vUv * vec2(1.0, 1.0 / uAspect);
      // Wiped glass: the frost breaks off raggedly at the edge of the stroke
      // (and grows back the same way), never a soft blurry blob
      float n = vnoise(g * 70.0) * 0.6 + vnoise(g * 170.0) * 0.4;
      float wipeK = smoothstep(0.28, 0.4, mk.r - (n - 0.5) * 0.45);
      vec3 frosted = texture2D(map, vUv).rgb;
      vec3 clear = texture2D(clearMap, vUv).rgb;  // clean glass: sharper, no frost
      vec3 c = mix(frosted, clear, wipeK);
      // Fine beads of moisture left on the wiped glass
      vec2 cell = g * 150.0, id = floor(cell), f = fract(cell) - 0.5;
      vec2 o = (vec2(hash(id), hash(id + 7.0)) - 0.5) * 0.5;
      float r = 0.1 + 0.16 * hash(id + 3.0);
      float bead = (1.0 - smoothstep(r * 0.55, r, length(f - o))) * step(0.6, hash(id + 11.0)) * wipeK;
      c *= 1.0 - 0.12 * bead;
      float hl = 1.0 - smoothstep(0.0, r * 0.32, length(f - o - vec2(-0.3, 0.3) * r));
      c += vec3(0.55, 0.66, 0.85) * hl * bead * 0.3;
      gl_FragColor = vec4(c, 1.0);
    }`,
  depthWrite: false,
});
const bgMesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), bgMat);
bgMesh.position.z = BG_Z;
bgMesh.renderOrder = -10;
scene.add(bgMesh);

// Redraw a canvas at a fraction of its size: a cheap, even blur when upscaled
function soften(c, k) {
  const s = canvas(Math.max(1, Math.round(c.width * k)), Math.max(1, Math.round(c.height * k)));
  const g = s.getContext('2d');
  g.imageSmoothingQuality = 'high';
  g.drawImage(c, 0, 0, s.width, s.height);
  return s;
}


// Bare tree: a trunk splitting into ever finer branches
function bareTree(g, R, x, y, ang, len, w, d) {
  const x2 = x + Math.cos(ang) * len, y2 = y + Math.sin(ang) * len;
  g.lineWidth = w;
  g.beginPath(); g.moveTo(x, y); g.lineTo(x2, y2); g.stroke();
  if (d > 6 || len < 3) return;
  bareTree(g, R, x2, y2, ang + (R() - 0.5) * 0.3, len * 0.78, w * 0.7, d + 1);
  if (R() < 0.85) bareTree(g, R, x2, y2, ang + (R() < 0.5 ? -1 : 1) * (0.3 + R() * 0.5), len * 0.62, w * 0.55, d + 1);
}

// The world outside, as if seen through fogged glass
function paintOutside(w, h, R) {
  const c = canvas(w, h), g = c.getContext('2d');
  let gr = g.createLinearGradient(0, 0, 0, h);
  gr.addColorStop(0, '#1a2338');
  gr.addColorStop(0.5, '#2c3a56');
  gr.addColorStop(0.68, '#36456a');
  gr.addColorStop(1, '#2a3754');
  g.fillStyle = gr; g.fillRect(0, 0, w, h);

  const ground = h * 0.66;
  // Distant tree line and a few large bare trees on the left
  g.strokeStyle = 'rgba(34,46,70,0.55)';
  g.lineCap = 'round';
  for (let i = 0; i < 26; i++) {
    const x = R() * w, s = h * (0.12 + R() * 0.12);
    bareTree(g, R, x, ground, -Math.PI / 2 + (R() - 0.5) * 0.1, s * 0.3, s * 0.03, 0);
  }
  g.strokeStyle = 'rgba(26,36,58,0.85)';
  for (let i = 0; i < 4; i++) {
    const x = w * (0.08 + R() * 0.3), s = h * (0.45 + R() * 0.3);
    bareTree(g, R, x, ground + h * 0.05, -Math.PI / 2 + (R() - 0.5) * 0.15, s * 0.32, s * 0.035, 0);
  }

  // A snow-roofed house with one warm lit window
  // Near the middle, so a narrow phone screen shows it clear of the edge frost
  const hx = w * 0.57, hw = w * 0.26, hy = ground - h * 0.16, hh = h * 0.2;
  g.fillStyle = '#323f5c';
  g.fillRect(hx - hw / 2, hy, hw, hh);
  g.fillStyle = '#c9d4e6'; // snow on the roof
  g.beginPath();
  g.moveTo(hx - hw * 0.6, hy + h * 0.01);
  g.lineTo(hx - hw * 0.1, hy - h * 0.11);
  g.lineTo(hx + hw * 0.6, hy - h * 0.11);
  g.lineTo(hx + hw * 0.62, hy + h * 0.01);
  g.closePath(); g.fill();
  const lamps = [[hx, hy + hh * 0.42]];
  for (const [lx, ly] of lamps) {
    // A wider, warmer glow so the windows still read once heavily blurred
    gr = g.createRadialGradient(lx, ly, 0, lx, ly, hw * 0.34);
    gr.addColorStop(0, 'rgba(255,198,120,0.95)');
    gr.addColorStop(0.45, 'rgba(255,178,98,0.4)');
    gr.addColorStop(1, 'rgba(255,170,90,0)');
    g.fillStyle = gr; g.fillRect(lx - hw * 0.34, ly - hw * 0.34, hw * 0.68, hw * 0.68);
    g.fillStyle = '#ffd394';
    g.fillRect(lx - hw * 0.045, ly - hh * 0.11, hw * 0.09, hh * 0.22);
  }

  // Snowy ground
  gr = g.createLinearGradient(0, ground, 0, h);
  gr.addColorStop(0, '#56668a');
  gr.addColorStop(1, '#36445f');
  g.fillStyle = gr;
  g.beginPath();
  g.moveTo(0, h);
  for (let x = 0; x <= w; x += 8) g.lineTo(x, ground + Math.sin(x * 0.01) * h * 0.01);
  g.lineTo(w, h);
  g.fill();

  return c;
}

// A frost fern on the glass: a curving stem with needles at ±60°, and the
// needles carry their own finer needles. Returns nothing; draws into g.
function frostFern(g, R, x, y, ang, len, w, level) {
  const step = Math.max(2, len / 26);
  const bend = (R() - 0.5) * 0.04;
  for (let s = 0; s < len; s += step) {
    ang += bend + (R() - 0.5) * 0.13;
    const x2 = x + Math.cos(ang) * step, y2 = y + Math.sin(ang) * step;
    g.lineWidth = w * (1 - (s / len) * 0.6);
    g.beginPath(); g.moveTo(x, y); g.lineTo(x2, y2); g.stroke();
    if (level < 2 && s > step && R() < 0.75) {
      const rem = 1 - s / len;
      for (const side of [-1, 1]) {
        if (R() < 0.3) continue;
        const l = len * (0.1 + 0.3 * rem) * (0.5 + R() * 0.6) * (level ? 0.6 : 1);
        frostFern(g, R, x2, y2, ang + side * (Math.PI / 3) * (0.75 + R() * 0.45), l, w * 0.6, level + 1);
      }
    }
    x = x2; y = y2;
  }
}

function paintFrost(w, h, R) {
  const c = canvas(w, h), g = c.getContext('2d');
  const m = Math.min(w, h);
  g.lineCap = 'round';
  // Seeds along every edge. Frost on a real window is uneven: each side and
  // each corner gets its own weight, and density and reach drift along the
  // edge (low-frequency noise), leaving thick drifts next to thinner gaps.
  const seeds = [];
  const sideW = [0.75 + R() * 0.6, 0.75 + R() * 0.6, 0.75 + R() * 0.6, 0.75 + R() * 0.6]; // top, right, bottom, left
  const cornerW = [0.6 + R() * 0.9, 0.6 + R() * 0.9, 0.6 + R() * 0.9, 0.6 + R() * 0.9];   // TL, TR, BR, BL
  const perimeter = 2 * (w + h), n = Math.round(perimeter / (m * 0.022));
  const nSeed = (R() * 1000) | 0;
  for (let i = 0; i < n; i++) {
    const t = R() * perimeter;
    let x, y, inward, side;
    if (t < w) { x = t; y = 0; inward = Math.PI / 2; side = 0; }
    else if (t < w + h) { x = w; y = t - w; inward = Math.PI; side = 1; }
    else if (t < 2 * w + h) { x = t - w - h; y = h; inward = -Math.PI / 2; side = 2; }
    else { x = 0; y = t - 2 * w - h; inward = 0; side = 3; }
    const drift = noise1((t / perimeter) * 9, nSeed);           // uneven along the edge
    if (R() > 0.35 + 0.65 * drift) continue;                      // gaps where the drift is thin
    // Nearest corner and how close we are to it
    const cx = x < w / 2 ? 0 : 1, cy = y < h / 2 ? 0 : 1;
    const ci = cy === 0 ? (cx === 0 ? 0 : 1) : (cx === 0 ? 3 : 2);
    const near = 1 - Math.min(Math.hypot(x - cx * w, y - cy * h) / (m * 0.6), 1);
    const len = m * (0.07 + R() * 0.17) * sideW[side] * (0.6 + 0.8 * drift) * (1 + near * cornerW[ci]);
    seeds.push([x, y, inward + (R() - 0.5) * 1.3, len]);
  }
  // On a tall phone screen the frost grows thicker along the right edge
  const tall = h > w;
  if (tall) {
    const extra = Math.round(h / (m * 0.045));
    for (let i = 0; i < extra; i++) {
      seeds.push([w, R() * h, Math.PI + (R() - 0.5) * 1.3, m * (0.16 + R() * 0.24)]);
    }
  }
  // A faint shadow first, offset, for relief; then the bright frost
  for (const pass of [0, 1]) {
    g.save();
    if (!pass) { g.translate(1.2, 1.6); g.strokeStyle = 'rgba(12,20,40,0.35)'; }
    else g.strokeStyle = 'rgba(214,230,250,0.5)';
    const RR = mulberry32(77); // same ferns in both passes
    for (const [x, y, a, len] of seeds) frostFern(g, RR, x, y, a, len, 1.6, 0);
    // Crust: countless tiny crystal fragments, crowding toward the edges
    for (let i = 0; i < (w * h) / 1100; i++) {
      const x = RR() * w, y = RR() * h;
      const d = Math.min(x / sideW[3], y / sideW[0], (w - x) / sideW[1] * (tall ? 0.55 : 1), (h - y) / sideW[2]) / (m * 0.38);
      if (RR() > Math.pow(Math.max(0, 1 - d), 2.2)) continue;
      frostFern(g, RR, x, y, RR() * TAU, m * (0.006 + RR() * 0.012), 1, 1);
    }
    g.restore();
  }
  // Dense rime along the very edges of the pane
  for (const [x0, y0, x1, y1] of [[0, 0, 0, h], [0, 0, w, 0]]) {
    const lg = g.createLinearGradient(x0, y0, x1, y1);
    lg.addColorStop(0, 'rgba(200,218,240,0.42)');
    lg.addColorStop(0.12, 'rgba(200,218,240,0)');
    lg.addColorStop(0.88, 'rgba(200,218,240,0)');
    lg.addColorStop(1, 'rgba(200,218,240,0.42)');
    g.fillStyle = lg; g.fillRect(0, 0, w, h);
  }
  return c;
}

function buildBackground() {
  const aspect = innerWidth / innerHeight;
  const toTex = c => { const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t; };
  for (const k of ['map', 'clearMap']) if (bgMat.uniforms[k].value) bgMat.uniforms[k].value.dispose();
  bgMat.uniforms.map.value = toTex(paintWindow(aspect, true));
  bgMat.uniforms.clearMap.value = toTex(paintWindow(aspect, false));
  dropMat.uniforms.uBg.value = bgMat.uniforms.map.value;
  dropMat.uniforms.uRes.value.set(innerWidth * PR, innerHeight * PR);
  resetWipeMask(aspect);
}

// The window, frosted or wiped clear (same seed, so both line up)
function paintWindow(aspect, frosted) {
  const w = 1400, h = Math.round(clamp(1400 / aspect, 500, 3000));
  const c = canvas(w, h), g = c.getContext('2d');
  const R = mulberry32(9);
  g.imageSmoothingQuality = 'high';
  let gr, gr0;

  // 1. Outside, deeply out of focus
  const outside = paintOutside(Math.round(w * 0.5), Math.round(h * 0.5), R);
  // Wiped glass: the scene is a little sharper and less washed out
  g.drawImage(soften(soften(outside, frosted ? 0.07 : 0.12), 0.6), 0, 0, w, h);
  // Breath-fog on the glass washes the scene out
  g.fillStyle = frosted ? 'rgba(80,96,130,0.32)' : 'rgba(80,96,130,0.24)'; // wiped glass keeps a little haze
  g.fillRect(0, 0, w, h);

  // 2. Fog on the glass: uneven, slightly grainy haze
  const nw = 48, nh = Math.max(8, Math.round(48 / aspect));
  const nc = canvas(nw, nh), ng = nc.getContext('2d'), img = ng.createImageData(nw, nh);
  for (let y = 0; y < nh; y++) for (let x = 0; x < nw; x++) {
    const u = (x / nw) * 3, v = ((y / nh) * 3) / aspect;
    const n = tnoise(u, v, 1 << 20, 21) * 0.65 + tnoise(u * 2.7, v * 2.7, 1 << 20, 22) * 0.35;
    const k = (y * nw + x) * 4;
    img.data[k] = 130; img.data[k + 1] = 150; img.data[k + 2] = 185;
    img.data[k + 3] = (0.06 + n * 0.24) * 255;
  }
  ng.putImageData(img, 0, 0);
  if (frosted) g.drawImage(nc, 0, 0, w, h);
  const grain = canvas(w, h), gg = grain.getContext('2d');
  gg.fillStyle = 'rgba(210,225,245,0.18)';
  for (let i = 0; i < (w * h) / 900; i++) {
    const x = R() * w, y = R() * h, r = 0.6 + R() * 1.4;
    gg.beginPath(); gg.arc(x, y, r, 0, TAU); gg.fill();
  }
  if (frosted) g.drawImage(soften(grain, 0.8), 0, 0, w, h);

  // Clearer, darker glass in the middle so the letters read
  gr = g.createRadialGradient(w / 2, h * 0.47, 0, w / 2, h * 0.47, Math.min(w, h) * 0.75);
  gr.addColorStop(0, 'rgba(8,14,32,0.4)');
  gr.addColorStop(0.6, 'rgba(8,14,32,0.16)');
  gr.addColorStop(1, 'rgba(8,14,32,0)');
  g.fillStyle = gr; g.fillRect(0, 0, w, h);

  // 3. Frost ferns on the glass, crisp (they are on the glass, in focus-ish)
  // Twice: blurred for the soft white mass of the frost, then sharp for its crystals
  // Only the frosted pane needs it (nothing after this draws from R, so
  // skipping it on the clear pane changes nothing else)
  const frost = frosted ? paintFrost(w, h, R) : null;
  if (frosted) {
    g.globalAlpha = 0.9;
    g.drawImage(soften(soften(frost, 0.22), 0.6), 0, 0, w, h);
    g.globalAlpha = 1;
    g.drawImage(soften(frost, 0.85), 0, 0, w, h);
  }

  // Dusk: pull everything down a little, then a vignette
  g.globalCompositeOperation = 'multiply';
  g.fillStyle = '#56628a';
  g.fillRect(0, 0, w, h);
  // Lift the frost itself back up a little, so it stays pale against the dusk
  if (frosted) {
    g.globalCompositeOperation = 'screen';
    g.globalAlpha = 0.2;
    g.drawImage(soften(frost, 0.85), 0, 0, w, h);
    g.globalAlpha = 1;
  }
  g.globalCompositeOperation = 'source-over';
  gr = g.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.3, w / 2, h / 2, Math.max(w, h) * 0.78);
  gr.addColorStop(0, 'rgba(0,0,0,0)');
  gr.addColorStop(1, 'rgba(2,5,14,0.65)');
  g.fillStyle = gr; g.fillRect(0, 0, w, h);

  // The house window's warm light, carried through the fog
  g.globalCompositeOperation = 'screen';
  for (const fx of [0.57]) {
    const lx = w * fx, ly = h * 0.584, r = Math.min(w, h) * 0.1;
    gr0 = g.createRadialGradient(lx, ly, 0, lx, ly, r);
    gr0.addColorStop(0, 'rgba(255,190,120,0.26)');
    gr0.addColorStop(0.4, 'rgba(240,160,100,0.08)');
    gr0.addColorStop(1, 'rgba(200,130,90,0)');
    g.fillStyle = gr0; g.fillRect(lx - r, ly - r, r * 2, r * 2);
  }
  g.globalCompositeOperation = 'source-over';

  return c;
}

// -----------------------------------------------------------------------------
// The wipe mask: where the glass has been wiped (or run over by water)
// -----------------------------------------------------------------------------
const wipe = { c: null, g: null, tex: null, active: 0 };
function resetWipeMask(aspect) {
  const W = 384, H = Math.max(64, Math.round(384 / aspect));
  wipe.c = canvas(W, H);
  wipe.g = wipe.c.getContext('2d');
  wipe.g.fillStyle = '#000'; wipe.g.fillRect(0, 0, W, H);
  if (wipe.tex) wipe.tex.dispose();
  wipe.tex = new THREE.CanvasTexture(wipe.c);
  wipe.tex.colorSpace = THREE.NoColorSpace;
  bgMat.uniforms.mask.value = wipe.tex;
  bgMat.uniforms.uTexel.value.set(1 / W, 1 / H);
  bgMat.uniforms.uAspect.value = aspect;
}
// Screen point (CSS px) -> mask pixel. The backdrop plane is 1.12x the view.
function screenToMask(x, y) {
  const u = 0.5 + (x / innerWidth - 0.5) / 1.12, v = 0.5 + (y / innerHeight - 0.5) / 1.12;
  return [u * wipe.c.width, v * wipe.c.height];
}
// A soft round dab of the finger
function wipeDab(mx, my, r, a) {
  const g = wipe.g, gr = g.createRadialGradient(mx, my, 0, mx, my, r);
  gr.addColorStop(0, `rgba(255,0,0,${a})`);
  gr.addColorStop(0.7, `rgba(255,0,0,${a * 0.8})`);
  gr.addColorStop(1, 'rgba(255,0,0,0)');
  g.globalCompositeOperation = 'lighter';
  g.fillStyle = gr; g.fillRect(mx - r, my - r, r * 2, r * 2);
  g.globalCompositeOperation = 'source-over';
  wipe.active = 30;
}
// A finger stroke from one screen point to another
function wipeStroke(x0, y0, x1, y1) {
  const [ax, ay] = screenToMask(x0, y0), [bx, by] = screenToMask(x1, y1);
  const r = wipe.c.width * (IS_MOBILE ? 0.07 : 0.05);
  const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / (r * 0.35)));
  for (let i = 1; i <= n; i++) wipeDab(ax + (bx - ax) * (i / n), ay + (by - ay) * (i / n), r, 0.32);
}
function updateWipe(dt) {
  if (!wipe.c) return;
  const g = wipe.g;
  if (wipe.active <= 0) return;
  wipe.active -= dt;
  // Everything slowly frosts back over (roughly ten to fifteen seconds).
  // Faded in small steps a few times a second: per-frame steps would be lost
  // to 8-bit rounding and never quite clear.
  wipe.fadeT = (wipe.fadeT || 0) + dt;
  if (wipe.fadeT > 0.25) {
    g.fillStyle = `rgba(0,0,0,${Math.min(1, wipe.fadeT * 0.22)})`;
    g.fillRect(0, 0, wipe.c.width, wipe.c.height);
    wipe.fadeT = 0;
  }
  wipe.tex.needsUpdate = true;
}

// -----------------------------------------------------------------------------
// Textures for the ice
// -----------------------------------------------------------------------------
// Faint normal map: soft undulation, hairline cracks and tiny bubbles
function makeIceNormalMap() {
  const S = 256, hgt = new Float32Array(S * S);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const u = x / S, v = y / S;
      hgt[y * S + x] = tnoise(u * 6, v * 6, 6, 1) * 0.6 + tnoise(u * 16, v * 16, 16, 2) * 0.3 + tnoise(u * 40, v * 40, 40, 3) * 0.1;
    }
  }
  const c = canvas(S, S), g = c.getContext('2d');
  g.fillStyle = '#000'; g.fillRect(0, 0, S, S);
  const R = mulberry32(5);
  // Cracks: wandering hairlines (drawn 3x3 for seamless tiling)
  g.strokeStyle = 'rgba(255,255,255,0.9)';
  g.lineWidth = 1;
  for (let k = 0; k < 9; k++) {
    let x = R() * S, y = R() * S, a = R() * TAU;
    const pts = [[x, y]];
    for (let s = 0; s < 18; s++) { a += (R() - 0.5) * 0.7; x += Math.cos(a) * 6; y += Math.sin(a) * 6; pts.push([x, y]); }
    for (let ox = -S; ox <= S; ox += S) for (let oy = -S; oy <= S; oy += S) {
      g.beginPath();
      pts.forEach(([px, py], i) => (i ? g.lineTo(px + ox, py + oy) : g.moveTo(px + ox, py + oy)));
      g.stroke();
    }
  }
  // Bubbles
  for (let k = 0; k < 60; k++) {
    const x = R() * S, y = R() * S, r = 0.8 + Math.pow(R(), 3) * 4;
    const gr = g.createRadialGradient(x, y, 0, x, y, r);
    gr.addColorStop(0, 'rgba(255,255,255,0.8)');
    gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr; g.beginPath(); g.arc(x, y, r, 0, TAU); g.fill();
  }
  const extra = g.getImageData(0, 0, S, S).data;
  for (let i = 0; i < S * S; i++) hgt[i] += (extra[i * 4] / 255) * 0.5;

  const img = g.createImageData(S, S);
  const H = (x, y) => hgt[((y + S) % S) * S + ((x + S) % S)];
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const dx = (H(x + 1, y) - H(x - 1, y)) * 2.5, dy = (H(x, y + 1) - H(x, y - 1)) * 2.5;
      const l = Math.hypot(dx, dy, 1);
      const k = (y * S + x) * 4;
      img.data[k] = (-dx / l * 0.5 + 0.5) * 255;
      img.data[k + 1] = (dy / l * 0.5 + 0.5) * 255;
      img.data[k + 2] = (1 / l * 0.5 + 0.5) * 255;
      img.data[k + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(1.6, 1.6);
  t.colorSpace = THREE.NoColorSpace;
  return t;
}

// Surface flaws of real ice, as a roughness map and a matching normal map.
// Flaws are sparse and uneven: most of the surface stays glassy.
//  - scratches: short hairlines in clusters, each cluster with its own
//    direction; a few longer, deeper scratches that break off midway
//  - rub marks: a few faint, soft-edged hazy patches
function makeFlawTextures() {
  const S = 1024, R = mulberry32(29);
  const rough = canvas(S, S), rg = rough.getContext('2d');
  const hgt = canvas(S, S), hg = hgt.getContext('2d');
  rg.fillStyle = '#000'; rg.fillRect(0, 0, S, S);
  hg.fillStyle = '#808080'; hg.fillRect(0, 0, S, S);
  rg.lineCap = hg.lineCap = 'round';
  // Draw with wrap-around so the tile repeats seamlessly
  const tiled = fn => { for (let ox = -S; ox <= S; ox += S) for (let oy = -S; oy <= S; oy += S) fn(ox, oy); };
  const line = (x1, y1, x2, y2, w, ra, ha) => tiled((ox, oy) => {
    rg.strokeStyle = `rgba(255,255,255,${ra})`; rg.lineWidth = w;
    rg.beginPath(); rg.moveTo(x1 + ox, y1 + oy); rg.lineTo(x2 + ox, y2 + oy); rg.stroke();
    hg.strokeStyle = `rgba(0,0,0,${ha})`; hg.lineWidth = w;
    hg.beginPath(); hg.moveTo(x1 + ox, y1 + oy); hg.lineTo(x2 + ox, y2 + oy); hg.stroke();
  });

  // Rub marks: faint, elongated, soft-edged haze
  for (let i = 0; i < 4; i++) {
    const x = R() * S, y = R() * S, r = 40 + R() * 90, a = R() * Math.PI;
    tiled((ox, oy) => {
      rg.save(); rg.translate(x + ox, y + oy); rg.rotate(a); rg.scale(1, 0.35 + R() * 0.3);
      const gr = rg.createRadialGradient(0, 0, 0, 0, 0, r);
      gr.addColorStop(0, `rgba(255,255,255,${0.32 + R() * 0.15})`);
      gr.addColorStop(1, 'rgba(255,255,255,0)');
      rg.fillStyle = gr; rg.beginPath(); rg.arc(0, 0, r, 0, TAU); rg.fill(); rg.restore();
    });
  }

  // Clusters of short hairline scratches, each cluster with its own direction
  const clusters = 10 + ((R() * 6) | 0);
  for (let c = 0; c < clusters; c++) {
    const cx = R() * S, cy = R() * S, spread = 15 + R() * 55, dir = R() * Math.PI;
    const n = 6 + ((R() * 34) | 0);
    for (let k = 0; k < n; k++) {
      const x = cx + (R() + R() - 1) * spread, y = cy + (R() + R() - 1) * spread;
      const a = dir + (R() - 0.5) * 0.3, len = 3 + Math.pow(R(), 1.5) * 26;
      line(x, y, x + Math.cos(a) * len, y + Math.sin(a) * len, 0.5 + R() * 0.6, 0.35 + R() * 0.45, 0.15 + R() * 0.15);
    }
  }

  // A few longer, deeper scratches that break off here and there
  for (let k = 0; k < 4; k++) {
    let x = R() * S, y = R() * S, a = R() * TAU;
    const len = 140 + R() * 260, step = 8;
    for (let d = 0; d < len; d += step) {
      a += (R() - 0.5) * 0.04;
      const x2 = x + Math.cos(a) * step, y2 = y + Math.sin(a) * step;
      if (R() > 0.12) line(x, y, x2, y2, 0.9 + R() * 0.5, 0.75, 0.45); // gaps where it breaks
      x = x2; y = y2;
    }
  }

  // Height → normal map: grooves sink slightly
  const hd = hg.getImageData(0, 0, S, S).data;
  const H = (x, y) => hd[((((y + S) % S) * S + ((x + S) % S)) * 4)] / 255;
  const nc = canvas(S, S), ng = nc.getContext('2d'), img = ng.createImageData(S, S);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const dx = (H(x + 1, y) - H(x - 1, y)) * 3, dy = (H(x, y + 1) - H(x, y - 1)) * 3;
      const l = Math.hypot(dx, dy, 1), k = (y * S + x) * 4;
      img.data[k] = (-dx / l * 0.5 + 0.5) * 255;
      img.data[k + 1] = (dy / l * 0.5 + 0.5) * 255;
      img.data[k + 2] = (1 / l * 0.5 + 0.5) * 255;
      img.data[k + 3] = 255;
    }
  }
  ng.putImageData(img, 0, 0);
  const tex = cnv => {
    const t = new THREE.CanvasTexture(cnv);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(0.6, 0.6); // one tile spans well over a character
    t.colorSpace = THREE.NoColorSpace;
    return t;
  };
  return { rough: tex(rough), normal: tex(nc) };
}

function makeStarTexture() {
  const s = 128, m = s / 2, c = canvas(s, s), g = c.getContext('2d');
  let gr = g.createRadialGradient(m, m, 0, m, m, m);
  gr.addColorStop(0, 'rgba(255,255,255,1)');
  gr.addColorStop(0.05, 'rgba(245,250,255,0.9)');
  gr.addColorStop(0.15, 'rgba(195,218,255,0.28)');
  gr.addColorStop(0.38, 'rgba(140,180,255,0.05)');
  gr.addColorStop(1, 'rgba(120,160,255,0)');
  g.fillStyle = gr; g.fillRect(0, 0, s, s);
  g.globalCompositeOperation = 'lighter';
  for (let r = 0; r < 2; r++) {
    g.save();
    g.translate(m, m); g.rotate((r * Math.PI) / 2);
    const lg = g.createLinearGradient(-m, 0, m, 0);
    lg.addColorStop(0, 'rgba(190,215,255,0)');
    lg.addColorStop(0.3, 'rgba(210,228,255,0.08)');
    lg.addColorStop(0.5, 'rgba(255,255,255,0.95)');
    lg.addColorStop(0.7, 'rgba(210,228,255,0.08)');
    lg.addColorStop(1, 'rgba(190,215,255,0)');
    g.fillStyle = lg;
    g.beginPath(); g.moveTo(-m, 0);
    g.quadraticCurveTo(0, -1.8, m, 0); g.quadraticCurveTo(0, 1.8, -m, 0);
    g.fill();
    g.restore();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

const iceNormal = makeIceNormalMap();
const flawTex = makeFlawTextures();
const starTex = makeStarTexture();

// -----------------------------------------------------------------------------
// Materials
// -----------------------------------------------------------------------------
// Clear ice: a glassy surface (roughness 0.01) with sparse real flaws,
// small sharp highlights and a clear coat.
const baseIce = new THREE.MeshPhysicalMaterial({
  color: 0xffffff,
  metalness: 0,
  roughness: 0.01,
  transmission: 1,
  thickness: 0.5,
  ior: 1.31,
  attenuationColor: new THREE.Color(0xa8d2f2),
  attenuationDistance: 1.0,
  specularIntensity: 1,
  envMapIntensity: 1.4,
  normalMap: flawTex.normal,
  normalScale: new THREE.Vector2(0.12, 0.12),
  clearcoat: 1,
  clearcoatRoughness: 0.02,
});

// -----------------------------------------------------------------------------
// The look of the ice, in shader:
//  - surface flaws: scratch clusters and rub marks (roughness map), plus a
//    couple of tiny chips at the outline, where the ice was knocked
//  - colour from the glyph's distance field: bright cyan-white at thin edges,
//    deepening to clear ice-blue in the thick core of every stroke
//  - interior mapping: the view ray is marched a few layers into the block in
//    object space; each layer adds fine Voronoi cracks, single bubbles and
//    little strings of bubbles frozen on their way up, fainter and bluer with
//    depth, so the structure shifts in parallax as the letter turns
//  - a little milky haze in the thick cores, and a faint inner glow
//  - one thin Fresnel line at the very edge
// -----------------------------------------------------------------------------
const ICE_LAYERS = IS_MOBILE ? 3 : 4;
const ICE_VS_PARS = 'varying vec3 vObjPos; varying vec3 vObjEye;\n';
const ICE_VS_BEGIN = '#include <begin_vertex>\n vObjPos = transformed;';
const ICE_VS_EYE = `#include <project_vertex>
  vObjEye = transformed - (inverse(modelMatrix) * vec4(cameraPosition, 1.0)).xyz;`;
const ICE_FS_PARS = `
  varying vec3 vObjPos; varying vec3 vObjEye;
  uniform sampler2D uSdf, uFlaw; uniform vec4 uSdfBox; uniform float uSeed;
  vec3 ihash3(vec3 p){
    p = vec3(dot(p, vec3(127.1, 311.7, 74.7)), dot(p, vec3(269.5, 183.3, 246.1)), dot(p, vec3(113.5, 271.9, 124.6)));
    return fract(sin(p) * 43758.5453);
  }
  float inoise(vec3 x){
    vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
    float a = ihash3(i).x, b = ihash3(i + vec3(1, 0, 0)).x, c = ihash3(i + vec3(0, 1, 0)).x, d = ihash3(i + vec3(1, 1, 0)).x;
    float e = ihash3(i + vec3(0, 0, 1)).x, g = ihash3(i + vec3(1, 0, 1)).x, h = ihash3(i + vec3(0, 1, 1)).x, k = ihash3(i + vec3(1, 1, 1)).x;
    return mix(mix(mix(a, b, f.x), mix(c, d, f.x), f.y), mix(mix(e, g, f.x), mix(h, k, f.x), f.y), f.z);
  }
  // 3D Voronoi: x = distance to nearest seed, y = distance to the cell border (F2 - F1)
  vec2 ivor(vec3 p){
    vec3 i = floor(p), f = fract(p);
    float f1 = 8.0, f2 = 8.0;
    for (int z = -1; z <= 1; z++) for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
      vec3 g = vec3(float(x), float(y), float(z));
      vec3 r = g + ihash3(i + g) - f;
      float d = dot(r, r);
      if (d < f1) { f2 = f1; f1 = d; } else if (d < f2) { f2 = d; }
    }
    return vec2(sqrt(f1), sqrt(f2) - sqrt(f1));
  }
  // Strings of tiny bubbles, frozen in vertical runs. Space is cut into thin
  // vertical columns; a few columns carry a run of bubbles over part of
  // their height. Returns bubble coverage.
  float bubbleString(vec3 p, float blur){
    vec3 s = vec3(9.0, 32.0, 9.0);
    vec3 q = p * s;
    vec3 cell = floor(q);
    vec3 col = vec3(cell.x, 0.0, cell.z);
    float on = step(0.86, ihash3(col + 7.0).x) * step(0.45, inoise(vec3(cell.x * 0.37, q.y * 0.06, cell.z * 0.37)));
    vec3 jit = (ihash3(cell) - 0.5) * vec3(0.5, 0.3, 0.5);
    vec3 d = (fract(q) - 0.5 - jit) / s;               // back to object space
    float r = 0.006 + 0.008 * ihash3(cell + 3.0).y;
    return on * (1.0 - smoothstep(r, r + blur, length(d)));
  }
`;
const ICE_INNER = `
  vec2 sdfUv = (vObjPos.xy - uSdfBox.xy) / (uSdfBox.zw - uSdfBox.xy);
  float iceInner = texture2D(uSdf, sdfUv).r; // 0 at the outline, 1 in the thickest core
`;
const ICE_FLAWS = `#include <roughnessmap_fragment>
  // Scratches and rub marks roughen the glassy surface only where they are
  float flaw = texture2D(uFlaw, vNormalMapUv).r;
  roughnessFactor = max(roughnessFactor, flaw * 0.55);
  // A couple of tiny chips right at the outline, as if the ice was knocked
  vec2 chipUv = (vObjPos.xy - uSdfBox.xy) / (uSdfBox.zw - uSdfBox.xy);
  float chip = (1.0 - smoothstep(0.03, 0.08, texture2D(uSdf, chipUv).r))
             * smoothstep(0.9, 0.95, inoise(vObjPos * 16.0 + uSeed * 7.0));
  roughnessFactor = max(roughnessFactor, chip * 0.6);`;
const ICE_CHIP_NORMAL = `#include <normal_fragment_maps>
  normal = normalize(normal + chip * vec3(inoise(vObjPos * 60.0) - 0.5, inoise(vObjPos * 60.0 + 9.0) - 0.5, 0.0) * 1.2);`;
const ICE_BODY = `
  {
    // Interior structure, marched a few layers along the view ray
    vec3 rayDir = normalize(vObjEye);
    vec3 icol = vec3(0.0); float iamt = 0.0;
    for (int L = 0; L < ${ICE_LAYERS}; L++) {
      float fl = float(L);
      vec3 p = vObjPos + rayDir * (0.012 + fl * 0.03);
      float w = 1.0 / (1.0 + fl * 1.1);                         // deeper = fainter
      // Fine cracks along Voronoi cell borders: varied width, some crisp, some
      // soft, and only in places
      vec2 v = ivor(p * 6.5 + fl * 3.1 + uSeed);
      float width = 0.008 + 0.024 * inoise(p * 3.0 + 7.0);
      float blur = mix(0.005, 0.045, inoise(p * 2.2 + 13.0)) + fl * 0.01;
      float crack = (1.0 - smoothstep(width, width + blur, v.y)) * smoothstep(0.55, 0.78, inoise(p * 2.5 + fl + uSeed));
      // Single bubbles, varied in size, blurrier deeper in
      vec2 b = ivor(p * 26.0 + fl * 5.3);
      float rad = 0.05 + 0.08 * ihash3(floor(p * 26.0 + fl * 5.3)).y;
      float bubble = (1.0 - smoothstep(rad, rad + 0.05 + fl * 0.05, b.x)) * step(0.62, inoise(p * 5.0 + 9.0));
      // Strings of bubbles caught on their way up
      bubble = max(bubble, bubbleString(p + fl * 0.37, 0.003 + fl * 0.004));
      float val = (crack * 0.6 + bubble * 0.8) * w;
      icol += mix(vec3(1.0), vec3(0.55, 0.8, 1.0), fl / float(${ICE_LAYERS - 1})) * val;
      iamt += val;
    }
    float core = smoothstep(0.08, 0.5, iceInner);
    icol *= core; iamt *= core;

    // Colour by thickness: cyan-white at the edges, ice-blue in the thick core
    vec3 tEdge = vec3(0.9, 0.98, 1.0), tMid = vec3(0.75, 0.9, 1.0), tCore = vec3(0.31, 0.62, 0.85);
    vec3 tint = iceInner < 0.5 ? mix(tEdge, tMid, iceInner * 2.0) : mix(tMid, tCore, (iceInner - 0.5) * 2.0);
    totalDiffuse *= tint;
    totalDiffuse += icol * 0.55;
    // A little milky haze where the stroke is thickest
    float haze = smoothstep(0.55, 1.0, iceInner) * (0.4 + 0.6 * inoise(vObjPos * 3.0 + 41.0));
    totalDiffuse = mix(totalDiffuse, vec3(0.82, 0.9, 0.98) * 0.6, haze * 0.22);
    // Scratches and chips catch a little light: highlights turn whitish there
    totalDiffuse += vec3(0.85, 0.92, 1.0) * (flaw * 0.05 + chip * 0.12);

    // Faint inner glow: luminous even against the dark night, cyan-white at
    // the edges and clear blue in the core, brighter where the ice is veined
    vec3 glowCol = mix(vec3(0.78, 0.94, 1.0), vec3(0.32, 0.63, 0.9), smoothstep(0.15, 0.9, iceInner));
    totalDiffuse += glowCol * (0.09 + 0.1 * iceInner) + vec3(0.8, 0.92, 1.0) * iamt * 0.22;
  }
`;
const ICE_RIM = `{
    // One thin bright line at the outermost edge; nothing else is brightened
    vec3 rimV = normalize(-vViewPosition);
    float rim = pow(1.0 - clamp(abs(dot(normal, rimV)), 0.0, 1.0), 6.0);
    outgoingLight += vec3(0.75, 0.9, 1.0) * rim * 0.35;
  }
  #include <opaque_fragment>`;

function addIceShader(sh, u) {
  Object.assign(sh.uniforms, u);
  sh.vertexShader = ICE_VS_PARS + sh.vertexShader
    .replace('#include <begin_vertex>', ICE_VS_BEGIN)
    .replace('#include <project_vertex>', ICE_VS_EYE);
  sh.fragmentShader = ICE_FS_PARS + sh.fragmentShader
    .replace('#include <roughnessmap_fragment>', ICE_FLAWS)
    .replace('#include <normal_fragment_maps>', ICE_CHIP_NORMAL)
    .replace('#include <transmission_fragment>', ICE_INNER
      + THREE.ShaderChunk.transmission_fragment.replace('material.thickness = thickness;', 'material.thickness = thickness * (0.2 + 0.95 * iceInner);')
      + ICE_BODY)
    .replace('#include <opaque_fragment>', ICE_RIM);
}

// Each glyph gets its own material so it can freeze/melt independently.
// The melt wears the ice away in grains, mostly from the top down: a
// grainy noise field plus height decides what is gone, so the edge is
// ragged and crumbly, never a straight cut. A thin wet sheen rides the edge.
const MELT_LINE = `
  float meltH = clamp((vObjPos.y - uBox.y) / max(uBox.w - uBox.y, 1e-3), 0.0, 1.0);
  float meltN = inoise(vObjPos * 9.0 + uSeed) * 0.6 + inoise(vObjPos * 3.5 + uSeed * 3.0) * 0.4;
  float meltF = meltH * 0.72 + meltN * 0.28;
  float meltThr = 1.02 - uMelt * 1.08;
  if (meltF > meltThr) discard;
  float meltWet = uMelt > 0.0 ? 1.0 - smoothstep(0.0, 0.09, meltThr - meltF) : 0.0;
`;
function makeGlyphMaterial(d) {
  const m = baseIce.clone();
  const box = d.box;
  const u = {
    uMelt: { value: 0 },
    uBox: { value: new THREE.Vector4(box.min.x, box.min.y, box.max.x, box.max.y) },
    uSeed: { value: Math.random() * 10 },
    uSdf: { value: d.sdf },
    uSdfBox: { value: new THREE.Vector4(d.sdfBox.min.x, d.sdfBox.min.y, d.sdfBox.max.x, d.sdfBox.max.y) },
    uFlaw: { value: flawTex.rough },
  };
  m.userData.u = u;
  m.onBeforeCompile = sh => {
    addIceShader(sh, u);
    sh.fragmentShader = 'uniform float uMelt; uniform vec4 uBox;\n' + sh.fragmentShader
      .replace('#include <clipping_planes_fragment>', '#include <clipping_planes_fragment>\n' + MELT_LINE)
      .replace('#include <dithering_fragment>', 'gl_FragColor.rgb += vec3(0.8, 0.92, 1.0) * meltWet * meltWet * 0.12;\n#include <dithering_fragment>');
  };
  m.customProgramCacheKey = () => 'ice-glyph-crystal';
  return m;
}

const flakeMat = new THREE.MeshPhysicalMaterial({
  color: 0xffffff, roughness: 0.18, transmission: 0.55, thickness: 0.05, ior: 1.31,
  emissive: 0xbad4ff, emissiveIntensity: 0.12, envMapIntensity: 2.4, specularIntensity: 1, normalMap: iceNormal, normalScale: new THREE.Vector2(0.12, 0.12),
  side: THREE.DoubleSide,
});
// Light on small clear pieces against the night: a thin fresnel rim, a faint
// cold body glow, and a key light that makes flat facets flash one by one
function addClearLight(m, o) {
  m.onBeforeCompile = sh => {
    sh.fragmentShader = sh.fragmentShader.replace('#include <opaque_fragment>', `
      float clK = clamp(1.0 - abs(dot(normal, geometryViewDir)), 0.0, 1.0);
      outgoingLight += vec3(0.75, 0.9, 1.0) * pow(clK, ${o.rimPow.toFixed(1)}) * ${o.rim.toFixed(3)};
      outgoingLight += vec3(0.55, 0.78, 1.0) * ${o.glow.toFixed(3)};
      outgoingLight += vec3(0.85, 0.93, 1.0) * pow(max(dot(normal, normalize(vec3(-0.45, 0.65, 0.6))), 0.0), 8.0) * ${o.facet.toFixed(3)};
      #include <opaque_fragment>`);
  };
  m.customProgramCacheKey = () => 'clear-light-' + JSON.stringify(o);
  return m;
}

// Shatter shards: clear, hard, faceted ice (not milky, or they read as snow)
const shardMat = addClearLight(new THREE.MeshPhysicalMaterial({
  color: 0xf6fbff, roughness: 0.05, transmission: 0.95, thickness: 0.25, ior: 1.31,
  attenuationColor: new THREE.Color(0xa8d2f2), attenuationDistance: 0.4,
  envMapIntensity: 1.8, specularIntensity: 1, clearcoat: 1, clearcoatRoughness: 0.03,
}), { rim: 0.9, rimPow: 4, glow: 0.05, facet: 0.6 });
// Melt water. A real drop is a tiny fish-eye lens: the night behind it shows
// through shrunk and upside down, it has a dark ring toward its outline
// (light reflected away inside it), a hair-thin bright rim, and one sharp
// window highlight. Drawn by refracting the window backdrop directly, since a
// transmissive drop over the transmissive ice would vanish.
const dropMat = new THREE.ShaderMaterial({
  uniforms: { uBg: { value: null }, uRes: { value: new THREE.Vector2(innerWidth * PR, innerHeight * PR) } },
  vertexShader: `varying vec3 vN; varying vec3 vW;
    void main() {
      mat4 m = modelMatrix * instanceMatrix;
      vec4 w = m * vec4(position, 1.0);
      vW = w.xyz;
      vN = normalize(mat3(m) * normal);
      gl_Position = projectionMatrix * viewMatrix * w;
    }`,
  fragmentShader: `uniform sampler2D uBg; uniform vec2 uRes; varying vec3 vN; varying vec3 vW;
    void main() {
      vec3 n = normalize(vN), v = normalize(cameraPosition - vW);
      float ndv = clamp(dot(n, v), 0.0, 1.0);
      vec2 suv = gl_FragCoord.xy / uRes;
      vec2 bgUv = 0.5 + (suv - 0.5) / 1.12;          // the backdrop plane is 1.12x the view
      vec3 seen = texture2D(uBg, clamp(bgUv - n.xy * 0.06, 0.001, 0.999)).rgb * 1.8 + vec3(0.04, 0.05, 0.07);
      float edge = smoothstep(0.6, 0.05, ndv);
      vec3 col = mix(seen, seen * 0.45, edge * 0.8);
      col += vec3(0.75, 0.86, 1.0) * pow(1.0 - ndv, 6.0) * 0.8;
      vec3 h = normalize(normalize(vec3(-0.45, 0.65, 0.6)) + v);
      col += vec3(1.0) * pow(max(dot(n, h), 0.0), 240.0) * 2.4;
      vec3 h2 = normalize(normalize(vec3(0.35, -0.6, 0.7)) + v);
      col += vec3(1.0, 0.95, 0.9) * pow(max(dot(n, h2), 0.0), 50.0) * 0.18;
      gl_FragColor = vec4(col, 1.0);
    }`,
});

// -----------------------------------------------------------------------------
// Sound effects, synthesized on the fly (no audio files). Filtered noise, plus
// the drip's split-second bubble sweep; nothing holds a note or reads as music. Browsers only
// allow audio after a touch or key, so it starts on the first one.
//   freeze   ice crackling as it forms
//   shatter  a sharp crack, a dull thump, and small pieces landing
//   drip     a water drop's crisp, very short upward "bloop"
//   wipe     a fingertip rubbing frost off the glass, louder the faster it moves
// -----------------------------------------------------------------------------
const sfx = (() => {
  let ctx = null, master = null, noiseBuf = null;
  const init = () => {
    if (ctx) { if (ctx.state === 'suspended') ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = 0.7;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16; comp.ratio.value = 5;
    // Only a short, dry room, so nothing rings on
    const verb = ctx.createConvolver();
    const len = Math.round(ctx.sampleRate * 0.45), ir = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = ir.getChannelData(ch);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 4);
    }
    verb.buffer = ir;
    const wet = ctx.createGain(); wet.gain.value = 0.1;
    master.connect(comp); master.connect(verb); verb.connect(wet); wet.connect(comp);
    comp.connect(ctx.destination);
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const nd = noiseBuf.getChannelData(0);
    for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
  };
  addEventListener('pointerdown', init, true);
  addEventListener('keydown', init, true);
  const ready = () => ctx && ctx.state === 'running';
  const out = pan => {
    if (!ctx.createStereoPanner) return master;
    const p = ctx.createStereoPanner(); p.pan.value = clamp(pan || 0, -0.9, 0.9); p.connect(master); return p;
  };
  // A burst of filtered noise; the filter can sweep (f2) during the burst
  const grain = (t, dur, gain, type, freq, q, pan, attack = 0.001, f2) => {
    const src = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
    src.buffer = noiseBuf;
    f.type = type; f.Q.value = q;
    f.frequency.setValueAtTime(freq, t);
    if (f2) f.frequency.exponentialRampToValueAtTime(f2, t + Math.min(dur, 0.05));
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f); f.connect(g); g.connect(out(pan));
    src.start(t, Math.random() * 1.5); src.stop(t + dur + 0.02);
  };
  // Trims measured so effects peak at about the same loudness (~-33 dBFS over
  // 50 ms); the shatter is deliberately a few dB louder, as the big moment
  const LEVEL = { freeze: 4.8, shatter: 0.75, drip: 1.0, wipe: 1.68 };
  let lastDrip = 0;
  let rub = null; // the running wipe sound: a looped hiss whose loudness follows the finger
  const api = {
    wipe(speed, pan) {
      if (!ready()) return;
      const t = ctx.currentTime;
      if (!rub) {
        const src = ctx.createBufferSource(), bp = ctx.createBiquadFilter(), lp = ctx.createBiquadFilter(), g = ctx.createGain();
        src.buffer = noiseBuf; src.loop = true;
        bp.type = 'bandpass'; bp.frequency.value = 2200; bp.Q.value = 0.8;
        lp.type = 'lowpass'; lp.frequency.value = 5000;
        g.gain.value = 0.0001;
        const pn = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
        src.connect(bp); bp.connect(lp); lp.connect(g);
        if (pn) { g.connect(pn); pn.connect(master); } else g.connect(master);
        src.start(t);
        rub = { src, bp, g, pn };
      }
      const k = clamp(speed / 1400, 0, 1);
      rub.g.gain.setTargetAtTime((0.012 + 0.11 * k) * LEVEL.wipe, t, 0.04);
      rub.bp.frequency.setTargetAtTime(1600 + 1800 * k + Math.random() * 300, t, 0.05); // brighter when fast
      if (rub.pn) rub.pn.pan.setTargetAtTime(clamp(pan || 0, -0.9, 0.9), t, 0.05);
      // frost crumbling under a quick finger
      if (Math.random() < k * 0.35) grain(t, 0.01 + Math.random() * 0.02, (0.03 + 0.05 * k) * LEVEL.wipe, 'bandpass', 2500 + Math.random() * 3000, 1.2, pan);
    },
    wipeEnd() {
      if (!rub) return;
      const t = ctx.currentTime, r = rub;
      r.g.gain.setTargetAtTime(0.0001, t, 0.06);
      r.src.stop(t + 0.4);
      rub = null;
    },
    freeze(pan) {
      if (!ready()) return;
      const t = ctx.currentTime;
      const L = LEVEL.freeze;
      // crackling: tiny dry clicks, dense at first, thinning out as it sets
      const n = 16 + ((Math.random() * 10) | 0);
      for (let i = 0; i < n; i++) {
        const dt = Math.pow(i / n, 1.5) * 0.85 + Math.random() * 0.03;
        grain(t + dt, 0.006 + Math.random() * 0.016, (0.06 + Math.random() * 0.1) * L, 'bandpass', 1800 + Math.random() * 4500, 1.4, pan);
      }
    },
    shatter(pan, big) {
      if (!ready()) return;
      const t = ctx.currentTime, k = (big ? 1.3 : 1) * LEVEL.shatter;
      grain(t, 0.09, 0.4 * k, 'highpass', 1800, 0.7, pan, 0.002);        // the crack
      grain(t, 0.18, 0.22 * k, 'lowpass', 700, 0.8, pan, 0.004);         // the body of the break
      const n = (big ? 18 : 10) + ((Math.random() * 6) | 0);           // shards landing: tiny ticks, no pitch
      for (let i = 0; i < n; i++) {
        const dt = 0.03 + Math.pow(Math.random(), 1.5) * 0.9;
        const p = clamp((pan || 0) + (Math.random() - 0.5) * 0.8, -0.9, 0.9);
        grain(t + dt, 0.012 + Math.random() * 0.02, (0.06 + Math.random() * 0.08) * k, 'bandpass', 2000 + Math.random() * 3000, 1.2, p, 0.001);
      }
    },
    drip(pan) {
      if (!ready()) return;
      const t = ctx.currentTime;
      if (t - lastDrip < 0.06) return;
      lastDrip = t;
      // a water drop's crisp "bloop": the bubble's pitch shoots up and the sound
      // is gone within ~45 ms, before it can settle on a note, so it reads as a
      // drop rather than music. Each drop starts somewhere different.
      const f = 450 + Math.random() * 350, L = LEVEL.drip;
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'sine';
      o.frequency.setValueAtTime(f, t);
      o.frequency.exponentialRampToValueAtTime(f * (3.2 + Math.random() * 0.8), t + 0.035);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.12 * L, t + 0.002);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.045);
      o.connect(g); g.connect(out(pan));
      o.start(t); o.stop(t + 0.06);
      grain(t, 0.005, 0.05 * L, 'highpass', 3500, 0.7, pan, 0.0005); // the tick as it lands
    },
  };
  return api;
})();
// Stereo position of a world x (letters on the left sound a little to the left)
const panOf = x => clamp(x / Math.max(1.5, contentW * 0.6), -0.8, 0.8);

// -----------------------------------------------------------------------------
// Fonts: a natural hand. 瑞美加张清平硬笔行书 (a pen-written running script,
// from the Chinese Webfont Project) for Chinese, Gilda Display for Latin.
// Both load per unicode-range slice, so only the glyphs actually typed are fetched.
// -----------------------------------------------------------------------------
const FONTS = {
  cjk: {
    base: 'https://cdn.jsdelivr.net/npm/@chinese-fonts/rmjzqpybxs@3.0.0/dist/' + encodeURIComponent('瑞美加张清平硬笔行书') + '/',
    css: 'result.css', yMid: 0.38, scale: 1.18, // this hand writes small within its em box
  },
  latin: { base: 'https://cdn.jsdelivr.net/npm/@fontsource/gilda-display@5.3.0/', css: '400.css', yMid: 0.3 },
};
// Reads every @font-face of a slice stylesheet: its file (WOFF preferred, else
// WOFF2) and unicode-range. Works for both Fontsource and cn-font-split CSS.
function loadSlices(src) {
  src.slices ||= fetch(src.base + src.css).then(r => r.text()).then(css => {
    const out = [];
    for (const face of css.match(/@font-face\s*\{[^}]*\}/g) || []) {
      const urls = [...face.matchAll(/url\(["']?\.\/([^)"']+)["']?\)\s*format\(["']?(woff2?)["']?\)/g)];
      const pick = urls.find(u => u[2] === 'woff') || urls.find(u => u[2] === 'woff2');
      if (!pick) continue;
      const ur = face.match(/unicode-range:\s*([^;}]+)/);
      const ranges = ur
        ? ur[1].split(',').map(r => {
          const [a, b] = r.trim().replace(/^U\+/i, '').split('-');
          return [parseInt(a, 16), parseInt(b ?? a, 16)];
        })
        : [[0, 0x10ffff]];
      out.push({ file: pick[1], woff2: pick[2] === 'woff2', ranges });
    }
    return out;
  });
  return src.slices;
}
// WOFF2 needs Brotli and table reconstruction: done by a small WebAssembly
// decoder, loaded only when a WOFF2 slice is first needed
let woff2P = null;
async function woff2ToSfnt(buf) {
  woff2P ||= import('https://cdn.jsdelivr.net/npm/@chinese-fonts/wawoff2@2.0.6/decompress.js');
  const out = await (await woff2P).decompress(new Uint8Array(buf));
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
}
// WOFF → plain SFNT. opentype.js's own inflater chokes on some slices, so the
// tables are inflated with the browser's DecompressionStream instead.
async function woffToSfnt(buf) {
  const dv = new DataView(buf);
  if (dv.getUint32(0) !== 0x774f4646) return buf; // not 'wOFF'
  const flavor = dv.getUint32(4), n = dv.getUint16(12);
  const tables = [];
  for (let i = 0; i < n; i++) {
    const o = 44 + i * 20;
    tables.push({ tag: dv.getUint32(o), offset: dv.getUint32(o + 4), comp: dv.getUint32(o + 8), orig: dv.getUint32(o + 12), ck: dv.getUint32(o + 16) });
  }
  const data = await Promise.all(tables.map(async t => {
    const src = new Uint8Array(buf, t.offset, t.comp);
    if (t.comp >= t.orig) return src;
    const stream = new Blob([src]).stream().pipeThrough(new DecompressionStream('deflate'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }));
  let total = 12 + 16 * n;
  for (const d of data) total += (d.length + 3) & ~3;
  const out = new ArrayBuffer(total), ov = new DataView(out), ob = new Uint8Array(out);
  const es = Math.floor(Math.log2(n)), sr = (1 << es) * 16;
  ov.setUint32(0, flavor); ov.setUint16(4, n); ov.setUint16(6, sr); ov.setUint16(8, es); ov.setUint16(10, n * 16 - sr);
  let off = 12 + 16 * n;
  tables.forEach((t, i) => {
    const o = 12 + i * 16;
    ov.setUint32(o, t.tag); ov.setUint32(o + 4, t.ck); ov.setUint32(o + 8, off); ov.setUint32(o + 12, t.orig);
    ob.set(data[i], off);
    off += (data[i].length + 3) & ~3;
  });
  return out;
}

const fontFiles = new Map();
function loadFontFile(src, sl) {
  const key = src.base + sl.file;
  let fp = fontFiles.get(key);
  if (!fp) {
    fp = fetch(key).then(r => r.arrayBuffer()).then(sl.woff2 ? woff2ToSfnt : woffToSfnt).then(b => opentype.parse(b));
    fontFiles.set(key, fp);
  }
  return fp;
}
async function loadGlyph(ch) {
  const cp = ch.codePointAt(0);
  // Latin letters prefer the Latin brush; everything else the Chinese brush
  const order = cp < 0x2000 ? [FONTS.latin, FONTS.cjk] : [FONTS.cjk, FONTS.latin];
  for (const src of order) {
    const slices = await loadSlices(src).catch(() => []);
    for (const sl of slices) {
      if (!sl.ranges.some(([a, b]) => cp >= a && cp <= b)) continue;
      const font = await loadFontFile(src, sl);
      const glyph = font.charToGlyph(ch);
      const k = src.scale || 1;
      if (glyph && glyph.index) return { glyph, upem: font.unitsPerEm / k, yMid: src.yMid * k };
    }
  }
  return null;
}

// -----------------------------------------------------------------------------
// Glyph → 3D ice (cached per character)
// -----------------------------------------------------------------------------
const DEPTH = 0.16, BEVEL_T = 0.02, BEVEL_S = 0.012; // a narrow, smooth and crisp bevel: a fine edge line
const FRONT_Z = DEPTH / 2 + BEVEL_T;
const glyphCache = new Map();

function glyphShapes(glyph, upem) {
  const sp = new THREE.ShapePath(), k = 1 / upem;
  for (const c of glyph.path.commands) {
    if (c.type === 'M') sp.moveTo(c.x * k, c.y * k);
    else if (c.type === 'L') sp.lineTo(c.x * k, c.y * k);
    else if (c.type === 'Q') sp.quadraticCurveTo(c.x1 * k, c.y1 * k, c.x * k, c.y * k);
    else if (c.type === 'C') sp.bezierCurveTo(c.x1 * k, c.y1 * k, c.x2 * k, c.y2 * k, c.x * k, c.y * k);
  }
  if (!sp.subPaths.length) return [];
  // Winding differs between TrueType and CFF outlines: the largest contour is always solid
  let big = 0, sign = 1;
  for (const p of sp.subPaths) {
    const a = THREE.ShapeUtils.area(p.getPoints());
    if (Math.abs(a) > big) { big = Math.abs(a); sign = Math.sign(a); }
  }
  return sp.toShapes(sign > 0);
}

// Rasterizes the glyph over `box` and builds a normalized inner distance field
function glyphField(rings, box) {
  const N = 112;
  const sx = box.max.x - box.min.x, sy = box.max.y - box.min.y;
  const c = canvas(N, N), g = c.getContext('2d', { willReadFrequently: true });
  const toPx = (x, y) => [((x - box.min.x) / sx) * N, ((box.max.y - y) / sy) * N];
  g.fillStyle = '#fff';
  g.beginPath();
  for (const ring of rings) ring.forEach((p, i) => { const [x, y] = toPx(p.x, p.y); i ? g.lineTo(x, y) : g.moveTo(x, y); });
  g.fill('evenodd');
  const a = g.getImageData(0, 0, N, N).data;
  const inside = new Uint8Array(N * N);
  for (let i = 0; i < N * N; i++) inside[i] = a[i * 4 + 3] > 127 ? 1 : 0;
  // Two-pass chamfer distance transform
  const D = new Float32Array(N * N);
  for (let i = 0; i < N * N; i++) D[i] = inside[i] ? 1e6 : 0;
  const at = (x, y) => (x < 0 || y < 0 || x >= N || y >= N ? 0 : D[y * N + x]);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const i = y * N + x;
    if (D[i]) D[i] = Math.min(D[i], at(x - 1, y) + 1, at(x, y - 1) + 1, at(x - 1, y - 1) + 1.414, at(x + 1, y - 1) + 1.414);
  }
  for (let y = N - 1; y >= 0; y--) for (let x = N - 1; x >= 0; x--) {
    const i = y * N + x;
    if (D[i]) D[i] = Math.min(D[i], at(x + 1, y) + 1, at(x, y + 1) + 1, at(x + 1, y + 1) + 1.414, at(x - 1, y + 1) + 1.414);
  }
  let max = 1;
  for (let i = 0; i < N * N; i++) if (D[i] > max) max = D[i];
  const out = g.createImageData(N, N);
  for (let i = 0; i < N * N; i++) {
    const v = Math.min(1, D[i] / (max * 0.85)) * 255;
    out.data[i * 4] = out.data[i * 4 + 1] = out.data[i * 4 + 2] = v;
    out.data[i * 4 + 3] = 255;
  }
  g.putImageData(out, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.NoColorSpace;
  const insideAt = (x, y) => {
    const [px, py] = toPx(x, y);
    const ix = Math.floor(px), iy = Math.floor(py);
    return ix >= 0 && iy >= 0 && ix < N && iy < N && inside[iy * N + ix] === 1;
  };
  return { tex, insideAt };
}

async function getGlyphData(ch) {
  if (glyphCache.has(ch)) return glyphCache.get(ch);
  const p = (async () => {
    const g = await loadGlyph(ch).catch(() => null);
    if (!g) return null;
    const adv = g.glyph.advanceWidth / g.upem;
    const shapes = glyphShapes(g.glyph, g.upem);
    if (!shapes.length) return { adv, empty: true };

    const iceGeo = new THREE.ExtrudeGeometry(shapes, {
      depth: DEPTH, bevelEnabled: true, bevelThickness: BEVEL_T, bevelSize: BEVEL_S,
      bevelSegments: 3, curveSegments: 8,
      // Bevel mostly inward, so thin brush tips stay pointed like icicles
      bevelOffset: -BEVEL_S * 0.6,
    });
    const Y_MID = g.yMid; // vertical center of the glyph's em box
    iceGeo.translate(-adv / 2, -Y_MID, -DEPTH / 2);
    iceGeo.computeBoundingBox();

    const flatGeo = new THREE.ShapeGeometry(shapes, 5);
    flatGeo.translate(-adv / 2, -Y_MID, 0);

    // Outline segments + sharp corners (stroke ends and turns)
    const lines = [], corners = [], lowPts = [], outline = [];
    const box = iceGeo.boundingBox;
    for (const s of shapes) {
      const ex = s.extractPoints(4);
      for (const ring of [ex.shape, ...ex.holes]) {
        const pts = ring.map(p => new THREE.Vector2(p.x - adv / 2, p.y - Y_MID));
        const n = pts.length;
        for (let i = 0; i < n; i++) {
          const a = pts[(i - 1 + n) % n], b = pts[i], c = pts[(i + 1) % n];
          lines.push(b.x, b.y, FRONT_Z + 0.004, c.x, c.y, FRONT_Z + 0.004);
          const d1 = b.clone().sub(a), d2 = c.clone().sub(b);
          if (d1.length() > 1e-4 && d2.length() > 1e-4) {
            const ang = Math.abs(Math.atan2(d1.x * d2.y - d1.y * d2.x, d1.dot(d2)));
            if (ang > 0.9) corners.push(b);
          }
          if (d1.length() > 1e-4 || d2.length() > 1e-4) outline.push({ p: b, t: c.clone().sub(a).normalize(), corner: d1.length() > 1e-4 && d2.length() > 1e-4 && Math.abs(Math.atan2(d1.x * d2.y - d1.y * d2.x, d1.dot(d2))) > 0.9 });
          if (b.y < box.min.y + (box.max.y - box.min.y) * 0.22) lowPts.push(b);
        }
      }
    }
    // Distance field over the glyph: drives the edge-to-core colour and thickness
    const rings = [];
    for (const sh of shapes) {
      const ex = sh.extractPoints(8);
      for (const ring of [ex.shape, ...ex.holes]) rings.push(ring.map(p => new THREE.Vector2(p.x - adv / 2, p.y - Y_MID)));
    }
    const sdfBox = { min: new THREE.Vector2(box.min.x - 0.01, box.min.y - 0.01), max: new THREE.Vector2(box.max.x + 0.01, box.max.y + 0.01) };
    const field = glyphField(rings, sdfBox), sdf = field.tex, insideAt = field.insideAt;
    // Outline points facing out of the glyph
    const edges = [];
    for (const o of outline) {
      const n = new THREE.Vector2(-o.t.y, o.t.x);
      const a = insideAt(o.p.x + n.x * 0.02, o.p.y + n.y * 0.02), b = insideAt(o.p.x - n.x * 0.02, o.p.y - n.y * 0.02);
      if (a === b) continue; // ambiguous (hairline or cramped spot)
      if (a) n.negate();
      edges.push({ p: o.p, t: o.t, n, corner: o.corner });
    }

    const lineGeo = new THREE.BufferGeometry();
    lineGeo.setAttribute('position', new THREE.Float32BufferAttribute(lines, 3));

    // Points spread over the glyph face, for shards and powder
    const face = [];
    const pos = flatGeo.attributes.position, idx = flatGeo.index;
    const triCount = idx ? idx.count / 3 : pos.count / 3;
    const vi = i => (idx ? idx.getX(i) : i);
    const areas = [];
    let total = 0;
    for (let t = 0; t < triCount; t++) {
      const a = vi(t * 3), b = vi(t * 3 + 1), c = vi(t * 3 + 2);
      const ar = Math.abs((pos.getX(b) - pos.getX(a)) * (pos.getY(c) - pos.getY(a)) - (pos.getX(c) - pos.getX(a)) * (pos.getY(b) - pos.getY(a))) / 2;
      total += ar; areas.push(total);
    }
    for (let k = 0; k < 80 && total > 0; k++) {
      const r = Math.random() * total;
      let t = areas.findIndex(v => v >= r);
      if (t < 0) t = triCount - 1;
      let u = Math.random(), v = Math.random();
      if (u + v > 1) { u = 1 - u; v = 1 - v; }
      const a = vi(t * 3), b = vi(t * 3 + 1), c = vi(t * 3 + 2);
      face.push(new THREE.Vector2(
        pos.getX(a) + (pos.getX(b) - pos.getX(a)) * u + (pos.getX(c) - pos.getX(a)) * v,
        pos.getY(a) + (pos.getY(b) - pos.getY(a)) * u + (pos.getY(c) - pos.getY(a)) * v,
      ));
    }

    // Glint candidates: front-facing vertices, mostly on the bevel
    const gp = iceGeo.attributes.position, gn = iceGeo.attributes.normal;
    const cand = [];
    for (let i = 0; i < gp.count; i++) if (gn.getZ(i) > 0.15) cand.push(i);

    return { adv, shapes, iceGeo, flatGeo, lineGeo, corners, lowPts, face, cand, box, sdf, sdfBox, edges, insideAt };
  })();
  glyphCache.set(ch, p);
  return p;
}

// -----------------------------------------------------------------------------
// Snowflakes: six-fold dendrites, every one different
// -----------------------------------------------------------------------------
function bar(x1, y1, x2, y2, w1, w2) {
  const dx = x2 - x1, dy = y2 - y1, L = Math.hypot(dx, dy) || 1;
  const nx = -dy / L, ny = dx / L;
  const s = new THREE.Shape();
  s.moveTo(x1 + nx * w1 / 2, y1 + ny * w1 / 2);
  s.lineTo(x2 + nx * w2 / 2, y2 + ny * w2 / 2);
  s.lineTo(x2 - nx * w2 / 2, y2 - ny * w2 / 2);
  s.lineTo(x1 - nx * w1 / 2, y1 - ny * w1 / 2);
  return s;
}
function hexagon(x, y, r, rot = 0) {
  const s = new THREE.Shape();
  for (let k = 0; k < 6; k++) {
    const a = rot + k * Math.PI / 3;
    k ? s.lineTo(x + Math.cos(a) * r, y + Math.sin(a) * r) : s.moveTo(x + Math.cos(a) * r, y + Math.sin(a) * r);
  }
  return s;
}

function makeFlakeGeometry(R) {
  // Arm template in a local frame along +x, unit radius 0.5
  const L = 0.5, w = 0.03 + R() * 0.025, kind = R();
  const parts = [['bar', 0, 0, L, 0, w, w * 0.45]];
  const nb = 2 + ((R() * 3) | 0);
  for (let i = 0; i < nb; i++) {
    const t = L * (0.22 + 0.68 * (i + R() * 0.6) / nb);
    const bl = (L - t) * (0.35 + R() * 0.55) * (kind < 0.25 ? 0.55 : 1);
    const bw = w * 0.7;
    for (const sd of [-1, 1]) parts.push(['bar', t, 0, t + Math.cos(Math.PI / 3) * bl, sd * Math.sin(Math.PI / 3) * bl, bw, bw * 0.4]);
  }
  if (R() < 0.5) parts.push(['hex', L, 0, w * 1.4 + R() * 0.025]);
  if (kind < 0.25) parts.push(['hex', L * 0.45, 0, 0.07 + R() * 0.03]); // sector plate

  const shapes = [hexagon(0, 0, 0.07 + R() * 0.08, Math.PI / 6)];
  for (let k = 0; k < 6; k++) {
    const a = (k * Math.PI) / 3, c = Math.cos(a), s = Math.sin(a);
    const tr = (x, y) => [x * c - y * s, x * s + y * c];
    for (const p of parts) {
      if (p[0] === 'bar') {
        const [x1, y1] = tr(p[1], p[2]), [x2, y2] = tr(p[3], p[4]);
        shapes.push(bar(x1, y1, x2, y2, p[5], p[6]));
      } else {
        const [x, y] = tr(p[1], p[2]);
        shapes.push(hexagon(x, y, p[3], a + Math.PI / 6));
      }
    }
  }
  const geo = new THREE.ExtrudeGeometry(shapes, { depth: 0.025, bevelEnabled: false, curveSegments: 1 });
  geo.translate(0, 0, -0.0125);
  return geo;
}

function makeFlake(R, size) {
  const m = new THREE.Mesh(makeFlakeGeometry(R), flakeMat);
  m.userData.size = size;
  m.scale.setScalar(0.0001);
  return m;
}

// -----------------------------------------------------------------------------
// Ice flowers: translucent veined petals, gently cupped, around a heart.
// Every flower varies (petal shape, count, layers, openness, heart, tint,
// veins, size), all drawn from the glyph's own seeded random.
// -----------------------------------------------------------------------------
const MELT_TIME = 2.1; // seconds for the ice to melt away completely

// Petal vein textures: fine veins fanning from the root, a midrib with side
// veins, or nearly smooth
function makeVeinTexture(kind) {
  const w = 128, h = 256;
  const c = canvas(w, h), g = c.getContext('2d');
  g.fillStyle = '#f3faff'; g.fillRect(0, 0, w, h);
  if (kind === 0) {
    for (let i = -5; i <= 5; i++) {
      g.strokeStyle = i === 0 ? 'rgba(150,190,228,0.75)' : 'rgba(165,200,232,0.5)';
      g.lineWidth = i === 0 ? 1.6 : 1;
      g.beginPath();
      g.moveTo(w / 2, h - 4);
      g.quadraticCurveTo(w / 2 + i * 5, h * 0.55, w / 2 + i * 10, 18 + Math.abs(i) * 10);
      g.stroke();
    }
  } else if (kind === 1) {
    g.strokeStyle = 'rgba(145,186,226,0.8)'; g.lineWidth = 1.8;
    g.beginPath(); g.moveTo(w / 2, h - 4); g.quadraticCurveTo(w / 2 + 2, h * 0.5, w / 2, 14); g.stroke();
    g.lineWidth = 0.9; g.strokeStyle = 'rgba(165,200,232,0.45)';
    for (let i = 1; i <= 7; i++) {
      const y = h - 18 - i * 28;
      for (const sd of [-1, 1]) {
        g.beginPath(); g.moveTo(w / 2, y);
        g.quadraticCurveTo(w / 2 + sd * w * 0.16, y - 8, w / 2 + sd * w * 0.42, y - 30);
        g.stroke();
      }
    }
  } else {
    g.strokeStyle = 'rgba(170,205,235,0.18)'; g.lineWidth = 1;
    g.beginPath(); g.moveTo(w / 2, h - 4); g.lineTo(w / 2, h * 0.35); g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
const VEIN_TEX = [0, 1, 2].map(makeVeinTexture);

// Warm light pooled at the petal roots (emissive map, root at uv.y = 0)
function makeRootGlowTexture() {
  const e = canvas(16, 128), eg = e.getContext('2d');
  const gr = eg.createLinearGradient(0, 128, 0, 0);
  gr.addColorStop(0, '#ffd08a');
  gr.addColorStop(0.3, '#7a4a20');
  gr.addColorStop(0.6, '#000');
  eg.fillStyle = gr; eg.fillRect(0, 0, 16, 128);
  const t = new THREE.CanvasTexture(e);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
const rootGlowTex = makeRootGlowTexture();

// GLSL value noise, shared by everything that melts with a glyph
const NOISE_GLSL = `
vec3 ihash3(vec3 p){
  p = vec3(dot(p, vec3(127.1, 311.7, 74.7)), dot(p, vec3(269.5, 183.3, 246.1)), dot(p, vec3(113.5, 271.9, 124.6)));
  return fract(sin(p) * 43758.5453);
}
float inoise(vec3 x){
  vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
  float a = ihash3(i).x, b = ihash3(i + vec3(1, 0, 0)).x, c = ihash3(i + vec3(0, 1, 0)).x, d = ihash3(i + vec3(1, 1, 0)).x;
  float e = ihash3(i + vec3(0, 0, 1)).x, g = ihash3(i + vec3(1, 0, 1)).x, h = ihash3(i + vec3(0, 1, 1)).x, k = ihash3(i + vec3(1, 1, 1)).x;
  return mix(mix(mix(a, b, f.x), mix(c, d, f.x), f.y), mix(mix(e, g, f.x), mix(h, k, f.x), f.y), f.z);
}
`;

// Make a material melt away with its glyph: the fragment is placed in the
// glyph's own space (uGlyphInv) and run through the same melt field.
// o.root: tint the petal toward this colour at its root (uses the map uv)
function meltWithGlyph(m, clipU, key, o = {}) {
  const extra = {};
  if (o.root) extra.uRoot = { value: new THREE.Color(...o.root) };
  m.onBeforeCompile = sh => {
    Object.assign(sh.uniforms, clipU, extra);
    sh.vertexShader = 'uniform mat4 uGlyphInv;\nvarying vec3 vGlyphPos;\n' + sh.vertexShader.replace('#include <begin_vertex>',
      '#include <begin_vertex>\nvGlyphPos = (uGlyphInv * modelMatrix * vec4(transformed, 1.0)).xyz;');
    let fs = 'uniform float uMelt, uSeed;\nuniform vec4 uBox;\nvarying vec3 vGlyphPos;\n' + (o.root ? 'uniform vec3 uRoot;\n' : '') + NOISE_GLSL + sh.fragmentShader
      .replace('#include <clipping_planes_fragment>', '#include <clipping_planes_fragment>\n' + MELT_LINE.replaceAll('vObjPos', 'vGlyphPos'));
    if (o.root) fs = fs.replace('#include <map_fragment>', '#include <map_fragment>\ndiffuseColor.rgb *= mix(uRoot, vec3(1.0), smoothstep(0.0, 0.55, vMapUv.y));');
    sh.fragmentShader = fs;
  };
  m.customProgramCacheKey = () => 'melt-' + key + (o.root ? '-root' : '');
  return m;
}

// Petal outlines. Built as a grid (rows along the petal, columns across) so
// the petal can cup: it curls up along its length and its sides lift.
const PETAL_SHAPES = ['round', 'pointed', 'notched', 'narrow', 'wavy', 'spoon', 'fringed', 'lance', 'heart'];
function petalGeometry(shape, cup, cupX) {
  const L = { narrow: 1.15, lance: 1.3 }[shape] || 1;
  const W = { round: 0.44, pointed: 0.38, notched: 0.42, narrow: 0.19, wavy: 0.44, spoon: 0.4, fringed: 0.44, lance: 0.24, heart: 0.5 }[shape];
  const notch = { notched: 0.12, heart: 0.22 }[shape] || 0;
  const hwAt = v => {
    if (shape === 'pointed' || shape === 'lance') return W * 2.8 * Math.pow(v, 0.6) * Math.pow(1 - v, 0.95);
    if (notch) return W * 1.08 * Math.pow(Math.sin(Math.PI * v * (shape === 'heart' ? 0.82 : 0.88)), 0.55);
    if (shape === 'narrow') return W * Math.pow(Math.sin(Math.PI * v), 0.45);
    if (shape === 'spoon') return W * Math.pow(Math.sin(Math.PI * v * 0.9), 0.5) * (0.3 + 0.7 * v); // slim claw, wide round tip
    const r = W * Math.pow(Math.sin(Math.PI * v), 0.55);
    return shape === 'wavy' ? r * (1 + 0.08 * Math.sin(v * Math.PI * 7)) : r;
  };
  const rows = 14, cols = 6;
  const pos = [], uv = [], idx = [];
  for (let j = 0; j <= rows; j++) {
    const v = j / rows, hw = hwAt(v);
    for (let i = 0; i <= cols; i++) {
      const c = (i / cols) * 2 - 1;
      const x = c * hw;
      let y = v * L;
      if (notch) y -= L * notch * (1 - Math.abs(c)) * Math.pow(v, 8); // the notch at the tip
      if (shape === 'fringed') y -= L * 0.06 * Math.abs(Math.sin(c * Math.PI * 2.5)) * Math.pow(v, 6); // small teeth
      const z = cup * v * v * L + cupX * c * c * v * L * 0.4;
      pos.push(x, y, z);
      uv.push(0.5 + x / (2 * W * 1.1), v);
    }
  }
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const a = j * (cols + 1) + i, b = a + 1, c2 = a + cols + 1, d = c2 + 1;
      idx.push(a, b, d, a, d, c2);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// Faint tints over clear ice; dawn adds warm pink near the heart
const FLOWER_TINTS = [
  { color: 0xf4f9ff, root: [0.86, 0.93, 1.0], glow: 0xffa850 },              // clear
  { color: 0xdcedff, root: [0.62, 0.8, 0.98], glow: 0xffb070 },              // pale ice blue
  { color: 0xebe4ff, root: [0.8, 0.72, 0.98], glow: 0xffa890 },              // faint lavender
  { color: 0xfff6f6, root: [1.0, 0.8, 0.84], glow: 0xff9cae },               // dawn pink at the heart
];
const OPENNESS = { bud: 1.18, cup: 0.98, half: 0.78, full: 0.38, flat: 0.08, reflex: -0.18 }; // resting petal lift (reflex: bent back)
const HEARTS = ['glow', 'filaments', 'crystals', 'clear'];

// Shuffle a copy with the glyph's random, so one glyph's flowers differ
function shuffled(arr, R) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = (R() * (i + 1)) | 0; [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

// The original ice flower: two layers of translucent, finely veined, cupped
// petals (the inner layer smaller, offset and more closed) around a small
// warm glowing heart. shape 'classic' is the original rounded petal; other
// shapes reuse the same style with a different outline.

// Ice leaf: a pointed oval with a slight fold along the midrib, lifting at
// the tip. Uses the midrib vein texture.
const leafCache = [];
function leafGeometry(variant) {
  if (leafCache[variant]) return leafCache[variant];
  const L = 1, w = 0.26 + variant * 0.05;
  const sh = new THREE.Shape();
  sh.moveTo(0, 0);
  sh.bezierCurveTo(w * 1.1, L * 0.25, w * 0.9, L * 0.72, 0, L);
  sh.bezierCurveTo(-w * 0.9, L * 0.72, -w * 1.1, L * 0.25, 0, 0);
  const geo = new THREE.ShapeGeometry(sh, 14);
  const p = geo.attributes.position, uv = geo.attributes.uv;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i);
    uv.setXY(i, x / (2.4 * w) + 0.5, y / L);
    p.setZ(i, 0.18 * Math.abs(x) + 0.16 * y * y); // V fold along the midrib, tip lifts
  }
  geo.computeVertexNormals();
  leafCache[variant] = geo;
  return geo;
}
// Leaves and frost lie over the transmissive letter, so
// they are translucent rather than transmissive (or they would vanish)
const leafMat = new THREE.MeshPhysicalMaterial({
  color: 0xd9efec, map: VEIN_TEX[1], roughness: 0.3, transparent: true, opacity: 0.8, side: THREE.DoubleSide,
  clearcoat: 0.4, clearcoatRoughness: 0.2, specularIntensity: 0.5, emissive: 0x9fd6d8, emissiveIntensity: 0.1, envMapIntensity: 0.9,
});
// Icicles hang below the strokes, against the night, so they can be clear ice
const icicleMat = new THREE.MeshPhysicalMaterial({
  color: 0xf2f8ff, roughness: 0.04, transmission: 0.9, thickness: 0.05, ior: 1.31,
  clearcoat: 1, clearcoatRoughness: 0.03, emissive: 0x9cc4f0, emissiveIntensity: 0.18, envMapIntensity: 2,
});
// An icicle: a slim cone from the top (y = 0) down to a sharp tip, with
// a few gentle bulges where it dripped and refroze
function icicleGeometry(len, rad, phase) {
  const pts = [];
  for (let i = 0; i <= 10; i++) {
    const t = i / 10;
    pts.push(new THREE.Vector2(Math.max(0.0004, rad * Math.pow(1 - t, 0.85) * (1 + 0.14 * Math.sin(t * 11 + phase))), -len * t));
  }
  return new THREE.LatheGeometry(pts.reverse(), 8);
}

const classicPetalCache = [];
function classicPetal(variant) {
  if (classicPetalCache[variant]) return classicPetalCache[variant];
  const L = 1, w = 0.4 + variant * 0.06;
  const sh = new THREE.Shape();
  sh.moveTo(0, 0);
  sh.bezierCurveTo(w, L * 0.22, w * 0.95, L * 0.78, 0, L);
  sh.bezierCurveTo(-w * 0.95, L * 0.78, -w, L * 0.22, 0, 0);
  const geo = new THREE.ShapeGeometry(sh, 12);
  const p = geo.attributes.position, uv = geo.attributes.uv;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i);
    uv.setXY(i, x / (2 * w) + 0.5, y / L);
    p.setZ(i, 0.28 * y * y + 0.12 * (x / w) * (x / w) * y); // cup the petal
  }
  geo.computeVertexNormals();
  classicPetalCache[variant] = geo;
  return geo;
}
function makeClassicFlower(R, spec, clipU, owned) {
  const group = new THREE.Group();
  const tint = FLOWER_TINTS[spec.tint || 0];
  const mat = meltWithGlyph(new THREE.MeshPhysicalMaterial({
    color: spec.tint ? tint.color : 0xeaf5ff, map: VEIN_TEX[0], roughness: 0.14, transmission: 0.82, thickness: 0.04, ior: 1.31,
    emissive: tint.glow, emissiveMap: rootGlowTex, emissiveIntensity: 0.9,
    envMapIntensity: 2.2, side: THREE.DoubleSide,
  }), clipU, 'classic', { root: spec.tint ? tint.root : null });
  owned.mats.push(mat);
  const bud = spec.open === 'bud', n = spec.petals, radius = spec.radius;
  const outer = { r: radius, open: bud ? 1.12 : spec.flat ? 0.12 + R() * 0.1 : 0.32 + R() * 0.12, rot: R() * TAU };
  const layers = [outer, { r: radius * 0.62, open: bud ? 1.25 : 0.75, rot: outer.rot + Math.PI / n }].slice(0, spec.layers || 2);
  const petals = [];
  layers.forEach((ly, li) => {
    let geo = null;
    if (spec.shape !== 'classic') { geo = petalGeometry(spec.shape, 0.28, 0.12); owned.geos.push(geo); }
    for (let k = 0; k < n; k++) {
      const pivot = new THREE.Group();
      pivot.rotation.z = ly.rot + (k * TAU) / n + (R() - 0.5) * 0.15;
      const mesh = new THREE.Mesh(geo || classicPetal((R() * 3) | 0), mat);
      mesh.scale.setScalar(ly.r * (0.9 + R() * 0.2));
      mesh.position.z = li * 0.004;
      mesh.rotation.x = 1.35;
      pivot.add(mesh);
      group.add(pivot);
      petals.push({ mesh, open: ly.open + (R() - 0.5) * 0.1, d: li * 0.15 + k * 0.03 });
    }
  });
  const hm = meltWithGlyph(new THREE.MeshBasicMaterial({ color: new THREE.Color(1.0, 0.72, 0.38).multiplyScalar(1.8) }), clipU, 'basic');
  const hg = new THREE.SphereGeometry(radius * 0.13, 12, 8);
  owned.mats.push(hm); owned.geos.push(hg);
  const heart = new THREE.Mesh(hg, hm);
  heart.position.z = radius * 0.08;
  if (!bud) group.add(heart);

  // One or two ice leaves tucked under the petals, pointing outward
  if (!bud && spec.leaves) {
    const lm = meltWithGlyph(leafMat.clone(), clipU, 'leaf');
    owned.mats.push(lm);
    const a0 = R() * TAU;
    for (let k = 0; k < spec.leaves; k++) {
      const pivot = new THREE.Group();
      pivot.rotation.z = a0 + k * (2.2 + R() * 1.2);
      const leaf = new THREE.Mesh(leafGeometry((R() * 3) | 0), lm);
      leaf.scale.setScalar(radius * (1.55 + R() * 0.35)); // reaching well past the petals
      leaf.rotation.x = 0.12 + R() * 0.12;
      leaf.position.z = -0.006;
      pivot.add(leaf);
      group.add(pivot);
    }
  }
  group.userData = { petals, bud };
  group.scale.setScalar(0.0001);
  return group;
}

// One flower. spec: { radius, shape, petals, layers, open, heart, tint, veins }
// Returns a group; userData.petals carries the opening animation.
function makeFlower(R, spec, clipU, owned) {
  if (spec.classic) return makeClassicFlower(R, spec, clipU, owned);
  const group = new THREE.Group();
  const tint = FLOWER_TINTS[spec.tint];
  const glowK = spec.heart === 'glow' ? 0.65 : spec.heart === 'clear' ? 0 : 0.3;
  const root = spec.heart === 'clear' ? tint.root.map(v => v * 0.85) : tint.root;
  const mat = meltWithGlyph(new THREE.MeshPhysicalMaterial({
    color: tint.color, map: VEIN_TEX[spec.veins], roughness: 0.14, transmission: 0.82, thickness: 0.04, ior: 1.31,
    emissive: tint.glow, emissiveMap: rootGlowTex, emissiveIntensity: spec.tint === 3 ? Math.max(glowK, 0.45) : glowK,
    envMapIntensity: 2.2, side: THREE.DoubleSide,
  }), clipU, 'petal', { root });
  owned.mats.push(mat);

  const petals = [];
  const rot0 = R() * TAU;
  for (let li = 0; li < spec.layers; li++) {
    const n = spec.petals;
    const cup = (0.18 + R() * 0.26) + li * 0.08, cupX = 0.08 + R() * 0.1;
    const geo = petalGeometry(spec.shape, cup, cupX);
    owned.geos.push(geo);
    const scale = spec.radius * [1, 0.72, 0.5][li];
    const rest = Math.min(1.3, OPENNESS[spec.open] + li * 0.32); // inner layers stay more cupped
    for (let k = 0; k < n; k++) {
      const pivot = new THREE.Group();
      pivot.rotation.z = rot0 + (li * Math.PI) / n + (k * TAU) / n + (R() - 0.5) * 0.15;
      const mesh = new THREE.Mesh(geo, mat);
      mesh.scale.setScalar(scale * (0.9 + R() * 0.2));
      mesh.position.z = li * 0.004;
      mesh.rotation.x = 1.45;
      mesh.rotation.y = spec.twist || 0;
      pivot.add(mesh);
      group.add(pivot);
      // Outer layers open first, each petal a touch after the last
      petals.push({ mesh, open: rest + (R() - 0.5) * 0.1, d: li * 0.2 + k * 0.035 });
    }
  }

  if (spec.sepals) {
    const sg = petalGeometry('pointed', 0.06, 0.05);
    owned.geos.push(sg);
    for (let k = 0; k < spec.petals; k++) {
      const pivot = new THREE.Group();
      pivot.rotation.z = rot0 + Math.PI / spec.petals + (k * TAU) / spec.petals;
      const mesh = new THREE.Mesh(sg, mat);
      mesh.scale.setScalar(spec.radius * (0.55 + R() * 0.12));
      mesh.position.z = -0.004;
      mesh.rotation.x = 1.45;
      pivot.add(mesh);
      group.add(pivot);
      petals.push({ mesh, open: 0.02 + R() * 0.1, d: -0.05 });
    }
  }

  // The heart
  const r = spec.radius;
  if (spec.heart === 'glow') {
    const hm = meltWithGlyph(new THREE.MeshBasicMaterial({ color: new THREE.Color(1.0, 0.72, 0.38).multiplyScalar(1.8) }), clipU, 'basic');
    const hg = new THREE.SphereGeometry(r * 0.07, 12, 8);
    owned.mats.push(hm); owned.geos.push(hg);
    const heart = new THREE.Mesh(hg, hm);
    heart.position.z = r * 0.06;
    group.add(heart);
  } else if (spec.heart === 'filaments') {
    // Fine ice threads, each tipped with a tiny bright bead
    const fm = meltWithGlyph(flakeMat.clone(), clipU, 'flake');
    const bm = meltWithGlyph(new THREE.MeshBasicMaterial({ color: new THREE.Color(0.95, 0.98, 1.0).multiplyScalar(1.6) }), clipU, 'basic');
    const nf = 6 + ((R() * 4) | 0);
    const fg = new THREE.ConeGeometry(r * 0.012, 1, 4, 1); fg.translate(0, 0.5, 0);
    const bg = new THREE.SphereGeometry(r * 0.022, 8, 6);
    owned.mats.push(fm, bm); owned.geos.push(fg, bg);
    for (let k = 0; k < nf; k++) {
      const h = r * (0.28 + R() * 0.18), a = (k / nf) * TAU + R() * 0.5, lean = 0.35 + R() * 0.3;
      const dir = new THREE.Vector3(Math.cos(a) * lean, Math.sin(a) * lean, 1).normalize();
      const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
      const f = new THREE.Mesh(fg, fm);
      f.quaternion.copy(q); f.scale.set(1, h, 1);
      const b = new THREE.Mesh(bg, bm);
      b.position.copy(dir).multiplyScalar(h);
      group.add(f, b);
    }
  } else if (spec.heart === 'crystals') {
    // A small cluster of pointed ice crystals
    const cm = meltWithGlyph(flakeMat.clone(), clipU, 'flake');
    const cg = new THREE.ConeGeometry(1, 1, 6, 1); cg.translate(0, 0.5, 0);
    owned.mats.push(cm); owned.geos.push(cg);
    const nc = 5 + ((R() * 3) | 0);
    for (let k = 0; k < nc; k++) {
      const h = r * (0.14 + R() * 0.16), a = R() * TAU, lean = R() * 0.55;
      const dir = new THREE.Vector3(Math.cos(a) * lean, Math.sin(a) * lean, 1).normalize();
      const c = new THREE.Mesh(cg, cm);
      c.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
      c.scale.set(h * 0.22, h, h * 0.22);
      c.position.set(Math.cos(a) * r * 0.04, Math.sin(a) * r * 0.04, 0);
      group.add(c);
    }
  }
  group.userData = { petals, bud: spec.open === 'bud' };
  group.scale.setScalar(0.0001);
  return group;
}

// Pick 1-3 flowers for a glyph: a lone large bloom, or a large and a small
// one side by side, sometimes with one or two tiny buds beside them.
// Shapes, petal counts and tints differ within a glyph.
// Flower kinds in the original style. Each pairs a petal outline with its
// own petal count and structure so the silhouettes read differently even
// at small sizes.
const FLOWER_KINDS = {
  classic: { shape: 'classic', petals: [5, 6], layers: 2 },          // the original rounded bloom
  sakura:  { shape: 'notched', petals: [5], layers: 1, flat: true }, // cherry blossom: five notched petals, wide open
  star:    { shape: 'narrow', petals: [8, 10], layers: 1, flat: true }, // a star of slim petals
  pointed: { shape: 'pointed', petals: [5, 6], layers: 2 },          // sharp-tipped, double
  wavy:    { shape: 'wavy', petals: [6], layers: 2 },                // ruffled edges
  spoon:   { shape: 'spoon', petals: [4], layers: 1, flat: true },   // four broad-tipped petals
};
const KIND_NAMES = Object.keys(FLOWER_KINDS);

function planFlowers(R, narrow) {
  // Chinese characters: mostly two or three flowers, sometimes one.
  // Latin letters: usually one. Kinds, sizes and tints differ within a glyph.
  const q = R();
  const n = narrow ? (R() < 0.6 ? 1 : 0) : q < 0.25 ? 1 : q < 0.78 ? 2 : 3;
  const kinds = shuffled(KIND_NAMES, R), tints = shuffled([0, 1, 2, 3], R);
  const list = [];
  for (let k = 0; k < n; k++) {
    const kind = FLOWER_KINDS[kinds[k]];
    const radius = (k === 0 ? 0.16 + R() * 0.06 : 0.1 + R() * 0.05) * (narrow ? 0.8 : 1);
    list.push({
      classic: true, kind: kinds[k], shape: kind.shape, layers: kind.layers, flat: !!kind.flat,
      petals: kind.petals[(R() * kind.petals.length) | 0], tint: tints[k % tints.length],
      radius, open: 'full', role: 'main',
      leaves: R() < 0.7 ? 1 + (R() < 0.4 ? 1 : 0) : 0,
    });
  }
  return list;
}

// A tube that thins to a sharp point (radius r0 at the start)
function taperedTube(pts, r0, segs, radial) {
  // Drop repeated points: a zero-length curve yields NaN positions
  pts = pts.filter((p, i) => i === 0 || p.distanceTo(pts[i - 1]) > 1e-5);
  if (pts.length < 2) pts = [new THREE.Vector3(), new THREE.Vector3(1e-4, 0, 0)];
  const curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal');
  const g = new THREE.TubeGeometry(curve, segs, 1, radial, false);
  const pos = g.attributes.position, per = radial + 1;
  for (let i = 0; i <= segs; i++) {
    const c = curve.getPointAt(i / segs), r = r0 * Math.pow(1 - i / segs, 0.8);
    for (let j = 0; j < per; j++) {
      const k = i * per + j;
      pos.setXYZ(k, c.x + (pos.getX(k) - c.x) * r, c.y + (pos.getY(k) - c.y) * r, c.z + (pos.getZ(k) - c.z) * r);
    }
  }
  return g;
}

// A slender ice twig in its own frame: starts at the origin heading +x,
// bends gently, maybe forks once. Returns the merged geometry and its tip.
function makeTwig(R, len) {
  const N = 12, bend = (R() - 0.5) * 1.1, parts = [];
  const pts = [];
  let x = 0, y = 0;
  for (let i = 0; i <= N; i++) {
    const a = bend * (i / N);
    if (i) { x += Math.cos(a) * len / N; y += Math.sin(a) * len / N; }
    pts.push(new THREE.Vector3(x, y, (i / N) * 0.02));
  }
  parts.push(taperedTube(pts, 0.007 + len * 0.025, 32, 6));
  if (R() < 0.5) {
    const i = 6 + ((R() * 3) | 0), a = bend * (i / N) + (R() < 0.5 ? 1 : -1) * (0.55 + R() * 0.35), fl = len * (0.3 + R() * 0.15);
    const f = [];
    for (let k = 0; k <= 5; k++) f.push(pts[i].clone().add(new THREE.Vector3(Math.cos(a) * fl * k / 5, Math.sin(a) * fl * k / 5, 0.004 * k)));
    parts.push(taperedTube(f, (0.007 + len * 0.025) * 0.55, 12, 5));
  }
  return { geo: mergeGeometries(parts), tip: pts[N].clone(), tipAngle: bend };
}

// Frost feather in its own frame along +y: a curved spine with twigs at
// about 60 degrees, each twig branching once more. Recursive, never the same.
// o: side-twig angle, how many twigs, how long, how far it branches, how much
// the spine curves, and whether twigs grow on one side only (a comb)
function makeFeather(R, size, o = {}) {
  const angle = o.angle ?? Math.PI / 3, dens = o.density ?? [5, 7], sideK = o.side ?? 1;
  const maxLevel = o.levels ?? 2, curve = o.curve ?? 1;
  const parts = [], radius = [0.005, 0.003, 0.0018];
  const twig = (px, py, ang, len, level) => {
    const n = level === 0 ? 10 : level === 1 ? 4 : 3;
    const bend = (R() - 0.5) * (level === 0 ? 0.5 * curve : 0.3) + (level === 0 && o.arc ? o.arc : 0);
    const pts = [new THREE.Vector3(px, py, 0)], angs = [ang];
    let x = px, y = py;
    for (let i = 1; i <= n; i++) {
      const a = ang + bend * (i / n);
      x += Math.cos(a) * (len / n); y += Math.sin(a) * (len / n);
      pts.push(new THREE.Vector3(x, y, 0)); angs.push(a);
    }
    parts.push(taperedTube(pts, radius[level], n * 2, 3));
    if (level >= maxLevel) return;
    const k = level === 0 ? dens[0] + ((R() * (dens[1] - dens[0] + 1)) | 0) : 2;
    for (let i = 0; i < k; i++) {
      const u = 0.15 + (0.72 * (i + R() * 0.4)) / k;
      const idx = Math.round(u * n);
      for (const side of o.oneSided ? [o.oneSided] : [-1, 1]) {
        if (level === 1 && R() < 0.25) continue;
        if (level === 0 && R() < 0.12) continue; // the odd gap
        const L2 = len * ((level === 0 ? 0.38 * sideK : 0.42) * (1 - u) + 0.08) * (0.8 + R() * 0.4);
        twig(pts[idx].x, pts[idx].y, angs[idx] + side * (angle + (R() - 0.5) * 0.2), L2, level + 1);
      }
    }
  };
  twig(0, 0, Math.PI / 2, size, 0);
  return mergeGeometries(parts);
}

// Twigs: clear ice like the flowers' crystals. Feathers: whiter, half clear.
// Twigs and feathers lie on the ice letter. A transmissive material over the
// transmissive letter shows the background instead and vanishes, so these
// are translucent instead.
const twigMat = new THREE.MeshPhysicalMaterial({
  color: 0xf6fbff, roughness: 0.12, transparent: true, opacity: 0.92, clearcoat: 1, clearcoatRoughness: 0.05,
  emissive: 0xc6dcf6, emissiveIntensity: 0.45, envMapIntensity: 2, specularIntensity: 1,
});
const featherMat = new THREE.MeshPhysicalMaterial({
  color: 0xf4f9ff, roughness: 0.2, transparent: true, opacity: 0.8,
  emissive: 0xbad4ff, emissiveIntensity: 0.3, envMapIntensity: 1.6,
});

// Afterimage on decorations: the same melt field drawn as a faint film
// where the ice (petal, twig, feather) has just melted
const decoGhostVS = `
  uniform mat4 uGlyphInv; varying vec3 vG;
  void main(){ vec4 w = modelMatrix * vec4(position, 1.0); vG = (uGlyphInv * w).xyz; gl_Position = projectionMatrix * viewMatrix * w; }`;
const decoGhostFS = `
  varying vec3 vG; uniform float uMelt, uSeed, uFade; uniform vec4 uBox;
  ${NOISE_GLSL}
  void main(){
    float meltH = clamp((vG.y - uBox.y) / max(uBox.w - uBox.y, 1e-3), 0.0, 1.0);
    float meltN = inoise(vG * 9.0 + uSeed) * 0.6 + inoise(vG * 3.5 + uSeed * 3.0) * 0.4;
    float since = meltH * 0.72 + meltN * 0.28 - (1.02 - uMelt * 1.08);
    if (since <= 0.0) discard;
    float a = (1.0 - smoothstep(0.0, 0.3, since)) * 0.12 * uFade;
    gl_FragColor = vec4(vec3(0.8, 0.9, 1.0), a);
  }`;

// -----------------------------------------------------------------------------
// Melt afterimage: where the ice has just melted, a faint film of water keeps
// the glyph's shape for a moment (a little brighter along its outline), then
// thins away. Uses the same melt field as the glyph so it starts exactly at
// the melting edge.
// -----------------------------------------------------------------------------
const ghostVS = `varying vec3 vP; void main(){ vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const ghostFS = `
  varying vec3 vP;
  uniform float uMelt, uSeed, uZ, uFade; uniform vec4 uBox, uSdfBox; uniform sampler2D uSdf;
  vec3 ihash3(vec3 p){
    p = vec3(dot(p, vec3(127.1, 311.7, 74.7)), dot(p, vec3(269.5, 183.3, 246.1)), dot(p, vec3(113.5, 271.9, 124.6)));
    return fract(sin(p) * 43758.5453);
  }
  float inoise(vec3 x){
    vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
    float a = ihash3(i).x, b = ihash3(i + vec3(1, 0, 0)).x, c = ihash3(i + vec3(0, 1, 0)).x, d = ihash3(i + vec3(1, 1, 0)).x;
    float e = ihash3(i + vec3(0, 0, 1)).x, g = ihash3(i + vec3(1, 0, 1)).x, h = ihash3(i + vec3(0, 1, 1)).x, k = ihash3(i + vec3(1, 1, 1)).x;
    return mix(mix(mix(a, b, f.x), mix(c, d, f.x), f.y), mix(mix(e, g, f.x), mix(h, k, f.x), f.y), f.z);
  }
  void main(){
    vec3 q = vec3(vP.xy, uZ);
    float meltH = clamp((q.y - uBox.y) / max(uBox.w - uBox.y, 1e-3), 0.0, 1.0);
    float meltN = inoise(q * 9.0 + uSeed) * 0.6 + inoise(q * 3.5 + uSeed * 3.0) * 0.4;
    float meltF = meltH * 0.72 + meltN * 0.28;
    float meltThr = 1.02 - uMelt * 1.08;
    float since = meltF - meltThr;            // how long ago this spot melted (in field units)
    if (since <= 0.0) discard;                // still ice here
    float a = 1.0 - smoothstep(0.0, 0.3, since);
    float inner = texture2D(uSdf, (vP.xy - uSdfBox.xy) / (uSdfBox.zw - uSdfBox.xy)).r;
    float rim = 1.0 - smoothstep(0.0, 0.3, inner);
    float ripple = 0.75 + 0.25 * inoise(vec3(vP.xy * 30.0, uSeed + uMelt * 3.0));
    a *= (0.09 + 0.13 * rim) * ripple * uFade;
    gl_FragColor = vec4(vec3(0.78, 0.9, 1.0), a);
  }`;

// -----------------------------------------------------------------------------
// Frost mist shader (the white haze that first outlines a glyph)
// -----------------------------------------------------------------------------
const mistVS = `varying vec2 vP; void main(){ vP = position.xy; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const mistFS = `
  varying vec2 vP; uniform float uA; uniform float uSeed;
  float h(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float n(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(h(i), h(i + vec2(1, 0)), f.x), mix(h(i + vec2(0, 1)), h(i + vec2(1, 1)), f.x), f.y); }
  void main(){
    vec2 p = vP * 14.0 + uSeed;
    float f = n(p) * 0.5 + n(p * 2.1) * 0.3 + n(p * 4.3) * 0.2;
    float sp = step(0.94, h(floor(vP * 110.0) + uSeed));
    float a = uA * (0.3 + 0.7 * f) + sp * uA * 0.5;
    gl_FragColor = vec4(vec3(0.9, 0.95, 1.0) * (1.1 + sp * 1.5), a * 0.82);
  }`;

// -----------------------------------------------------------------------------
// Glints: points that flash when a facet mirrors a light into the eye
// -----------------------------------------------------------------------------
const G_MAX = 8000;
const gPos = new Float32Array(G_MAX * 3), gAlpha = new Float32Array(G_MAX), gSize = new Float32Array(G_MAX);
const gGeo = new THREE.BufferGeometry();
gGeo.setAttribute('position', new THREE.BufferAttribute(gPos, 3).setUsage(THREE.DynamicDrawUsage));
gGeo.setAttribute('aAlpha', new THREE.BufferAttribute(gAlpha, 1).setUsage(THREE.DynamicDrawUsage));
gGeo.setAttribute('aSize', new THREE.BufferAttribute(gSize, 1).setUsage(THREE.DynamicDrawUsage));
const gMat = new THREE.ShaderMaterial({
  uniforms: { uTex: { value: starTex }, uPR: { value: PR } },
  vertexShader: `attribute float aAlpha; attribute float aSize; varying float vA; uniform float uPR;
    void main(){ vA = aAlpha; gl_PointSize = aSize * uPR; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: `uniform sampler2D uTex; varying float vA;
    void main(){ vec4 t = texture2D(uTex, gl_PointCoord); gl_FragColor = vec4(t.rgb * vA * 1.7, t.a * vA); }`,
  transparent: true, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending,
});
const glints = new THREE.Points(gGeo, gMat);
glints.frustumCulled = false;
glints.renderOrder = 100;
scene.add(glints);

let gN = 0;
const _p = new THREE.Vector3(), _n = new THREE.Vector3(), _v = new THREE.Vector3(), _l = new THREE.Vector3(), _h = new THREE.Vector3();
const _nm = new THREE.Matrix3();
// Specular response of a facet at world position p with world normal n
function glintAt(p, n, t, ph) {
  _v.copy(camera.position).sub(p).normalize();
  _h.copy(keyDir).add(_v).normalize();
  let s = n.dot(_h);
  // Fairly wide windows so a sparkle swells and fades instead of popping
  let a = smooth(0.958, 1, s);
  _l.copy(warmLight.position).sub(p).normalize();
  _h.copy(_l).add(_v).normalize();
  s = n.dot(_h);
  a = Math.max(a, smooth(0.966, 1, s) * 0.8);
  return a * a * (0.75 + 0.25 * Math.sin(t * 2.3 + ph));
}
function pushGlint(p, a, size) {
  if (a < 0.02 || gN >= G_MAX) return;
  gPos[gN * 3] = p.x; gPos[gN * 3 + 1] = p.y; gPos[gN * 3 + 2] = p.z;
  gAlpha[gN] = Math.min(1, a);
  gSize[gN] = size * (0.55 + 0.6 * a);
  gN++;
}

// -----------------------------------------------------------------------------
// Particle pools: shards (shatter) and water drops (melt)
// -----------------------------------------------------------------------------
function makePool(geo, mat, max) {
  const mesh = new THREE.InstancedMesh(geo, mat, max);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.count = 0;
  mesh.visible = false; // hidden while empty (see updateParticles)
  mesh.frustumCulled = false;
  scene.add(mesh);
  return { mesh, items: [], max };
}
// A lumpy, irregular chunk instead of a clean crystal: jitter the corners of
// a low-poly ball (shared corners move together so the solid stays closed)
function makeChunkGeometry() {
  const g = new THREE.IcosahedronGeometry(1, 0);
  const pos = g.attributes.position, moved = new Map();
  for (let i = 0; i < pos.count; i++) {
    const key = pos.getX(i).toFixed(3) + ',' + pos.getY(i).toFixed(3) + ',' + pos.getZ(i).toFixed(3);
    if (!moved.has(key)) moved.set(key, 0.45 + Math.random() * 0.85);
    const k = moved.get(key);
    pos.setXYZ(i, pos.getX(i) * k, pos.getY(i) * k, pos.getZ(i) * k);
  }
  g.computeVertexNormals();
  return g;
}
const shardPool = makePool(makeChunkGeometry(), shardMat, IS_MOBILE ? 900 : 2000);
// Teardrop: pointed at the top, round at the bottom (unit radius)
function makeDropGeometry() {
  const pts = [];
  for (let i = 0; i <= 24; i++) {
    const th = (i / 24) * Math.PI;
    pts.push(new THREE.Vector2(Math.max(0.0005, Math.sin(th) * Math.pow(Math.sin(th / 2), 0.35)), Math.cos(th) * 1.08));
  }
  return new THREE.LatheGeometry(pts, 20);
}
const dropPool = makePool(makeDropGeometry(), dropMat, 400);

// Ice powder: the soft white puff of crushed ice that hangs and settles
const P_MAX = 3000;
const pwPos = new Float32Array(P_MAX * 3), pwAlpha = new Float32Array(P_MAX), pwSize = new Float32Array(P_MAX);
const pwGeo = new THREE.BufferGeometry();
pwGeo.setAttribute('position', new THREE.BufferAttribute(pwPos, 3).setUsage(THREE.DynamicDrawUsage));
pwGeo.setAttribute('aAlpha', new THREE.BufferAttribute(pwAlpha, 1).setUsage(THREE.DynamicDrawUsage));
pwGeo.setAttribute('aSize', new THREE.BufferAttribute(pwSize, 1).setUsage(THREE.DynamicDrawUsage));
const powderMat = new THREE.ShaderMaterial({
  uniforms: { uPR: { value: PR } },
  vertexShader: `attribute float aAlpha; attribute float aSize; varying float vA; uniform float uPR;
    void main(){ vA = aAlpha; gl_PointSize = aSize * uPR; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: `varying float vA;
    void main(){ float r = length(gl_PointCoord - 0.5) * 2.0; float a = pow(max(0.0, 1.0 - r), 1.6);
      gl_FragColor = vec4(vec3(0.86, 0.92, 1.0), a * vA); }`,
  transparent: true, depthWrite: false,
});
const powderPoints = new THREE.Points(pwGeo, powderMat);
powderPoints.frustumCulled = false;
powderPoints.renderOrder = 90;
scene.add(powderPoints);
const powder = [];
const bursts = [];
const dust = []; // fine ice crystals drifting in the air
 // sparkling motes released by shattering
const fallers = []; // snowflakes drifting down through spaces
const _o = new THREE.Object3D();

// -----------------------------------------------------------------------------
// Characters
// -----------------------------------------------------------------------------
const root = new THREE.Group();
scene.add(root);
const active = [];  // characters in the text, in order
const dying = [];   // melting / shattering characters
let seedCounter = 1;

class IceChar {
  constructor(ch) {
    this.ch = ch;
    this.br = ch === '\n';                 // a line break: no ice, no width, starts a new line
    this.space = ch === ' ' || this.br;
    this.adv = this.br ? 0 : this.space ? 0.42 : /[\x00-\x7f]/.test(ch) ? 0.68 : 1.14;
    this.group = new THREE.Group();
    this.placed = false;
    this.state = 'loading';
    this.t0 = now();
    this.R = mulberry32((seedCounter++ * 2654435761) ^ (Math.random() * 1e9));
    this.flakes = [];
    this.flowers = [];
    this.owned = { geos: [], mats: [] }; // per-glyph decoration geometry / materials to dispose
    this.glintK = 0;
    root.add(this.group);
    if (!this.space) this.load();
  }

  async load() {
    const d = await getGlyphData(this.ch);
    if (this.state !== 'loading') return;
    if (!d || d.empty) {
      if (d) this.adv = d.adv;
      this.state = 'empty';
      return;
    }
    this.d = d;
    // A little air between blocks; Chinese characters sit a bit closer than their full em
    this.adv = d.adv > 0.8 ? d.adv - 0.08 : Math.max(d.adv, 0.3) + 0.08;
    const R = this.R;

    this.mat = makeGlyphMaterial(d);
    this.mat.roughness = 0.55;
    this.ice = new THREE.Mesh(d.iceGeo, this.mat);
    this.ice.scale.set(0.96, 0.96, 0.04);
    this.ice.visible = false;
    this.group.add(this.ice);

    this.mistU = { uA: { value: 0 }, uSeed: { value: R() * 50 } };
    this.mist = new THREE.Mesh(d.flatGeo, new THREE.ShaderMaterial({
      uniforms: this.mistU, vertexShader: mistVS, fragmentShader: mistFS,
      transparent: true, depthWrite: false,
    }));
    this.mist.position.z = FRONT_Z + 0.01;
    this.mist.renderOrder = 5;
    this.group.add(this.mist);
    this.outline = new THREE.LineSegments(d.lineGeo, new THREE.LineBasicMaterial({
      color: 0xeef6ff, transparent: true, opacity: 0, depthWrite: false,
    }));
    this.outline.renderOrder = 6;
    this.group.add(this.outline);

    // Decorations melt with the glyph: they share its melt uniforms and get
    // the glyph's inverse world matrix to place themselves in its space
    const gu = this.mat.userData.u;
    this.clipU = { uMelt: gu.uMelt, uBox: gu.uBox, uSeed: gu.uSeed, uGlyphInv: { value: new THREE.Matrix4() } };

    const narrow = d.adv < 0.75; // Latin letters: keep them uncluttered

    // Ice flowers resting on the face: one to three, each one different
    let main = null;
    planFlowers(R, narrow).forEach((sp, k) => {
      const fl = makeFlower(R, sp, this.clipU, this.owned);
      let p;
      if (sp.role === 'main' || !main) {
        // On a stroke, as far as possible from the flowers already placed
        let bestD = -1;
        for (let t = 0; t < 14; t++) {
          const f = d.face[(R() * d.face.length) | 0];
          if (!f) continue;
          const dd = this.flowers.length ? Math.min(...this.flowers.map(o => f.distanceTo(o.position) - o.userData.radius)) : R();
          if (dd > bestD) { bestD = dd; p = f; }
        }
        p = p || new THREE.Vector2();
      }
      else {
        // Nestle beside the main flower, but always on a stroke: the face
        // point closest to the ideal distance from it
        const want = main.userData.radius + sp.radius * (sp.role === 'bud' ? 1.1 : 0.85);
        let best = Infinity;
        for (const f of d.face) {
          const dd = Math.abs(f.distanceTo(main.position) - want) + (this.flowers.some(o => o !== main && f.distanceTo(o.position) < sp.radius) ? 1 : 0);
          if (dd < best) { best = dd; p = f; }
        }
      }
      fl.position.set(p.x, p.y, FRONT_Z + 0.005 + k * 0.003);
      // Each tilts its own way
      fl.rotation.set((R() - 0.5) * 0.5, (R() - 0.5) * 0.5, R() * TAU);
      fl.userData.radius = sp.radius;
      fl.userData.delay = 0.75 + k * 0.2;
      if (sp.role === 'main' && !main) main = fl;
      this.group.add(fl);
      this.flowers.push(fl);
    });

    // Now and then a slender ice twig reaches out from beside the main
    // flower with a tiny bud at its tip; more rarely a frost feather grows
    // from a stroke edge. Both stay sparse.
    this.extras = [];
    const cx = (d.box.min.x + d.box.max.x) / 2, cy = (d.box.min.y + d.box.max.y) / 2;
    if (main && R() < 0.32) {
      const len = 0.13 + R() * 0.08;
      const tw = makeTwig(R, len);
      const tm = meltWithGlyph(twigMat.clone(), this.clipU, 'twig');
      this.owned.geos.push(tw.geo); this.owned.mats.push(tm);
      // Lie along the strokes: head for a point on the glyph a twig-length away
      let away = R() * TAU, best = Infinity;
      for (let k = 0; k < 24; k++) {
        const f = d.face[(R() * d.face.length) | 0];
        const dd = Math.abs(f.distanceTo(main.position) - (len + main.userData.radius * 0.8));
        if (dd < best) { best = dd; away = Math.atan2(f.y - main.position.y, f.x - main.position.x); }
      }
      const holder = new THREE.Group();
      // Starts just past the main flower's petals so the flower doesn't hide it
      const r0 = main.userData.radius * 0.8;
      holder.position.set(main.position.x + Math.cos(away) * r0, main.position.y + Math.sin(away) * r0, FRONT_Z + 0.003);
      holder.rotation.z = away;
      holder.add(new THREE.Mesh(tw.geo, tm));
      holder.scale.setScalar(0.0001);
      this.group.add(holder);
      this.extras.push({ obj: holder, delay: 0.6, dur: 0.6 });
      // A bud on the tip, only if the tip is on a stroke
      const tip = tw.tip.clone().applyAxisAngle(new THREE.Vector3(0, 0, 1), away).add(holder.position);
      const budSpec = { classic: true, shape: 'classic', petals: 5, radius: 0.05 + R() * 0.015, open: 'bud' };
      if (d.insideAt(tip.x, tip.y)) {
        const bud = makeFlower(R, budSpec, this.clipU, this.owned);
        bud.position.set(tip.x, tip.y, FRONT_Z + 0.02);
        bud.rotation.set(0.5 * Math.sin(away + tw.tipAngle), -0.5 * Math.cos(away + tw.tipAngle), R() * TAU);
        bud.userData.radius = 0.06; bud.userData.delay = 1.05;
        this.group.add(bud);
        this.flowers.push(bud);
      }
    }
    this.tips = []; // glyph-local sparkle points: { p, n, t (seconds after typing), size, steady }

    // Window frost: now and then (rarely) a faint patch of frost on a stroke.
    // Each patch takes its own form, so no two look alike:
    //   fern     two or three fern fronds fanning from one point
    //   spray    a wide fan of short, sparse fronds
    //   plume    one long curving frond with short, dense barbs
    //   star     short fronds all the way round, like a frost crystal
    //   comb     a curved spine with barbs on one side only
    if (R() < 0.2 && d.face.length) {
      const e0 = d.face[(R() * d.face.length) | 0];
      let dir = R() * TAU, best = Infinity;
      for (let k = 0; k < 24; k++) {
        const f = d.face[(R() * d.face.length) | 0];
        const dd = Math.abs(f.distanceTo(e0) - 0.16);
        if (dd < best) { best = dd; dir = Math.atan2(f.y - e0.y, f.x - e0.x); }
      }
      const style = ['fern', 'spray', 'plume', 'star', 'comb'][(R() * 5) | 0];
      const fm = meltWithGlyph(featherMat.clone(), this.clipU, 'feather');
      fm.opacity = 0.45 + R() * 0.25;
      this.owned.mats.push(fm);
      const holder = new THREE.Group();
      holder.position.set(e0.x, e0.y, FRONT_Z + 0.004);
      holder.rotation.z = dir - Math.PI / 2;
      const fronds = [];
      if (style === 'fern') {
        const nf = 2 + (R() < 0.5 ? 1 : 0);
        for (let k = 0; k < nf; k++) fronds.push({ rot: (k - (nf - 1) / 2) * (0.45 + R() * 0.3), size: 0.09 + R() * 0.08, o: {} });
      } else if (style === 'spray') {
        const nf = 3 + ((R() * 3) | 0);
        for (let k = 0; k < nf; k++) fronds.push({ rot: (k / (nf - 1) - 0.5) * (1.8 + R() * 0.6), size: 0.05 + R() * 0.05, o: { angle: 0.8, density: [2, 4], levels: 1 } });
      } else if (style === 'plume') {
        fronds.push({ rot: (R() - 0.5) * 0.4, size: 0.16 + R() * 0.08, o: { angle: 1.25, density: [8, 10], side: 0.6, arc: (R() < 0.5 ? 1 : -1) * 0.7 } });
      } else if (style === 'star') {
        const nf = 5 + ((R() * 2) | 0), a0 = R() * TAU;
        for (let k = 0; k < nf; k++) fronds.push({ rot: a0 + (k * TAU) / nf + (R() - 0.5) * 0.25, size: 0.04 + R() * 0.03, o: { density: [2, 3], levels: 1 } });
      } else {
        fronds.push({ rot: (R() - 0.5) * 0.6, size: 0.12 + R() * 0.06, o: { angle: 0.9, density: [6, 8], oneSided: R() < 0.5 ? 1 : -1, arc: (R() < 0.5 ? 1 : -1) * 0.9 } });
      }
      for (const fr of fronds) {
        const fg = makeFeather(R, fr.size, fr.o);
        this.owned.geos.push(fg);
        const m = new THREE.Mesh(fg, fm);
        m.rotation.z = fr.rot;
        holder.add(m);
      }
      holder.scale.setScalar(0.0001);
      this.group.add(holder);
      this.extras.push({ obj: holder, delay: 1.0, dur: 0.8 });
    }

    // Now and then a leaf (or a pair, like a little sprig) frozen on a stroke
    // without a flower, lying along the stroke
    if (R() < 0.18 && d.face.length) {
      const e0 = d.face[(R() * d.face.length) | 0];
      let dir = R() * TAU, best = Infinity;
      for (let k = 0; k < 24; k++) {
        const f = d.face[(R() * d.face.length) | 0];
        const dd = Math.abs(f.distanceTo(e0) - 0.14);
        if (dd < best) { best = dd; dir = Math.atan2(f.y - e0.y, f.x - e0.x); }
      }
      const lm = meltWithGlyph(leafMat.clone(), this.clipU, 'leaf');
      this.owned.mats.push(lm);
      const holder = new THREE.Group();
      holder.position.set(e0.x, e0.y, FRONT_Z + 0.005);
      holder.rotation.z = dir - Math.PI / 2;
      const nl = R() < 0.55 ? 1 : 2;
      for (let k = 0; k < nl; k++) {
        const leaf = new THREE.Mesh(leafGeometry((R() * 3) | 0), lm);
        leaf.scale.setScalar(0.1 + R() * 0.06);
        leaf.rotation.set(0.1 + R() * 0.1, 0, nl === 1 ? (R() - 0.5) * 0.4 : (k ? 1 : -1) * (0.35 + R() * 0.25));
        holder.add(leaf);
      }
      holder.scale.setScalar(0.0001);
      this.group.add(holder);
      this.extras.push({ obj: holder, delay: 0.9, dur: 0.6 });
    }

    // Icicles: a few short ones hanging from the underside of strokes
    const bottoms = (d.edges || []).filter(e => e.n.y < -0.85);
    if (bottoms.length && R() < 0.4) {
      const im = meltWithGlyph(icicleMat.clone(), this.clipU, 'icicle');
      this.owned.mats.push(im);
      const spots = [];
      const nC = 1 + (R() < 0.45 ? 1 : 0);
      for (let t = 0; t < 30 && spots.length < nC; t++) {
        const e = bottoms[(R() * bottoms.length) | 0];
        if (spots.some(o => o.p.distanceTo(e.p) < 0.18)) continue;
        spots.push(e);
      }
      for (const e of spots) {
        const holder = new THREE.Group();
        holder.position.set(e.p.x, e.p.y + 0.008, (R() - 0.5) * DEPTH * 0.5);
        const nI = 1 + ((R() * 3) | 0);
        for (let k = 0; k < nI; k++) {
          const len = 0.035 + Math.pow(R(), 1.5) * 0.085, rad = len * (0.14 + R() * 0.05);
          const g = icicleGeometry(len, rad, R() * TAU);
          this.owned.geos.push(g);
          const m = new THREE.Mesh(g, im);
          const off = (k - (nI - 1) / 2) * 0.022 + (R() - 0.5) * 0.008;
          m.position.set(e.t.x * off, e.t.y * off, (R() - 0.5) * 0.02);
          holder.add(m);
          this.tips.push({ p: new THREE.Vector3(holder.position.x + m.position.x, holder.position.y - len, holder.position.z), n: new THREE.Vector3(-0.3, 0.2, 1).normalize(), t: 1.7, size: 6 });
        }
        holder.scale.set(1, 0.0001, 1);
        this.group.add(holder);
        // Icicles grow downward from the stroke
        this.extras.push({ obj: holder, delay: 1.0, dur: 0.8, grow: k => holder.scale.set(1, Math.max(0.0001, k), 1) });
      }
    }

    // Glint facets: bevel/front vertices with slightly perturbed normals
    const gp = d.iceGeo.attributes.position, gn = d.iceGeo.attributes.normal;
    this.facets = [];
    const nG = Math.min(d.cand.length, IS_MOBILE ? 40 : 70);
    for (let k = 0; k < nG; k++) {
      const i = d.cand[(R() * d.cand.length) | 0];
      const n = new THREE.Vector3(gn.getX(i), gn.getY(i), gn.getZ(i));
      n.x += (R() - 0.5) * 0.5; n.y += (R() - 0.5) * 0.5; n.z += (R() - 0.5) * 0.2;
      n.normalize();
      const r = R();
      this.facets.push({ p: new THREE.Vector3(gp.getX(i), gp.getY(i), gp.getZ(i)), n, size: 10 + r * r * r * 26, ph: R() * TAU, a: 0 });
    }

    this.state = 'freezing';
    sfx.freeze(panOf(this.tx || 0));
    this.t0 = now();
    layout(); // real advance width is known now
  }

  update(t, dt) {
    if (!this.ice) return;
    if (this.clipU) this.clipU.uGlyphInv.value.copy(this.group.matrixWorld).invert();
    const a = t - this.t0;
    if (this.state === 'freezing' || this.state === 'ice') {
      // Frost mist appears, outlines the glyph, then contracts inward and clears
      this.mistU.uA.value = smooth(0, 0.3, a) * (1 - smooth(0.6, 1.25, a));
      this.mist.scale.setScalar(1.07 - 0.1 * smooth(0.25, 1.15, a));
      this.outline.material.opacity = 0.9 * smooth(0, 0.22, a) * (1 - smooth(0.45, 1.0, a));
      if (a > 0.25) {
        this.ice.visible = true;
        const k = easeOutCubic((a - 0.25) / 0.85);
        this.ice.scale.set(0.96 + 0.04 * k, 0.96 + 0.04 * k, 0.04 + 0.96 * k);
        this.mat.roughness = lerp(0.55, 0.01, easeOutCubic((a - 0.35) / 1.1));
      }
      for (const f of this.flakes) {
        const k = (a - f.userData.delay) / 0.7;
        f.scale.setScalar(Math.max(0.0001, easeOutBack(k) * f.userData.size));
        f.rotation.z = f.userData.rz + (1 - easeOutCubic(k)) * f.userData.spin;
      }
      for (const x of this.extras || []) { const k = easeOutCubic((a - x.delay) / x.dur); x.grow ? x.grow(k) : x.obj.scale.setScalar(Math.max(0.0001, k)); }
      // Flowers swell in, then the petals open: outer layers first, each
      // petal a touch after the last; a bud only parts a little
      for (const fl of this.flowers) {
        const t0 = a - fl.userData.delay;
        fl.scale.setScalar(Math.max(0.0001, easeOutCubic(t0 / 0.5)));
        for (const p of fl.userData.petals) p.mesh.rotation.x = lerp(1.35, p.open, easeOutCubic((t0 - 0.1 - p.d) / 0.8));
      }
      this.glintK = smooth(0.7, 1.3, a);
      if (this.state === 'freezing' && a > 1.6) {
        this.state = 'ice';
        this.group.remove(this.mist, this.outline);
        this.mist.material.dispose();
        this.outline.material.dispose();
      }
    } else if (this.state === 'melting') {
      const b = t - this.m0;
      // The ice softens away from the top down, slowly; water gathers into
      // drops along the wet edge and falls
      const mx = sat(b / MELT_TIME);
      this.mat.userData.u.uMelt.value = 0.45 * mx + 0.55 * mx * mx * (3 - 2 * mx); // starts right away, still soft
      if (this.ghost) this.ghost.material.uniforms.uFade.value = 1 - smooth(MELT_TIME - 0.5, MELT_TIME + 0.2, b);
      this.glintK = 1 - smooth(0, 0.3, b);
      if (b > 0.2 && b < MELT_TIME - 0.2 && t - (this.lastDrop || 0) > 0.11) { this.lastDrop = t; this.spawnDrop(); }
      if (b > MELT_TIME + 0.25) this.dispose();
    }
  }

  // A point on the glyph near where the ice is wearing away right now
  meltFront() {
    const box = this.d.box, H = box.max.y - box.min.y;
    const thr = 1.02 - this.mat.userData.u.uMelt.value * 1.08;
    const hf = (thr - 0.14) / 0.72; // average height of the soft edge
    for (let k = 0; k < 14; k++) {
      const f = this.d.face[(Math.random() * this.d.face.length) | 0];
      if (f && Math.abs((f.y - box.min.y) / H - hf) < 0.12) return f;
    }
    return null;
  }

  spawnDrop() {
    // A drop forms on the ice where it is wearing away
    const p = this.meltFront();
    if (!p) return;
    _p.set(p.x, p.y - 0.01, (Math.random() - 0.3) * 0.12);
    this.group.localToWorld(_p);
    if (dropPool.items.length >= dropPool.max) return;
    dropPool.items.push({
      p: _p.clone(), v: new THREE.Vector3((Math.random() - 0.5) * 0.05, 0, 0),
      r: 0.014 + Math.random() * 0.016, hang: 0.35 + Math.random() * 0.5, age: 0, life: 2.6,
    });
  }

  melt() {
    if (!this.ice || this.state === 'loading' || this.state === 'empty') { this.dispose(); return; }
    if (this.mist && this.state === 'freezing') { this.mistU.uA.value = 0; this.outline.material.opacity = 0; }
    // Watery afterimage of the melting glyph
    const d = this.d, u = this.mat.userData.u;
    this.ghost = new THREE.Mesh(d.flatGeo, new THREE.ShaderMaterial({
      uniforms: {
        uMelt: u.uMelt, uSeed: u.uSeed, uBox: u.uBox, uSdf: u.uSdf, uSdfBox: u.uSdfBox,
        uZ: { value: FRONT_Z }, uFade: { value: 1 },
      },
      vertexShader: ghostVS, fragmentShader: ghostFS, transparent: true, depthWrite: false,
    }));
    this.ghost.position.z = FRONT_Z * 0.2;
    this.ghost.renderOrder = 4;
    this.group.add(this.ghost);
    // Flowers, twigs and feathers leave the same afterimage: they are one
    // piece with the glyph
    const gu = this.ghost.material.uniforms;
    this.decoGhostMat = new THREE.ShaderMaterial({
      uniforms: { uMelt: gu.uMelt, uSeed: gu.uSeed, uBox: gu.uBox, uFade: gu.uFade, uGlyphInv: this.clipU.uGlyphInv },
      vertexShader: decoGhostVS, fragmentShader: decoGhostFS,
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
    });
    const decoMeshes = [];
    for (const o of [...this.flowers, ...(this.extras || []).map(x => x.obj)]) o.traverse(m => { if (m.isMesh) decoMeshes.push(m); });
    for (const m of decoMeshes) { const g = new THREE.Mesh(m.geometry, this.decoGhostMat); g.renderOrder = 4; m.add(g); }
    this.state = 'melting';
    this.m0 = now();
  }

  shatter(quiet) {
    if (!this.ice || !this.ice.visible) { this.dispose(); return; }
    if (!quiet) sfx.shatter(panOf(this.group.position.x));
    this.group.updateMatrixWorld(true);
    // Flowers and snowflakes break with the glyph into small crystals
    for (const o of [...this.flowers, ...(this.extras || []).map(x => x.obj)]) {
      if (o.scale.x < 0.05) continue;
      const nc = 3 + ((Math.random() * 4) | 0);
      for (let k = 0; k < nc && shardPool.items.length < shardPool.max; k++) {
        const p = o.position.clone().add(new THREE.Vector3((Math.random() - 0.5) * 0.12, (Math.random() - 0.5) * 0.12, 0));
        this.group.localToWorld(p);
        const s = 0.007 + Math.random() * 0.014;
        shardPool.items.push({
          p, v: new THREE.Vector3((Math.random() - 0.5) * 0.6, 0.1 + Math.random() * 0.4, Math.random() * 0.4),
          q: new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.random() * TAU, Math.random() * TAU, Math.random() * TAU)),
          w: new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(5),
          s: new THREE.Vector3(s, s * (0.9 + Math.random() * 0.8), s * 0.5), g: 0.7, age: 0, life: 0.9 + Math.random() * 0.6,
        });
      }
    }
    const center = new THREE.Vector3(0, 0, 0);
    this.group.localToWorld(center);
    const n = IS_MOBILE ? 36 : 60;
    for (let k = 0; k < n && shardPool.items.length < shardPool.max; k++) {
      const f = this.d.face[(Math.random() * this.d.face.length) | 0];
      const p = new THREE.Vector3(f.x, f.y, (Math.random() - 0.5) * DEPTH * 1.4);
      this.group.localToWorld(p);
      // Ice crumbles rather than explodes: a few heavy chunks that mostly
      // drop, and lots of small crumbs that scatter a little further
      const s = 0.012 + Math.pow(Math.random(), 3) * 0.075;
      const heavy = smooth(0.02, 0.07, s);
      const v = p.clone().sub(center).multiplyScalar((0.55 + Math.random() * 0.7) * (1 - 0.5 * heavy));
      v.x += (Math.random() - 0.5) * 0.35;
      v.y += 0.1 + Math.random() * 0.45 * (1 - 0.6 * heavy);
      v.z += 0.1 + Math.random() * 0.5;
      shardPool.items.push({
        p, v,
        q: new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.random() * TAU, Math.random() * TAU, Math.random() * TAU)),
        w: new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(4 - 2 * heavy),
        s: new THREE.Vector3(s, s * (0.9 + Math.random() * 0.8), s * (0.45 + Math.random() * 0.35)),
        g: 0.8 + 0.5 * heavy,
        age: 0, life: 1.2 + Math.random() * 0.8 + heavy * 0.4,
      });
    }
    // A puff of powdered ice where it broke, hanging briefly before it settles
    const np = IS_MOBILE ? 110 : 180;
    for (let k = 0; k < np && powder.length < P_MAX; k++) {
      const f = this.d.face[(Math.random() * this.d.face.length) | 0];
      const p = new THREE.Vector3(f.x, f.y, FRONT_Z * Math.random());
      this.group.localToWorld(p);
      const v = p.clone().sub(center).multiplyScalar(0.25 + Math.random() * 0.5);
      v.x += (Math.random() - 0.5) * 0.3;
      v.y += (Math.random() - 0.3) * 0.3;
      v.z += Math.random() * 0.3;
      powder.push({ p, v, age: 0, life: 0.4 + Math.random() * 0.4, size: 4 + Math.random() * 9, a: 0.025 + Math.random() * 0.04 });
    }
    for (let k = 0; k < 14; k++) {
      const f = this.d.face[(Math.random() * this.d.face.length) | 0];
      const p = new THREE.Vector3(f.x, f.y, FRONT_Z);
      this.group.localToWorld(p);
      const v = p.clone().sub(center).multiplyScalar(0.8 + Math.random());
      v.y += 0.2 + Math.random() * 0.6; v.z += Math.random() * 0.6;
      v.multiplyScalar(0.6);
      bursts.push({ p, v, age: 0, life: 0.8 + Math.random() * 1.1, size: 8 + Math.random() * 16, ph: Math.random() * TAU });
    }
    this.dispose();
  }

  dispose() {
    this.state = 'gone';
    if (this.keepSlot) { this.keepSlot = false; layout(); } // now the neighbours close the gap
    root.remove(this.group);
    if (this.mat) this.mat.dispose();
    if (this.ghost) this.ghost.material.dispose();
    if (this.decoGhostMat) this.decoGhostMat.dispose();
    if (this.mist && this.mist.parent) { this.mist.material.dispose(); this.outline.material.dispose(); }
    // Decoration geometry / materials are this glyph's own; glyph geometry is cached
    for (const f of this.flakes) f.geometry.dispose();
    for (const g of this.owned.geos) g.dispose();
    for (const m of this.owned.mats) m.dispose();
  }

  // Append this character's glints to the buffer
  glint(t) {
    if (this.glintK <= 0.01 || !this.facets) return;
    const mw = this.ice.matrixWorld;
    _nm.getNormalMatrix(mw);
    // Sparkles ease toward their target instead of switching on and off
    // frame by frame, so swaying letters glitter rather than flicker
    const ease = 1 - Math.exp(-Math.min(0.1, t - (this.lastGlintT || t)) * 12);
    this.lastGlintT = t;
    for (const f of this.facets) {
      _p.copy(f.p).applyMatrix4(mw);
      _n.copy(f.n).applyMatrix3(_nm).normalize();
      f.a += (glintAt(_p, _n, t, f.ph) - f.a) * ease;
      pushGlint(_p, f.a * this.glintK, f.size);
    }
    if (this.tips && this.tips.length) {
      const age = now() - this.t0, mw = this.group.matrixWorld;
      _nm.getNormalMatrix(mw);
      let k = 0;
      for (const tp of this.tips) {
        k++;
        if (age < tp.t) continue;
        _p.copy(tp.p).applyMatrix4(mw);
        if (tp.steady) { pushGlint(_p, this.glintK * (0.42 + 0.08 * Math.sin(t * 1.7 + k)), tp.size); continue; }
        _n.copy(tp.n).applyMatrix3(_nm).normalize();
        tp.a = (tp.a || 0) + (glintAt(_p, _n, t, k * 2.1) - (tp.a || 0)) * ease;
        pushGlint(_p, tp.a * this.glintK, tp.size);
      }
    }
    for (const fk of this.flakes) {
      if (fk.scale.x < 0.05) continue;
      _nm.getNormalMatrix(fk.matrixWorld);
      _n.copy(fk.userData.nrm).applyMatrix3(_nm).normalize();
      let k = 0;
      for (const tip of fk.userData.tips) {
        _p.copy(tip).applyMatrix4(fk.matrixWorld);
        pushGlint(_p, glintAt(_p, _n, t, k++ * 1.7) * this.glintK, 10 + fk.userData.size * 40);
      }
    }
  }
}

// -----------------------------------------------------------------------------
// Layout & camera framing
// -----------------------------------------------------------------------------
const LINE_H = 1.32;
let contentW = 3, contentH = 1.6;

// A melting character keeps its place in the layout until it has fully
// melted, so its neighbours stay put and only close the gap afterwards
function holdSlot(c, prev) { c.keepSlot = true; c.slotPrev = prev; }
function layoutSequence() {
  const seq = active.slice();
  let pending = dying.filter(c => c.keepSlot && c.state === 'melting');
  for (let guard = 0; pending.length && guard < 50; guard++) {
    const rest = [];
    for (const c of pending) {
      const j = c.slotPrev ? seq.indexOf(c.slotPrev) : -1;
      if (c.slotPrev && j < 0) rest.push(c);
      else seq.splice(j + 1, 0, c);
    }
    if (rest.length === pending.length) { seq.push(...rest); break; }
    pending = rest;
  }
  return seq;
}

function layout() {
  const aspect = innerWidth / innerHeight;
  const maxW = clamp(aspect * 5.4, 3.4, 14);
  // Latin words stay together; Chinese characters and spaces can break anywhere
  const units = [];
  const isWordChar = c => !c.space && /[A-Za-z0-9'’\-.,!?;:]/.test(c.ch);
  for (const c of layoutSequence()) {
    const last = units[units.length - 1];
    if (c.br) units.push({ chars: [c], br: true });
    else if (last && isWordChar(c) && last.word) last.chars.push(c);
    else units.push({ chars: [c], word: isWordChar(c) });
  }
  const lines = [[]];
  let lw = 0;
  const place = c => {
    if (lw + c.adv > maxW && lines[lines.length - 1].length) { lines.push([]); lw = 0; }
    lines[lines.length - 1].push(c);
    lw += c.adv;
  };
  for (const u of units) {
    // Enter: the rest goes on a new line (the break itself takes no room)
    if (u.br) { u.chars[0].tx = undefined; lines.push([]); lw = 0; continue; }
    const uw = u.chars.reduce((s, c) => s + c.adv, 0);
    if (u.word && uw <= maxW && lw + uw > maxW && lines[lines.length - 1].length) { lines.push([]); lw = 0; }
    u.chars.forEach(place);
  }
  // A space left at the start or end of a line takes no room
  lines.forEach((L, li) => {
    // (keep a trailing space on the last line: it is where the next word goes)
    while (li < lines.length - 1 && L.length > 1 && L[L.length - 1].space) L.pop().tx = undefined;
    while (L.length > 1 && L[0].space) L.shift().tx = undefined;
  });
  const widths = lines.map(L => L.reduce((s, c) => s + c.adv, 0));
  const y0 = ((lines.length - 1) * LINE_H) / 2;
  lines.forEach((L, li) => {
    let x = -widths[li] / 2;
    for (const c of L) {
      c.tx = x + c.adv / 2;
      c.ty = y0 - li * LINE_H;
      x += c.adv;
    }
  });
  contentW = Math.max(3.2, ...widths);
  contentH = Math.max(1.7, lines.length * LINE_H);
}

function frameCamera(dt) {
  const tanH = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  const dH = (contentH * 1.35) / 2 / tanH;
  const dW = (contentW * 1.25) / 2 / (tanH * camera.aspect);
  const target = Math.max(dH, dW, 5);
  camera.position.z = lerp(camera.position.z, target, Math.min(1, dt * 2.5));
  // Fit the background plane to the view
  const dist = camera.position.z - BG_Z;
  const h = 2 * tanH * dist * 1.12;
  bgMesh.scale.set(h * camera.aspect, h, 1);
  // The window stays still; only the letters turn with the mouse or tilt
  bgMesh.position.x = camera.position.x;
  bgMesh.position.y = camera.position.y;
}

// -----------------------------------------------------------------------------
// Text input
// -----------------------------------------------------------------------------
const ime = document.getElementById('ime');
let typed = [];
let composing = false;

function addChar(ch) {
  const c = new IceChar(ch);
  active.push(c);
  layout();
  c.group.position.set(c.tx, c.ty, 0);
  c.placed = true;
  if (c.space && !c.br && c.tx !== undefined) spawnFaller(c);
}

function removeLast() {
  const c = active.pop();
  if (!c) return;
  if (c.space) { c.dispose(); return; }
  holdSlot(c, active[active.length - 1] || null);
  c.melt();
  if (c.state !== 'gone') dying.push(c);
  layout();
}

// Characters that arrive together (an IME commits a whole phrase at once)
// still freeze one after another: they wait here and enter on a short beat.
// `typed` is the full text; the waiting ones are always at its end.
// The beat is counted from when the previous character actually starts to
// freeze (its glyph may still be downloading), so the rhythm stays even.
const pending = [];
const CHAR_BEAT = 0.22; // seconds between characters of one burst
let lastAdd = -1, lastChar = null;
function canAddNext(t) {
  if (lastChar && !lastChar.space && lastChar.state === 'loading') return false; // previous not visible yet
  const since = lastChar && lastChar.state !== 'empty' && lastChar.ice ? t - lastChar.t0 : t - lastAdd;
  return since >= CHAR_BEAT;
}
function releaseNext(t) {
  lastAdd = t;
  addChar(pending.shift());
  lastChar = active[active.length - 1];
}
function updatePending(t) {
  if (pending.length && canAddNext(t)) releaseNext(t);
}

function syncInput() {
  const next = [...ime.value];
  let p = 0;
  while (p < typed.length && p < next.length && typed[p] === next[p]) p++;
  // Remove from the end: still-waiting characters first, then visible ones
  for (let i = typed.length - 1; i >= p; i--) { if (pending.length) pending.pop(); else removeLast(); }
  for (let i = p; i < next.length; i++) {
    pending.push(next[i]);
    if (next[i] !== ' ' && next[i] !== '\n') getGlyphData(next[i]); // start fetching its glyph now
  }
  typed = next;
  // The first of a burst appears right away
  const t = now();
  if (pending.length && canAddNext(t)) releaseNext(t);
}

function shatterAll() {
  // One big break for the whole line rather than a pile of overlapping ones
  if (active.some(c => !c.space)) sfx.shatter(0, true);
  for (const c of active) {
    if (c.space) c.dispose();
    else c.shatter(true);
  }
  active.length = 0;
  pending.length = 0;
  ime.value = '';
  typed = [];
  layout();
}

ime.addEventListener('compositionstart', () => { composing = true; });
ime.addEventListener('compositionend', () => { composing = false; syncInput(); });
ime.addEventListener('input', e => { if (!composing && !e.isComposing) syncInput(); });
ime.addEventListener('keydown', e => {
  // Enter is just Enter: the text field takes it as a line break
  // Keep the caret at the end: edits only ever happen to the last character
  if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) e.preventDefault();
});
ime.addEventListener('blur', () => { if (!IS_MOBILE) setTimeout(() => ime.focus({ preventScroll: true }), 0); });

function focusInput() {
  ime.focus({ preventScroll: true });
  const n = ime.value.length;
  try { ime.setSelectionRange(n, n); } catch {}
}
// -----------------------------------------------------------------------------
// Gestures on the letters: tap one to shatter it, hold one to melt it.
// Tapping empty space brings up the keyboard as before.
// -----------------------------------------------------------------------------
const HOLD_TIME = 0.3; // long enough not to be a tap, short enough to feel immediate
const press = { id: null, x: 0, y: 0, c: null, t0: 0, tap: false };
// Double tap anywhere shatters everything. The first tap still acts at once
// (breaking the letter under it), so single taps never feel delayed.
const DOUBLE_TAP = 0.32, DOUBLE_DIST = IS_MOBILE ? 48 : 32;
let lastTap = { t: -1, x: 0, y: 0 };

// The character under a screen point: its glyph box projected to the screen,
// with some slack, so thin brush strokes are still easy to hit
function charAt(x, y) {
  let best = null, bestD = Infinity;
  const slack = IS_MOBILE ? 14 : 8;
  for (const c of active) {
    if (!c.ice || !c.ice.visible || c.state === 'melting') continue;
    const b = c.d.box;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [bx, by] of [[b.min.x, b.min.y], [b.max.x, b.min.y], [b.min.x, b.max.y], [b.max.x, b.max.y]]) {
      _p.set(bx, by, 0);
      c.group.localToWorld(_p).project(camera);
      const sx = (_p.x + 1) / 2 * innerWidth, sy = (1 - _p.y) / 2 * innerHeight;
      x0 = Math.min(x0, sx); x1 = Math.max(x1, sx); y0 = Math.min(y0, sy); y1 = Math.max(y1, sy);
    }
    if (x < x0 - slack || x > x1 + slack || y < y0 - slack || y > y1 + slack) continue;
    const d = Math.hypot(x - (x0 + x1) / 2, y - (y0 + y1) / 2);
    if (d < bestD) { bestD = d; best = c; }
  }
  return best;
}

// Takes one character out of the text, wherever it is, and keeps the hidden
// input in step so typing continues from the remaining text
function removeChar(c, how) {
  const i = active.indexOf(c);
  if (i < 0 || composing) return;
  const prev = i > 0 ? active[i - 1] : null;
  active.splice(i, 1);
  typed.splice(i, 1);
  ime.value = typed.join('');
  if (how === 'shatter') c.shatter();
  else { holdSlot(c, prev); c.melt(); if (c.state !== 'gone') dying.push(c); }
  layout();
}

glCanvas.addEventListener('pointerdown', e => {
  requestMotion();
  const c = charAt(e.clientX, e.clientY);
  Object.assign(press, { id: e.pointerId, x: e.clientX, y: e.clientY, c, t0: now(), tap: true, wiping: false, lx: e.clientX, ly: e.clientY, empty: !c });
  if (!c && !IS_MOBILE) focusInput(); // on phones, wait: a drag wipes instead of raising the keyboard
});
addEventListener('pointermove', e => {
  if (e.pointerId !== press.id) return;
  // Sliding away cancels the tap or hold
  if (Math.hypot(e.clientX - press.x, e.clientY - press.y) > 14) {
    press.c = null; press.tap = false;
    // A drag that began on empty glass wipes the frost away
    if (press.empty) press.wiping = true;
  }
  if (press.wiping) {
    wipeStroke(press.lx, press.ly, e.clientX, e.clientY);
    const t = now(), dtm = Math.max(0.008, t - (press.lt || t - 0.016));
    sfx.wipe(Math.hypot(e.clientX - press.lx, e.clientY - press.ly) / dtm, (e.clientX / innerWidth - 0.5) * 1.4);
    press.lx = e.clientX; press.ly = e.clientY; press.lt = t;
  }
});
glCanvas.addEventListener('pointerup', e => {
  if (e.pointerId !== press.id) return;
  const c = press.c, t = now();
  const isTap = press.tap && t - press.t0 < HOLD_TIME;
  if (press.wiping) sfx.wipeEnd();
  if (press.empty && !press.wiping && IS_MOBILE) focusInput(); // a plain tap on the glass
  press.id = null; press.c = null; press.tap = false;
  if (!isTap) { lastTap.t = -1; return; }
  if (lastTap.t > 0 && t - lastTap.t < DOUBLE_TAP && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < DOUBLE_DIST) {
    lastTap.t = -1;
    if (!composing) shatterAll();
    return;
  }
  lastTap = { t, x: e.clientX, y: e.clientY };
  if (c && active.includes(c)) removeChar(c, 'shatter');
});
glCanvas.addEventListener('dblclick', e => e.preventDefault());
// iOS Safari ignores user-scalable=no for gestures; stop pinch / double-tap zoom here too
for (const ev of ['gesturestart', 'gesturechange']) document.addEventListener(ev, e => e.preventDefault(), { passive: false });
addEventListener('pointerup', () => sfx.wipeEnd()); // released anywhere: the rubbing stops
glCanvas.addEventListener('pointercancel', () => { if (press.wiping) sfx.wipeEnd(); press.id = null; press.c = null; press.wiping = false; });
glCanvas.addEventListener('contextmenu', e => e.preventDefault()); // no long-press menu

// Holding: once held long enough, the character melts (no shiver first)
function updatePress(t) {
  if (press.id === null || !press.c) return;
  const k = (t - press.t0) / HOLD_TIME;
  if (k >= 1) { const c = press.c; press.c = null; press.tap = false; removeChar(c, 'melt'); }
}
addEventListener('keydown', e => { if (document.activeElement !== ime && !e.metaKey && !e.ctrlKey) focusInput(); });

// A small snowflake drifting down through a typed space
function spawnFaller(c) {
  const R = mulberry32((Math.random() * 1e9) | 0);
  const f = makeFlake(R, 0.13 + R() * 0.07);
  f.scale.setScalar(f.userData.size);
  f.rotation.set(R() * 0.6, R() * 0.6, R() * TAU);
  scene.add(f);
  fallers.push({ f, c, age: 0, life: 3.2, x0: c.tx, y0: c.ty + 0.85, ph: R() * TAU });
}

// -----------------------------------------------------------------------------
// Tilt: mouse or device orientation turns the text slightly
// -----------------------------------------------------------------------------
let tiltX = 0, tiltY = 0, tiltTX = 0, tiltTY = 0;
addEventListener('pointermove', e => {
  if (e.pointerType !== 'mouse') return;
  tiltTX = clamp((e.clientX / innerWidth - 0.5) * 2, -1, 1);
  tiltTY = clamp((e.clientY / innerHeight - 0.5) * 2, -1, 1);
});
let motionAsked = false, beta0 = null;
function requestMotion() {
  if (motionAsked) return;
  motionAsked = true;
  const D = window.DeviceOrientationEvent;
  if (D && typeof D.requestPermission === 'function') D.requestPermission().catch(() => {});
}
addEventListener('deviceorientation', e => {
  if (e.beta == null) return;
  if (beta0 === null) beta0 = e.beta;
  beta0 += (e.beta - beta0) * 0.003; // slowly re-center on how the phone is held
  tiltTX = clamp((e.gamma || 0) / 25, -1, 1);
  tiltTY = clamp((e.beta - beta0) / 25, -1, 1);
});

// -----------------------------------------------------------------------------
// Export: PNG
// -----------------------------------------------------------------------------
const fileName = ext => `iced-letters-${(typed.join('').replace(/\s+/g, ' ').trim() || 'ice').slice(0, 12)}.${ext}`;

// Keyboard button: brings up the keyboard (on a phone, tap again to put it away)
const kbdBtn = document.getElementById('kbd');
kbdBtn.addEventListener('pointerdown', e => e.preventDefault()); // keep the input's focus as it is
kbdBtn.addEventListener('click', () => {
  if (IS_MOBILE && document.activeElement === ime) ime.blur();
  else focusInput();
});

const pngBtn = document.getElementById('png');
const IS_IOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

// Encodes the canvas synchronously, so the share sheet can still open inside
// the tap (iOS refuses navigator.share once the tap's activation has passed)
function snapshotFile() {
  composer.render(); // the drawing buffer is valid until we yield
  const url = glCanvas.toDataURL('image/png');
  const bin = atob(url.slice(url.indexOf(',') + 1));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new File([bytes], fileName('png'), { type: 'image/png' });
}

// Keep the phone keyboard open when tapping the button
pngBtn.addEventListener('pointerdown', e => e.preventDefault());
// One tap saves. iPhone: no web page may write to Photos directly, so the
// system share sheet opens at once ("Save Image"). Everywhere else the
// picture is downloaded straight away (on Android it lands in the gallery).
pngBtn.addEventListener('click', async () => {
  const file = snapshotFile();
  if (IS_IOS && navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file] }); return; } catch (err) { if (err && err.name === 'AbortError') return; }
  }
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url; a.download = file.name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
});

// -----------------------------------------------------------------------------
// Frame loop
// -----------------------------------------------------------------------------
const GRAV = -3.2;
let lastT = now();

function updateParticles(t, dt) {
  // Shards: tumble, fall, shrink away; glint as they turn
  let n = 0;
  const sp = shardPool;
  for (let i = sp.items.length - 1; i >= 0; i--) {
    const s = sp.items[i];
    s.age += dt;
    if (s.age > s.life) { sp.items.splice(i, 1); continue; }
    s.v.y += GRAV * dt * (s.g || 0.6);
    s.v.multiplyScalar(1 - dt * 0.5);
    s.p.addScaledVector(s.v, dt);
    _v.copy(s.w).multiplyScalar(dt);
    s.q.multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(_v.x, _v.y, _v.z)));
  }
  for (const s of sp.items) {
    const k = 1 - smooth(s.life * 0.55, s.life, s.age);
    _o.position.copy(s.p);
    _o.quaternion.copy(s.q);
    _o.scale.copy(s.s).multiplyScalar(Math.max(k, 0.0001));
    _o.updateMatrix();
    sp.mesh.setMatrixAt(n++, _o.matrix);
    _n.set(0, 0, 1).applyQuaternion(s.q);
    pushGlint(s.p, glintAt(s.p, _n, t, s.life * 10) * k * 0.5, 8 + s.s.x * 110);
  }
  sp.mesh.count = n;
  sp.mesh.visible = n > 0;
  sp.mesh.instanceMatrix.needsUpdate = true;

  // Water drops: swell while hanging, then fall
  n = 0;
  const dp = dropPool;
  for (let i = dp.items.length - 1; i >= 0; i--) {
    const d = dp.items[i];
    d.age += dt;
    if (d.age > d.hang) {
      if (!d.fell) { d.fell = true; if (Math.random() < 0.95) sfx.drip(panOf(d.p.x)); } // the drip sound as it lets go
      d.v.y += GRAV * dt; d.p.addScaledVector(d.v, dt);
    }
    if (d.age > d.life || d.p.y < camera.position.y - camera.position.z * 0.6) dp.items.splice(i, 1);
  }
  for (const d of dp.items) {
    const grow = smooth(0, d.hang, d.age), fade = 1 - smooth(d.life * 0.6, d.life, d.age);
    const stretch = 1 + Math.min(1.2, Math.abs(d.v.y) * 0.25);
    _o.position.copy(d.p);
    _o.quaternion.identity();
    _o.scale.set(d.r * grow * fade, d.r * grow * fade * stretch, d.r * grow * fade);
    _o.updateMatrix();
    dp.mesh.setMatrixAt(n++, _o.matrix);
  }
  dp.mesh.count = n;
  dp.mesh.visible = n > 0;
  dp.mesh.instanceMatrix.needsUpdate = true;

  // Sparkling motes from shattering
  for (let i = bursts.length - 1; i >= 0; i--) {
    const b = bursts[i];
    b.age += dt;
    if (b.age > b.life) { bursts.splice(i, 1); continue; }
    b.v.y += GRAV * dt * 0.25;
    b.v.multiplyScalar(1 - dt * 1.2);
    b.p.addScaledVector(b.v, dt);
    const tw = Math.pow(0.5 + 0.5 * Math.sin(b.age * 18 + b.ph), 3);
    pushGlint(b.p, tw * (1 - b.age / b.life), b.size);
  }

  // Ice powder: drifts out, slows in the air, sinks and thins away
  let pn = 0;
  for (let i = powder.length - 1; i >= 0; i--) {
    const d = powder[i];
    d.age += dt;
    if (d.age > d.life) { powder.splice(i, 1); continue; }
    d.v.multiplyScalar(1 - dt * 2.2);
    d.v.y += GRAV * dt * 0.05;
    d.p.addScaledVector(d.v, dt);
  }
  for (const d of powder) {
    const k = smooth(0, 0.12, d.age) * (1 - smooth(d.life * 0.35, d.life, d.age));
    pwPos[pn * 3] = d.p.x; pwPos[pn * 3 + 1] = d.p.y; pwPos[pn * 3 + 2] = d.p.z;
    pwAlpha[pn] = d.a * k;
    pwSize[pn] = d.size * (1 + 0.6 * d.age / d.life);
    pn++;
  }
  pwGeo.setDrawRange(0, pn);
  pwGeo.attributes.position.needsUpdate = true;
  pwGeo.attributes.aAlpha.needsUpdate = true;
  pwGeo.attributes.aSize.needsUpdate = true;

  // Diamond dust: now and then a fine ice crystal in the air catches the light
  if (Math.random() < dt * 2.5) {
    dust.push({
      p: new THREE.Vector3((Math.random() - 0.5) * contentW * 1.8, (Math.random() - 0.5) * (contentH + 2.2), (Math.random() - 0.4) * 3),
      v: new THREE.Vector3(0.04 + Math.random() * 0.07, -0.03 - Math.random() * 0.05, 0),
      age: 0, life: 1.2 + Math.random() * 1.8, size: 5 + Math.random() * 10, ph: Math.random() * TAU,
    });
  }
  for (let i = dust.length - 1; i >= 0; i--) {
    const d = dust[i];
    d.age += dt;
    if (d.age > d.life) { dust.splice(i, 1); continue; }
    d.p.addScaledVector(d.v, dt);
    const k = Math.sin((Math.PI * d.age) / d.life);
    pushGlint(d.p, k * k * (0.55 + 0.45 * Math.sin(d.age * 9 + d.ph)), d.size);
  }

  // Snowflakes drifting through spaces
  for (let i = fallers.length - 1; i >= 0; i--) {
    const f = fallers[i];
    f.age += dt;
    const k = f.age / f.life;
    if (k >= 1) { scene.remove(f.f); f.f.geometry.dispose(); fallers.splice(i, 1); continue; }
    _p.set(f.x0 + Math.sin(f.age * 1.6 + f.ph) * 0.08, f.y0 - f.age * 0.62, 0.15);
    root.localToWorld(_p);
    f.f.position.copy(_p);
    f.f.rotation.z += dt * 0.6;
    f.f.rotation.x = Math.sin(f.age * 1.3 + f.ph) * 0.5;
    const s = f.f.userData.size * smooth(0, 0.25, f.age) * (1 - smooth(0.7, 1, k));
    f.f.scale.setScalar(Math.max(0.0001, s));
    f.f.updateMatrixWorld();
    _n.set(0, 0, 1).applyQuaternion(f.f.quaternion);
    pushGlint(_p, glintAt(_p, _n, t, f.ph) * (s / f.f.userData.size), 16);
  }
}

// -----------------------------------------------------------------------------
// Frame pacing. Drawing this scene flat out keeps the GPU busy and a phone
// warm, so it only runs at full rate while something is happening (typing,
// touching, freezing, melting, shattering, wiping). At rest, with letters
// on the glass, 30 frames a second is plenty for the gentle sway and the
// glitter; an empty window needs even less. And if full-rate frames keep
// coming late, the resolution steps down a notch.
// -----------------------------------------------------------------------------
let lastPoke = 0, pointersDown = 0, lastRender = 0;
const poke = () => { lastPoke = now(); };
for (const ev of ['keydown', 'input', 'pointermove', 'wheel']) addEventListener(ev, poke, true);
addEventListener('pointerdown', () => { pointersDown++; poke(); }, true);
for (const ev of ['pointerup', 'pointercancel']) addEventListener(ev, () => { pointersDown = Math.max(0, pointersDown - 1); poke(); }, true);
function isBusy(t) {
  return t - lastPoke < 2 || pointersDown > 0 || pending.length > 0 || dying.length > 0
    || shardPool.items.length > 0 || dropPool.items.length > 0 || powder.length > 0 || bursts.length > 0 || fallers.length > 0
    || wipe.active > 0 || active.some(c => c.state !== 'ice' && c.state !== 'empty');
}
function setPixelRatio(p) {
  PR = p;
  renderer.setPixelRatio(p);
  composer.setPixelRatio(p);
  renderer.setSize(innerWidth, innerHeight);
  composer.setSize(innerWidth, innerHeight);
  dropMat.uniforms.uRes.value.set(innerWidth * p, innerHeight * p);
  gMat.uniforms.uPR.value = p;
  powderMat.uniforms.uPR.value = p;
}
const slow = { n: 0, late: 0, since: 0 };
function pacing(t, busy) {
  // Only judge frames drawn at full rate, in a visible tab
  if (!busy || document.hidden) { slow.n = slow.late = 0; slow.since = t; return; }
  const gap = t - lastRender;
  if (gap > 0.25) return; // a pause, not a slow frame
  slow.n++;
  if (gap > 0.026) slow.late++; // under ~40 frames a second
  if (t - slow.since > 2.5) {
    if (slow.n > 20 && slow.late > slow.n * 0.6 && PR > 1) setPixelRatio(Math.max(1, PR - 0.25));
    slow.n = slow.late = 0; slow.since = t;
  }
}

function frame() {
  const t0 = now(), busy = isBusy(t0);
  const minGap = busy ? 0 : active.length ? 1 / 30 : 1 / 20;
  if (t0 - lastRender < minGap - 0.004) { requestAnimationFrame(frame); return; }
  pacing(t0, busy);
  lastRender = t0;
  const t = t0, dt = Math.min(0.05, t - lastT);
  lastT = t;

  const kk = Math.min(1, dt * 3);
  tiltX += (tiltTX - tiltX) * kk;
  tiltY += (tiltTY - tiltY) * kk;
  // Slight turn toward the viewpoint, plus an idle sway so highlights keep moving
  root.rotation.y = tiltX * 0.32 + Math.sin(t * 0.31) * 0.06;
  root.rotation.x = tiltY * 0.2 + Math.sin(t * 0.23 + 1) * 0.035;
  warmLight.position.x = 3.4 + Math.sin(t * 0.17) * 0.8;

  for (const c of active) {
    if (c.tx === undefined) continue;
    c.group.position.x = lerp(c.group.position.x, c.tx, Math.min(1, dt * 6));
    c.group.position.y = lerp(c.group.position.y, c.ty, Math.min(1, dt * 6));
    c.group.rotation.y = Math.sin(t * 0.5 + c.tx * 1.7) * 0.04;
  }
  updatePress(t);
  for (let i = dying.length - 1; i >= 0; i--) if (dying[i].state === 'gone') dying.splice(i, 1);
  frameCamera(dt);
  scene.updateMatrixWorld();

  gN = 0;
  for (const c of active) c.update(t, dt);
  for (const c of dying) c.update(t, dt);
  for (const c of active) c.glint(t);
  for (const c of dying) c.glint(t);
  updateParticles(t, dt);
  updateWipe(dt);
  updatePending(t);
  gGeo.setDrawRange(0, gN);
  gGeo.attributes.position.needsUpdate = true;
  gGeo.attributes.aAlpha.needsUpdate = true;
  gGeo.attributes.aSize.needsUpdate = true;

  composer.render();
  requestAnimationFrame(frame);
}

// -----------------------------------------------------------------------------
// Shader warm-up. The ice, flowers, leaves, shards and drops use heavy shaders
// that take a few seconds to compile the first time. Compile them all in the
// background (in parallel where the browser can), so the first letter typed
// doesn't freeze the page. The materials are kept, so the programs stay cached.
// -----------------------------------------------------------------------------
const warm = new THREE.Group();
function warmShaders() {
  const geo = new THREE.BoxGeometry(0.01, 0.01, 0.01);
  const clipU = {
    uGlyphInv: { value: new THREE.Matrix4() }, uMelt: { value: 0 }, uSeed: { value: 0 }, uBox: { value: new THREE.Vector4() },
  };
  const box = { min: new THREE.Vector2(0, 0), max: new THREE.Vector2(1, 1) };
  const flower = (key, root) => meltWithGlyph(new THREE.MeshPhysicalMaterial({
    color: 0xeaf5ff, map: VEIN_TEX[0], roughness: 0.14, transmission: 0.82, thickness: 0.04, ior: 1.31,
    emissive: 0xffffff, emissiveMap: rootGlowTex, emissiveIntensity: 0.9, envMapIntensity: 2.2, side: THREE.DoubleSide,
  }), clipU, key, { root });
  const makers = [
    () => makeGlyphMaterial({ box, sdf: flawTex.rough, sdfBox: box }),
    () => flower('classic', null), () => flower('classic', [1, 1, 1]), () => flower('petal', [1, 1, 1]),
    () => meltWithGlyph(new THREE.MeshBasicMaterial(), clipU, 'basic'),
    () => meltWithGlyph(flakeMat.clone(), clipU, 'flake'),
    () => meltWithGlyph(leafMat.clone(), clipU, 'leaf'),
    () => meltWithGlyph(icicleMat.clone(), clipU, 'icicle'),
    () => meltWithGlyph(twigMat.clone(), clipU, 'twig'),
    () => meltWithGlyph(featherMat.clone(), clipU, 'feather'),
  ];
  for (const make of makers) {
    const m = make();
    warm.add(new THREE.Mesh(geo, m));
    // A clear double-sided piece is also drawn back face first, as its own shader
    if (m.side === THREE.DoubleSide && m.transmission > 0) {
      const back = make();
      back.side = THREE.BackSide;
      warm.add(new THREE.Mesh(geo, back));
    }
  }
  for (const p of [shardPool, dropPool]) warm.add(new THREE.InstancedMesh(p.mesh.geometry, p.mesh.material, 1));
  // Compile for the same target the scene is drawn into (the composer's buffer)
  const prev = renderer.getRenderTarget();
  renderer.setRenderTarget(composer.readBuffer);
  const done = renderer.compileAsync(warm, camera, scene).catch(() => {});
  renderer.setRenderTarget(prev);
  return done;
}

// -----------------------------------------------------------------------------
// Resize & boot
// -----------------------------------------------------------------------------
let resizeTimer = 0;
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  composer.setSize(innerWidth, innerHeight);
  layout();
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(buildBackground, 200);
});

buildBackground();
layout();

// Tips card: shown when the page opens, gone at the first touch, click or
// key; the help button (bottom left) brings it back, or closes it again
const hintEl = document.getElementById('hint');
if (hintEl) {
  let firstClose = true;
  const shown = () => hintEl.classList.contains('show');
  const showHint = () => hintEl.classList.add('show');
  const hideHint = () => {
    hintEl.dataset.seen = '1'; // also cancels the opening if it's still waiting for the font
    if (!shown()) return;
    hintEl.classList.remove('show');
    // The first close starts the session: ready to type (and, on a phone,
    // the tap brings up the keyboard). Later closes leave the keyboard alone.
    if (firstClose) { firstClose = false; focusInput(); }
  };
  // The window comes up first; the card fades in just after, once its title
  // font is in (index.html starts loading it), unless typing has begun
  requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(() => {
    (window.hintFont || Promise.resolve()).then(() => { if (!hintEl.dataset.seen) showHint(); });
  }, 250)));
  hintEl.addEventListener('pointerdown', e => { e.preventDefault(); hideHint(); });
  addEventListener('keydown', hideHint);
  const helpBtn = document.getElementById('help');
  helpBtn.addEventListener('pointerdown', e => e.preventDefault()); // keep the input's focus as it is
  helpBtn.addEventListener('click', () => { if (shown()) hideHint(); else { firstClose = false; showHint(); } });
}
loadSlices(FONTS.cjk); loadSlices(FONTS.latin); // warm up the font indexes
if (!IS_MOBILE) focusInput();
requestAnimationFrame(frame);
// Right after the first frame: the reflections, then the ice shaders, while
// the tips card is still up
setTimeout(() => {
  scene.environment = buildEnvironment();
  warmShaders();
}, 120);
