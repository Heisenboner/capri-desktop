'use strict';

// windows.ps1 for Hyprland: feeds the overlay with the same snapshot, so she sits on your windows,
// gets jealous and notices games and what you plug in. No contents and no titles go out: the title
// of the window in front is only checked against the AI names, as on Windows. Hyprland's event
// stream says when to look again; a slow timer catches what it doesn't report (a window resized).
//
// She doesn't close your other AIs' pages here (`pages` stays empty, `close` refuses): that sends
// Ctrl+W to your browser, and Windows checks first that no other key is held, which Wayland won't
// let a program do. She glares and sits on the window instead.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const hypr = require('./hyprland');

const LOOK_EVERY = 1000;
const QUIET = 80; // events come in bursts: one look after them
const USB_EVERY = 2000;
const EVENTS = new Set([
  'activewindow', 'activewindowv2', 'openwindow', 'closewindow', 'movewindow', 'movewindowv2',
  'windowtitle', 'windowtitlev2', 'changefloatingmode', 'fullscreen', 'minimized', 'workspace',
  'workspacev2', 'focusedmon', 'focusedmonv2', 'monitoradded', 'monitoraddedv2', 'monitorremoved',
  'activespecial', 'activespecialv2',
]);

// the same list as windows.ps1: a key, what gives it away in a title, its own app's window class
const AIS = [
  ['chatgpt', /\bChatGPT\b/i, 'chatgpt'], ['claude', /\bClaude\b/i, 'claude'], ['codex', /\bCodex\b/i, 'codex'],
  ['gemini', /\bGemini\b/i, ''], ['copilot', /\bCopilot\b/i, 'copilot'], ['perplexity', /\bPerplexity\b/i, 'perplexity'],
  ['deepseek', /\bDeepSeek\b/i, ''], ['grok', /\bGrok\b/i, ''], ['lechat', /\bLe Chat\b|\bMistral AI\b/i, ''],
  ['characterai', /character\.ai/i, ''], ['metaai', /\bMeta AI\b/i, ''],
];

// A game: its program sits in a launcher's library. Proton's own folders live there too, and aren't
// games. Run through Proton the path can have backslashes: they're turned around first.
const GAME = /\/(?:steamapps\/common|Games\/Heroic|Games\/Lutris|lutris\/games)\/([^/]+)\//i;
const NOT_GAME = /launcher|client|redistributable|steamworks|^proton|steam ?linux ?runtime/i;

function gameOf(pid) {
  let text = '';
  try {
    text = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
    text += `\0${fs.readlinkSync(`/proc/${pid}/exe`)}`;
  } catch {
    // gone, or not ours to read
  }
  const name = GAME.exec(text.replace(/\\/g, '/').replace(/\0/g, '/'))?.[1];
  return name && !NOT_GAME.test(name) ? name : null;
}

// USB sticks and SD cards, by the name of the place they're mounted at (the system mounts them there).
function drives() {
  let mounts = '';
  try {
    mounts = fs.readFileSync('/proc/self/mounts', 'utf8');
  } catch {
    return [];
  }
  const roots = [`/run/media/${os.userInfo().username}/`, `/media/${os.userInfo().username}/`];
  return mounts.split('\n').map((line) => (line.split(' ')[1] || '').replace(/\\040/g, ' '))
    .filter((at) => roots.some((root) => at.startsWith(root))).map((at) => path.basename(at));
}

// USB interface classes, in the order that says the most, named as pc.js knows them from Windows
const USB_CLASSES = [['06', 'WPD'], ['01', 'AudioEndpoint'], ['0e', 'Camera'], ['03', 'HIDClass'], ['e0', 'Bluetooth'], ['08', 'DiskDrive']];
const SYS_USB = '/sys/bus/usb/devices';
const readSys = (...parts) => {
  try {
    return fs.readFileSync(path.join(SYS_USB, ...parts), 'utf8').trim();
  } catch {
    return '';
  }
};

// id -> [name, class] of what's plugged in by USB, hubs left out
function usbDevices() {
  const all = new Map();
  let entries = [];
  try {
    entries = fs.readdirSync(SYS_USB);
  } catch {
    return all;
  }
  for (const id of entries) {
    if (id.includes(':') || id.startsWith('usb') || readSys(id, 'bDeviceClass') === '09') continue;
    const name = readSys(id, 'product') || readSys(id, 'manufacturer');
    if (!name) continue;
    const kinds = entries.filter((e) => e.startsWith(`${id}:`)).map((e) => readSys(e, 'bInterfaceClass'));
    const cls = USB_CLASSES.find(([code]) => kinds.includes(code))?.[1] || '';
    all.set(`${id}/${readSys(id, 'devnum')}`, [name, cls]);
  }
  return all;
}

// Front first: fullscreen, then floating, then tiled, each by how recently it had the focus.
const layer = (c) => (c.fullscreen ? 0 : c.floating ? 1 : 2);
const frontFirst = (a, b) => layer(a) - layer(b) || a.focusHistoryID - b.focusHistoryID;

function startHyprWatch({ overlay, onUpdate }) {
  let stopped = false;
  let looking = false;
  let again = false;
  let quietTimer = 0;
  let last = null;     // the latest snapshot, in desktop coordinates
  let lastSent = '';
  let origin = null;   // where Hyprland really has her window
  let front = null;    // { id, game }: read once a window comes in front
  let known = null;    // what was plugged in at the last look
  let plugs = 0;
  let plug = null;
  let usb = drives();

  const send = (force) => {
    if (!last || overlay.isDestroyed()) return;
    const bounds = overlay.getBounds();
    const [ox, oy] = origin || [bounds.x, bounds.y];
    const wins = last.wins
      .map((w) => ({ ...w, x: w.x - ox, y: w.y - oy }))
      .filter((w) => w.x < bounds.width && w.x + w.w > 0 && w.y < bounds.height && w.y + w.h > 0);
    const data = { ...last, wins };
    const text = JSON.stringify(data);
    if (!force && text === lastSent) return;
    lastSent = text;
    onUpdate(data);
  };

  const look = async () => {
    if (stopped) return;
    if (looking) {
      again = true;
      return;
    }
    looking = true;
    try {
      const [clients, monitors] = await Promise.all([hypr.json('clients'), hypr.json('monitors')]);
      const shown = new Set(monitors.flatMap((m) => [m.activeWorkspace?.id, m.specialWorkspace?.id]).filter(Boolean));
      const self = clients.find((c) => c.pid === process.pid);
      if (self) origin = self.at;
      const open = clients.filter((c) => c.pid !== process.pid && c.mapped && !c.hidden && shown.has(c.workspace?.id));
      open.sort(frontFirst);
      const top = [...open].sort((a, b) => a.focusHistoryID - b.focusHistoryID)[0];
      const id = top ? Number.parseInt(top.address, 16) : 0;
      if (front?.id !== id) front = { id, game: top ? gameOf(top.pid) : null };
      const ai = !top ? [] : AIS.filter(([, title, cls]) => title.test(top.title || '') || (cls && String(top.class).toLowerCase() === cls)).map(([key]) => key);
      last = {
        fg: id, app: top ? String(top.class || '').toLowerCase().slice(0, 40) : null, taskbar: false, ai, pages: [], dl: false, game: front.game, usb, plug,
        wins: open.filter((c) => c.size[0] >= 200 && c.size[1] >= 120).slice(0, 40).map((c) => ({
          id: Number.parseInt(c.address, 16), x: c.at[0], y: c.at[1], w: c.size[0], h: c.size[1], max: c.fullscreen > 0,
        })),
      };
      send();
    } catch (err) {
      console.error('[capri] window watch:', err.message);
    }
    looking = false;
    if (again) {
      again = false;
      look();
    }
  };

  const soon = () => {
    clearTimeout(quietTimer);
    quietTimer = setTimeout(look, QUIET);
  };

  const checkUsb = () => {
    usb = drives();
    const now = usbDevices();
    if (known) {
      const added = [...now].filter(([id]) => !known.has(id)).map(([, d]) => d);
      const removed = [...known].filter(([id]) => !now.has(id)).map(([, d]) => d);
      const list = added.length ? added : removed;
      if (list.length) {
        const best = USB_CLASSES.map(([, cls]) => list.find((d) => d[1] === cls)).find(Boolean) || list[0];
        plug = { n: ++plugs, in: added.length > 0, name: best[0], class: best[1] };
      }
    }
    known = now;
    if (last && (last.plug !== plug || JSON.stringify(last.usb) !== JSON.stringify(usb))) look();
  };

  const stopEvents = hypr.events((name) => EVENTS.has(name) && soon());
  const lookTimer = setInterval(look, LOOK_EVERY);
  const usbTimer = setInterval(checkUsb, USB_EVERY);
  checkUsb();
  look();

  return {
    stop() {
      stopped = true;
      stopEvents();
      clearTimeout(quietTimer);
      clearInterval(lookTimer);
      clearInterval(usbTimer);
    },
    refresh: () => send(true),
    close: async () => 'windows',
  };
}

module.exports = { startHyprWatch };
