/* Parangonar SLT_OLTW, Apache-2.0. Port of Android 1.0 TempoPitchTracker.
 * Numerical operations intentionally preserve float32 rounding. */
(function (g) {
  "use strict";
  const f = Math.fround,
    clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  class TempoPitchTracker {
    constructor(beats, pitches, period = 0.5, window = 40, maxRun = 10) {
      if (!beats.length || beats.length !== pitches.length)
        throw Error("Invalid score reference");
      this.beats = beats;
      this.pitches = pitches.map((p) => (p instanceof Set ? p : new Set(p)));
      this.initial = clamp(period, 0.05, 10);
      this.window = window;
      this.maxRun = maxRun;
      this.cost = [0, 1].map(() =>
        new Float32Array(beats.length + 1).fill(Infinity),
      );
      this.length = [0, 1].map(() => new Float32Array(beats.length + 1));
      this.tempo = [0, 1].map(() =>
        new Float32Array(beats.length + 1).fill(this.initial),
      );
      this.index = 0;
      this.count = 0;
      this.period = this.initial;
      this.distance = Infinity;
      this.previousTime = 0;
    }
    accept(time, pitch) {
      if (!Number.isFinite(time)) throw Error("Invalid performance time");
      const start = Math.max(0, this.index - this.window),
        end = Math.min(this.beats.length, this.index + this.window);
      let best = Infinity,
        candidate = start;
      if (start === 0 && this.count === 0) {
        this.cost[1][1] = 0;
        this.length[1][1] = 0;
        best = 0;
        candidate = 0;
      }
      for (let i = start; i < end; i++) {
        if (i === 0 && this.count === 0) continue;
        let local = Infinity,
          period = f(this.initial),
          length = 1;
        for (let d = 0; d < 3; d++) {
          const istep = d === 2 ? 0 : 1,
            jstep = d === 0 ? 0 : 1,
            prev = i - istep,
            col = 1 - jstep;
          const old = this.cost[col][prev + 1];
          if (!Number.isFinite(old)) continue;
          const len = this.length[col][prev + 1],
            tempo = this.tempo[col][prev + 1],
            pt = jstep === 0 || this.count === 0 ? time : this.previousTime,
            dt = time - pt,
            db =
              this.beats[i] -
              this.beats[prev < 0 ? this.beats.length - 1 : prev];
          const onset = f(
            f(Math.abs(f(f(time) - f(f(pt) + f(f(db) * tempo))))) / tempo,
          );
          const current = db > 0 ? dt / db : f(tempo + f(dt));
          const next = clamp(f(f(0.1 * current) + f(f(0.9) * tempo)), 0.05, 10);
          const metric = f((this.pitches[i].has(pitch) ? 0 : 1) + f(2 * onset));
          const value =
            (f(old * len) + metric * (d === 0 ? 2 : 1)) / f(len + 1);
          if (value < local) {
            local = value;
            period = next;
            length = f(len + 1);
          }
        }
        this.cost[1][i + 1] = local;
        this.tempo[1][i + 1] = period;
        this.length[1][i + 1] = length;
        if (local < best) {
          best = local;
          candidate = i;
        }
      }
      this.cost[0].set(this.cost[1]);
      this.cost[1].fill(Infinity);
      this.length[0].set(this.length[1]);
      this.length[1].fill(0);
      this.tempo[0].set(this.tempo[1]);
      this.tempo[1].fill(this.initial);
      if (this.count)
        this.index = clamp(
          candidate,
          Math.max(0, this.index - this.maxRun),
          Math.min(this.beats.length - 1, this.index + this.maxRun),
        );
      this.period = this.tempo[0][this.index + 1];
      this.distance = this.cost[0][this.index + 1];
      this.count++;
      this.previousTime = time;
      return this.index;
    }
    extend(beats, pitches) {
      const next = new TempoPitchTracker(
        beats,
        pitches,
        this.initial,
        this.window,
        this.maxRun,
      );
      for (let c = 0; c < 2; c++) {
        next.cost[c].set(this.cost[c]);
        next.length[c].set(this.length[c]);
        next.tempo[c].set(this.tempo[c]);
      }
      for (const key of [
        "index",
        "count",
        "period",
        "distance",
        "previousTime",
      ])
        next[key] = this[key];
      return next;
    }
  }
  class TempoPrediction {
    constructor(period) {
      this.period = period;
      this.tick = null;
      this.time = 0;
      this.intervals = [];
    }
    confirm(tick, time, quarter, aligned) {
      if (this.tick !== null && tick > this.tick) {
        const beats = (tick - this.tick) / quarter,
          seconds = (time - this.time) / 1000,
          c = seconds / beats;
        if (
          beats <= 2 &&
          seconds >= 0.08 &&
          c >= this.period * 0.5 &&
          c <= this.period * 2
        ) {
          this.intervals.push(c);
          if (this.intervals.length > 7) this.intervals.shift();
        }
      }
      if (this.tick === null || tick !== this.tick) {
        this.tick = tick;
        this.time = time;
      }
      const sorted = this.intervals.slice().sort((a, b) => a - b);
      this.period = clamp(
        0.75 * aligned +
          0.25 *
            (sorted.length >= 3
              ? sorted[Math.floor(sorted.length / 2)]
              : aligned),
        0.05,
        10,
      );
    }
  }
  g.ScoreFollowCore = { TempoPitchTracker, TempoPrediction };
  if (typeof module !== "undefined") module.exports = g.ScoreFollowCore;
})(globalThis);
