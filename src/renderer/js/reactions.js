// She reacts to what you do: the app you move to, the song that changes, a run of skipped songs, you
// still up at 3am, hours on the same app. Each from her AI, in her persona (main.js, capri:muse),
// which only gets the app's name or the song, and she says nothing if it can't answer. Her menu's
// "Talk about what I'm doing" turns all of it off.

const GAP = 3 * 60 * 1000;        // the least between two things she says on her own
const APP_AFTER = 8000;           // in an app this long: you're really there
const APP_AGAIN = 30 * 60 * 1000; // the same app, not before this
const SONG_CHANCE = 0.35;         // not every song
const SKIP_WINDOW = 90 * 1000;
const SKIPS = 3;
const STARE = 90 * 60 * 1000;     // this long on one app
const THERE = 5 * 60 * 1000;      // the pointer moved this recently: you're there
const LATE_AGAIN = 60 * 60 * 1000;
const SONG_EVERY = 8000;

export class Reactions {
  constructor({ capri, panel, chat, guide, host, active, speak }) {
    Object.assign(this, { capri, panel, chat, guide, host, active, speak });
    this.lastAt = performance.now(); // nothing the moment she starts
    this.front = null;               // { app, since, said, stared }
    this.seen = new Map();           // app -> when she last reacted to it
    this.song = undefined;           // what's playing (undefined: not looked yet)
    this.changes = [];               // when the song changed lately
    this.lateAt = -Infinity;
    setInterval(() => this.checkSong(), SONG_EVERY);
    setInterval(() => this.check(), 2000);
  }

  spoke() {
    this.lastAt = performance.now();
  }

  get free() {
    const { capri, chat, guide, panel } = this;
    if (capri.stowed || capri.hidden || capri.busy || capri.dragging || capri.mode === 'alert') return false;
    return !chat.open && !guide.running && !panel.visible && !capri.windows.wins[0]?.max;
  }

  // Her line about it, now. False if it can't be said.
  async fire(about) {
    this.spoke();
    const line = await this.host.muse(about).catch(() => null);
    if (!line || !this.free) return false;
    this.speak(line);
    return true;
  }

  ready() {
    return performance.now() - this.lastAt >= GAP && this.active() < THERE && this.free;
  }

  // what's in front (windows.js)
  onWindows({ app = null }) {
    if (!app || this.front?.app === app) return;
    this.front = { app, since: performance.now(), said: false, stared: false };
  }

  check() {
    const f = this.front;
    const now = performance.now();
    if (!this.ready()) return;
    const hour = new Date().getHours();
    if (hour >= 1 && hour < 5 && now - this.lateAt > LATE_AGAIN) {
      this.lateAt = now;
      this.fire({ kind: 'late', hour });
      return;
    }
    if (!f) return;
    if (!f.stared && now - f.since >= STARE) {
      f.stared = true;
      this.fire({ kind: 'stare', app: f.app, minutes: Math.round((now - f.since) / 60000) });
      return;
    }
    if (!f.said && now - f.since >= APP_AFTER) {
      f.said = true;
      if (now - (this.seen.get(f.app) ?? -Infinity) < APP_AGAIN) return;
      this.seen.set(f.app, now);
      this.fire({ kind: 'app', app: f.app });
    }
  }

  async checkSong() {
    const now = await this.host.nowPlaying().catch(() => null);
    const key = now?.status === 'Playing' ? `${now.title}|${now.artist}` : null;
    const before = this.song;
    if (key) this.song = key;
    else if (before === undefined) this.song = null;
    if (!key || key === before || before === undefined || before === null) return;
    const at = performance.now();
    this.changes = [...this.changes.filter((t) => at - t < SKIP_WINDOW), at];
    if (!this.ready()) return;
    if (this.changes.length >= SKIPS) {
      this.changes = [];
      this.fire({ kind: 'skips', n: SKIPS });
    } else if (Math.random() < SONG_CHANCE) {
      this.fire({ kind: 'song', title: now.title, artist: now.artist });
    }
  }
}
