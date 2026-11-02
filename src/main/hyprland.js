'use strict';

// Talking to Hyprland (Linux) over its own sockets: no process started for each question, so she can
// ask where the pointer is many times a second for next to nothing. And a picture of the screen with
// grim, because Electron's own capture has to go through a permission dialog on Wayland.

const net = require('node:net');
const path = require('node:path');
const { execFile } = require('node:child_process');

const DIR = process.platform === 'linux' && process.env.HYPRLAND_INSTANCE_SIGNATURE && process.env.XDG_RUNTIME_DIR
  ? path.join(process.env.XDG_RUNTIME_DIR, 'hypr', process.env.HYPRLAND_INSTANCE_SIGNATURE)
  : null;
const available = Boolean(DIR);

// One request: Hyprland answers, then hangs up.
function ask(request, timeout = 1500) {
  return new Promise((resolve, reject) => {
    if (!DIR) return reject(new Error('not on Hyprland'));
    const chunks = [];
    const socket = net.connect(path.join(DIR, '.socket.sock'));
    socket.setTimeout(timeout, () => socket.destroy(new Error('Hyprland did not answer')));
    socket.on('connect', () => socket.write(request));
    socket.on('data', (d) => chunks.push(d));
    socket.on('error', reject);
    socket.on('close', () => resolve(Buffer.concat(chunks).toString('utf8')));
    return undefined;
  });
}

const json = async (what) => JSON.parse(await ask(`j/${what}`));

// A dispatcher, in the Lua form of this config: `ok` back, or why not.
async function dispatch(lua) {
  const out = (await ask(`/dispatch ${lua}`)).trim();
  if (out !== 'ok') throw new Error(out || 'no answer');
}

const cursor = () => json('cursorpos'); // { x, y }, in layout coordinates like Electron's
const moveCursor = (x, y) => dispatch(`hl.dsp.cursor.move({ x = ${Math.round(x)}, y = ${Math.round(y)} })`);

// Her window takes the keyboard only while the pointer is on her.
const setFocusable = (on) => dispatch(
  `hl.dsp.window.set_prop({ prop = "no_focus", value = "${on ? 0 : 1}", window = "class:capri-desktop" })`,
);

// With her chat open she has the focus, so a toggle-float key lands on her: tiled she'd sit under
// your windows, and it takes her pin with it. Back over the whole of that screen, floating and pinned.
async function restoreOverlay({ x, y, width, height }) {
  const win = 'window = "class:capri-desktop"';
  await dispatch(`hl.dsp.window.float({ action = "enable", ${win} })`);
  await dispatch(`hl.dsp.window.pin({ action = "enable", ${win} })`);
  await dispatch(`hl.dsp.window.resize({ x = ${width}, y = ${height}, ${win} })`);
  await dispatch(`hl.dsp.window.move({ x = ${x}, y = ${y}, ${win} })`);
}

// Wayland doesn't let a window take the keyboard: Hyprland hands it over for her chat, and it goes
// back to the window you were in once it closes.
let before = null;
async function takeKeyboard() {
  const active = await json('activewindow').catch(() => null);
  before = active?.class && active.class !== 'capri-desktop' ? active.address : null;
  await setFocusable(true);
  await dispatch('hl.dsp.focus({ window = "class:capri-desktop" })');
}
async function giveKeyboardBack() {
  await setFocusable(false);
  if (before) await dispatch(`hl.dsp.focus({ window = "address:${before}" })`);
  before = null;
}

const closeWindow = (address) => dispatch(`hl.dsp.window.close({ window = "address:${address}" })`);

// Hyprland's event stream, one onEvent(name) a line; it comes back by itself if the socket drops.
function events(onEvent) {
  let socket = null;
  let stopped = false;
  let retry = 0;
  const connect = () => {
    let rest = '';
    socket = net.connect(path.join(DIR, '.socket2.sock'));
    socket.on('data', (d) => {
      const lines = (rest + d.toString('utf8')).split('\n');
      rest = lines.pop();
      for (const line of lines) onEvent(line.split('>>')[0]);
    });
    socket.on('error', () => {}); // its close says so
    socket.on('close', () => {
      if (!stopped) retry = setTimeout(connect, 3000);
    });
  };
  connect();
  return () => {
    stopped = true;
    clearTimeout(retry);
    socket?.destroy();
  };
}

// A PNG of that area of the desktop (layout coordinates), as a Buffer.
function capture({ x, y, width, height }) {
  return new Promise((resolve, reject) => {
    execFile('grim', ['-g', `${x},${y} ${width}x${height}`, '-t', 'png', '-'],
      { encoding: 'buffer', maxBuffer: 256 * 1024 * 1024, timeout: 8000 },
      (err, out) => (err ? reject(err) : resolve(out)));
  });
}

// Her glitch over the whole screen (assets/shaders/glitch.frag): a few frames of it, then the screen
// back as it was. Each frame is its own copy of the shader with another SEED, written once.
const fs = require('node:fs');
const os = require('node:os');
const FRAMES = 4;
let frames = null;
let glitching = false;
function glitchFrames() {
  if (frames) return frames;
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'assets', 'shaders', 'glitch.frag'), 'utf8');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capri-glitch-'));
  frames = {};
  for (const [kind, amount] of [['hit', 1.0], ['soft', 0.45]]) {
    frames[kind] = Array.from({ length: FRAMES }, (_, i) => {
      const file = path.join(dir, `${kind}-${i}.frag`);
      fs.writeFileSync(file, src.replace('#define SEED 0.0', `#define SEED ${(i * 13.37 + 1).toFixed(2)}`)
        .replace('#define AMOUNT 1.0', `#define AMOUNT ${amount.toFixed(2)}`));
      return file;
    });
  }
  return frames;
}
const setShader = (file) => ask(`/eval hl.config({ decoration = { screen_shader = ${JSON.stringify(file)} } })`);
const clearShader = () => setShader('').catch(() => {});
async function glitch(kind = 'hit', frameMs = 70) {
  if (!DIR || glitching) return;
  glitching = true;
  try {
    const list = glitchFrames()[kind] || glitchFrames().hit;
    for (const file of list) {
      await setShader(file);
      await new Promise((r) => setTimeout(r, frameMs));
    }
  } finally {
    await clearShader();
    glitching = false;
  }
}

// Your active window's border in her colors (her mood, from main.js). What your config had is read
// first, so it can go back exactly: Hyprland gives it as "gradient data: AARRGGBB ... <angle>deg".
let ownBorder = null;
async function readOwnBorder() {
  const out = await ask('getoption general:col.active_border');
  const m = out.match(/gradient data:\s*([0-9a-f ]+?)\s+(-?\d+)deg/i);
  if (!m) return null;
  const colors = m[1].trim().split(/\s+/).map((c) => `rgba(${c.slice(2)}${c.slice(0, 2)})`);
  ownBorder = { colors, angle: Number(m[2]) };
  return ownBorder;
}
const luaGradient = ({ colors, angle = 0 }) => `{ colors = { ${colors.map((c) => JSON.stringify(c)).join(', ')} }, angle = ${angle} }`;
async function paintBorder(gradient) {
  if (!DIR) return;
  if (!ownBorder) await readOwnBorder();
  const g = gradient || ownBorder;
  if (!g) return;
  await ask(`/eval hl.config({ general = { col = { active_border = ${luaGradient(g)} } } })`);
}

module.exports = { available, ask, json, dispatch, cursor, moveCursor, setFocusable, restoreOverlay, takeKeyboard, giveKeyboardBack, closeWindow, events, capture, glitch, clearShader, readOwnBorder, paintBorder };
