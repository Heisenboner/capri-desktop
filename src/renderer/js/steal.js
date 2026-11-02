// She steals your pointer: a bolt from her hand catches it, she reels it in, shakes it about and
// flings it across the screen. Hyprland only (the compositor moves the pointer), her menu turns it
// off. It's your real pointer, so she's careful with it: only when it's lying still and you're
// around, never in a game, a fullscreen window or her chat, and the moment you move the mouse
// yourself she's lost it. Wayland can't tell a program that a button is held, so that's the guard.

import { pick, rand, reducedMotion } from './util.js';

const CHECK = 20 * 1000;
const FIRST_AFTER = 5 * 60 * 1000; // not right after she starts
const EVERY = [25, 50];            // minutes between two thefts
const STILL_MS = 1500;             // the pointer has to be at rest this long…
const THERE_MS = 2 * 60 * 1000;    // …but have moved this recently: you're there to see it
const STEP = 33;
const ESCAPED = 10;                // this far from where she put it: that was you
const REEL = 650, SHAKE = 500, FLING = 260; // ms

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ease = (t) => 1 - (1 - t) ** 3;

export class Thief {
  constructor({ capri, panel, brain, chat, guide, pc, host, fx, voice, active }) {
    Object.assign(this, { capri, panel, brain, chat, guide, pc, host, fx, voice, active });
    this.enabled = true; // her menu: Steal my pointer
    this.running = false;
    this.nextAt = Date.now() + FIRST_AFTER;
    this.placed = null; // where she last put the pointer
    this.last = ''; // how the last one ended (for --dev)
    setInterval(() => this.tick(), CHECK);
  }

  tick() {
    if (!this.enabled || this.running || Date.now() < this.nextAt || !this.free()) return;
    this.nextAt = Date.now() + rand(EVERY[0], EVERY[1]) * 60 * 1000;
    this.run();
  }

  free() {
    const { capri, panel } = this;
    const idle = this.active();
    const { wins, fg } = capri.windows;
    return capri.free && capri.stance === 'stand' && capri.mode === 'idle' && !reducedMotion.matches
      && !this.chat.open && !this.guide.running && !panel.visible && !this.pc.game
      && idle >= STILL_MS && idle <= THERE_MS && !wins?.find((w) => w.id === fg)?.max;
  }

  // Something more important came up, or she can't go on.
  interrupted() {
    const { capri } = this;
    return capri.mode !== 'idle' || capri.hidden || capri.stowed || capri.dragging || capri.pressed;
  }

  // The pointer to (x, y). It has to be where she left it first: anywhere else, you moved it, and
  // looking after her own move would miss that, it wipes out what you did since the last step.
  async put(x, y) {
    const at = await this.host.cursor().catch(() => null);
    if (!at || Math.hypot(at.x - this.placed.x, at.y - this.placed.y) > ESCAPED) return 'lost';
    if (!(await this.host.movePointer(x, y).catch(() => false))) return 'stopped';
    this.placed = { x, y };
    return null;
  }

  // `path(t)` from t = 0 to 1 over `ms`, with her lightning on it.
  async along(ms, path, hand) {
    const start = performance.now();
    for (let n = 0; ; n++) {
      const t = Math.min(1, (performance.now() - start) / ms);
      const { x, y } = path(t);
      if (this.interrupted()) return 'stopped';
      const out = await this.put(x, y);
      if (out) return out;
      if (n % 4 === 0) this.fx.bolt(hand(), { x, y }, { life: 130, forks: 1, width: 2 });
      if (t >= 1) return null;
      await sleep(STEP);
    }
  }

  // `dir`: the side of her the pointer is on.
  async haul(from, dir) {
    const { capri } = this;
    const side = capri.armToward(dir);
    const hand = () => capri.limb(side).hand;
    const { x: hx, y: hy } = hand();
    const lerp = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    const held = { x: hx, y: hy };
    const { w, floor } = capri.view;
    const away = {
      x: Math.min(w - 30, Math.max(30, hx - dir * rand(350, 600))), // past her, the other way
      y: rand(90, Math.max(100, floor - 120)),
    };
    return await this.along(REEL, (t) => lerp(from, held, ease(t)), hand)
      || await this.along(SHAKE, (t) => ({
        x: held.x + Math.sin(t * 22) * 26 * (1 - t / 2), y: held.y + Math.cos(t * 17) * 18 * (1 - t / 2),
      }), hand)
      || (this.voice.play('throw', { power: 0.7 }), await this.along(FLING, (t) => lerp(held, away, ease(t)), hand))
      || 'took';
  }

  // One theft. How it went: 'took', 'lost' (you got it back), 'stopped', or 'no' (she didn't try).
  async run() {
    if (this.running) return 'no';
    this.running = true;
    const { capri, panel, fx } = this;
    let result = 'no';
    try {
      const first = await this.host.cursor();
      if (!first?.inside) return result;
      await capri.summon(first);
      const at = await this.host.cursor();
      if (!at?.inside || !capri.free) return result;
      const dir = at.x < capri.pos.x ? -1 : 1;
      if (!capri.zap(at.x, at.y)) return result;
      capri.busy = true;
      this.placed = { x: at.x, y: at.y };
      this.voice.play('charge');
      await sleep(180); // her arm shoots out
      result = await this.haul(at, dir);
    } finally {
      capri.busy = false;
      capri.zapAt = null;
      this.running = false;
      this.last = result;
    }
    const t = this.brain.t.steal;
    if (result === 'took') {
      fx.cutin(...capri.cutinAt(capri.towardCenter()), { kind: 'laugh', life: 700 });
      panel.say({ kind: 'idle', face: 'laugh', line: pick(t.took), hold: 3500 });
    } else if (result === 'lost') {
      capri.perform('huff', capri.towardCenter());
      panel.say({ kind: 'idle', face: 'aside', line: pick(t.lost), hold: 3000 });
    }
    return result;
  }
}
