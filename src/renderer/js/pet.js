// Pet her: the pointer going gently back and forth over her. She leans into it and calls you a good
// boy. Mad at you, she shoos you off, but a third go melts her. A little sync, a few times a day.
// No button is involved, so a pointer just passing over her, or shaken about, doesn't count: it
// takes a few changes of direction, at a stroking speed, on her.

import { pick } from './util.js';

const WINDOW = 1500;    // ms of pointer path looked at
const MIN_STROKE = 12;  // px one way before a change of direction counts (not a shaky hand)
const STROKES = 3;      // changes of direction that make it a pet
const MAX_SPEED = 2600; // px/s: faster than this is shaking the mouse, not petting
const ON_HER = 0.7;     // of the path
const AGAIN = 3500;     // ms before she reacts again
const SAY_EVERY = 9000; // ms between two things she says about it
const MELTS = 3;        // pets while she's mad

export class Petting {
  constructor({ capri, panel, brain, bond, jealousy, fx, voice, thief }) {
    Object.assign(this, { capri, panel, brain, bond, jealousy, fx, voice, thief });
    this.path = [];
    this.nextAt = 0;
    this.saidAt = -Infinity;
    this.mad = 0;   // pets so far while she's mad
    this.last = ''; // how the last one went (for --dev)
  }

  // Where the pointer just went, on her window.
  move(x, y) {
    const now = performance.now();
    const end = this.path.at(-1);
    if (end && end.x === x && end.y === y) return;
    this.path.push({ x, y, t: now, on: this.capri.hit(x, y) });
    while (this.path.length && now - this.path[0].t > WINDOW) this.path.shift();
    if (now >= this.nextAt && this.free() && this.stroked()) {
      this.nextAt = now + AGAIN;
      this.path.length = 0;
      this.pet(x);
    }
  }

  free() {
    const { capri } = this;
    return !this.thief.running && !capri.busy && !capri.dragging && !capri.pressed && !capri.hidden && !capri.stowed
      && !capri.dormant && !capri.act && capri.mode !== 'alert' && !capri.pointing
      && ['stand', 'sit'].includes(capri.stance);
  }

  // Back and forth over her, not too fast? Along whichever way the pointer moved the most.
  stroked() {
    const p = this.path;
    if (p.length < 5 || p.filter((a) => a.on).length / p.length < ON_HER) return false;
    const span = (key) => Math.max(...p.map((a) => a[key])) - Math.min(...p.map((a) => a[key]));
    const key = span('x') >= span('y') ? 'x' : 'y';
    let turns = 0, way = 0, run = 0, length = 0;
    for (let i = 1; i < p.length; i++) {
      const d = p[i][key] - p[i - 1][key];
      length += Math.hypot(p[i].x - p[i - 1].x, p[i].y - p[i - 1].y);
      if (!d) continue;
      const now = Math.sign(d);
      if (now === way) {
        run += Math.abs(d);
      } else {
        if (way && run >= MIN_STROKE) turns += 1;
        way = now;
        run = Math.abs(d);
      }
    }
    const seconds = Math.max(0.05, (p.at(-1).t - p[0].t) / 1000);
    return turns >= STROKES && length / seconds <= MAX_SPEED;
  }

  // Thrown around too much, or sulking over another AI.
  get angry() {
    return ['angry', 'sulk'].includes(this.bond.feeling) || Boolean(this.jealousy.sulk)
      || performance.now() < this.capri.refuseUntil;
  }

  say(line, face, hold = 3000) {
    const { panel } = this;
    if (panel.visible && !['idle', 'info'].includes(panel.current?.kind)) return;
    panel.say({ kind: 'idle', face, line, hold });
    this.saidAt = performance.now();
  }

  pet(x) {
    const { capri, fx, voice, bond } = this;
    const t = this.brain.t.pet;
    const toward = x < capri.pos.x ? -1 : 1;
    const h = capri.head();
    if (this.angry) {
      this.mad += 1;
      if (this.mad < MELTS) {
        capri.perform('huff', -toward);
        this.say(pick(t.no), 'aside');
        this.last = 'no';
        return;
      }
      this.mad = 0;
      this.jealousy.sulk = null;
      capri.refuseUntil = 0;
      bond.feel('forgiven');
      capri.perform('nuzzle', toward);
      this.say(pick(t.forgive), 'look', 3500);
      this.last = 'forgiven';
      return;
    }
    capri.perform('nuzzle', toward);
    fx.burst(h.x, h.y, { count: 8, power: 0.35, spread: 46 });
    voice.play('blip', { mood: 'grin' });
    bond.add('pet', 1);
    bond.feel('petted');
    this.last = 'pet';
    if (performance.now() - this.saidAt >= SAY_EVERY) {
      const name = this.brain.custom?.userName;
      const lines = name ? [...t.good, ...t.goodName] : t.good;
      this.say(pick(lines).replace('{name}', name || ''), 'smug');
    }
  }
}
