/* Note-count assessment: observed attacks only; predictions never earn points. */
(function (g) {
  "use strict";
  class Assessment {
    constructor(graph, start = 0) {
      this.graph = graph;
      this.slots = [];
      graph.events.forEach((e, index) => {
        if (e.tick >= start)
          for (const pitch of e.pitches)
            this.slots.push({
              index,
              pitch,
              tick: e.tick,
              status: "pending",
              rhythm: 0,
            });
      });
      this.extra = 0;
      this.anchor = null;
      this.closed = false;
    }
    observe(o, p) {
      if (this.closed || !o.isAttack || p.confidence < 0.5) return;
      const time = o.timeMs - (o.exact ? 0 : o.analysisLatencyMs || 0),
        attacks = o.attacks || o.pitches;
      for (let pitch = 0; pitch < attacks.length; pitch++) {
        if (!(o.exact ? attacks[pitch] > 0 : attacks[pitch] >= 0.5)) continue;
        const nearby = this.slots.filter(
            (s) =>
              s.status === "pending" && Math.abs(s.index - p.eventIndex) <= 2,
          ),
          matching = nearby
            .filter((s) => s.pitch === pitch)
            .sort(
              (a, b) =>
                Math.abs(a.index - p.eventIndex) -
                Math.abs(b.index - p.eventIndex),
            );
        let slot = matching[0] || nearby.find((s) => s.index === p.eventIndex);
        if (!slot) {
          this.extra++;
          continue;
        }
        slot.status = slot.pitch === pitch ? "correct" : "wrong";
        const period = 60000 / (p.tempo || 120),
          expected = this.anchor
            ? this.anchor.time +
              ((slot.tick - this.anchor.tick) * period) / this.graph.quarter
            : time,
          error = Math.abs(time - expected);
        slot.rhythm =
          slot.status === "correct"
            ? Math.max(0, 1 - error / Math.max(150, period * 0.5))
            : 0;
        if (!this.anchor || slot.tick > this.anchor.tick)
          this.anchor = { tick: slot.tick, time };
      }
      for (const s of this.slots)
        if (s.status === "pending" && s.index < p.eventIndex - 2)
          s.status = "missed";
    }
    finish() {
      this.closed = true;
      for (const s of this.slots)
        if (s.status === "pending") s.status = "missed";
      return this.snapshot();
    }
    snapshot() {
      const count = (status) =>
          this.slots.filter((s) => s.status === status).length,
        total = this.slots.length,
        correct = count("correct");
      return {
        total,
        correct,
        wrong: count("wrong"),
        missed: count("missed"),
        pending: count("pending"),
        extra: this.extra,
        score: total
          ? Math.max(
              0,
              Math.min(
                100,
                (70 * correct +
                  30 * this.slots.reduce((n, s) => n + s.rhythm, 0) -
                  100 * this.extra) /
                  total,
              ),
            )
          : null,
        finished: this.closed,
      };
    }
  }
  g.ScoreFollowCore.Assessment = Assessment;
  if (typeof module !== "undefined") module.exports = Assessment;
})(globalThis);
