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

// Her window takes the keyboard only while the pointer is on her.
const setFocusable = (on) => dispatch(
  `hl.dsp.window.set_prop({ prop = "no_focus", value = "${on ? 0 : 1}", window = "class:capri-desktop" })`,
);

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

module.exports = { available, ask, json, dispatch, cursor, setFocusable, takeKeyboard, giveKeyboardBack, closeWindow, events, capture };
