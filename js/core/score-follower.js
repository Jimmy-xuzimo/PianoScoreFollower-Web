/* Android 1.0 SymbolicScoreFollower / NoteStartLocator adaptation.
 * TempoPitchTracker derives from Apache-2.0 Parangonar; see THIRD_PARTY_NOTICES. */
(function (g) {
  "use strict";
  const { TempoPitchTracker, TempoPrediction } = g.ScoreFollowCore;
  function graph(structure) {
    let events = [];
    for (const b of structure.bars)
      for (const e of b.events)
        events.push({
          ...e,
          pitches: e.notes,
          measure: b.index,
          occurrence: b.occurrence || 0,
        });
    return {
      events,
      quarter: structure.ticksPerQuarter || 960,
      endTick: Math.max(0, ...structure.bars.map((b) => b.end)),
    };
  }
  class Locator {
    constructor(graph, period) {
      this.graph = graph;
      this.initialPeriod = period;
      this.groups = graph.events
        .map((e, i) => (e.pitches.length ? i : -1))
        .filter((i) => i >= 0);
      this.candidates = [];
      this.spawned = new Set();
      this.first = null;
      this.lastGroup = null;
      this.onsetGroups = 0;
    }
    accept(time, pitch) {
      if (this.first === null) this.first = time;
      if (this.lastGroup === null || time - this.lastGroup >= 70) {
        this.onsetGroups++;
        this.lastGroup = time;
      }
      if (time - this.first <= 128) {
        let matches = this.groups
          .map((e, i) =>
            !this.spawned.has(i) && this.graph.events[e].pitches.includes(pitch)
              ? i
              : -1,
          )
          .filter((i) => i >= 0);
        if (matches.length <= 512)
          for (const start of matches) {
            let ids = this.groups.slice(start, start + 128),
              period =
                this.initialPeriod ||
                60 / (this.graph.events[ids[0]].tempo || 120);
            this.candidates.push({
              start,
              at: time,
              tracker: new TempoPitchTracker(
                ids.map((i) => this.graph.events[i].tick / this.graph.quarter),
                ids.map((i) => this.graph.events[i].pitches),
                period,
              ),
            });
            this.spawned.add(start);
          }
      }
      for (const c of this.candidates)
        c.tracker.accept((time - c.at) / 1000, pitch);
      let ranked = this.candidates
        .filter((c) => c.tracker.count >= (this.initialPeriod ? 8 : 6))
        .sort((a, b) => a.tracker.distance - b.tracker.distance);
      if (this.onsetGroups >= 4 && ranked.length) {
        let best = ranked[0],
          end = best.start + best.tracker.index,
          second = ranked.find(
            (c) => Math.abs(c.start + c.tracker.index - end) > 1,
          );
        if (
          best.tracker.distance < 0.6 &&
          (!second || second.tracker.distance - best.tracker.distance > 0.08)
        )
          return {
            eventIndex: this.groups[best.start],
            startedAt: best.at,
            tracker: best.tracker,
          };
      }
      if (time - this.first > 5000) {
        this.candidates = [];
        this.spawned.clear();
        this.first = null;
        this.lastGroup = null;
        this.onsetGroups = 0;
      }
      return null;
    }
  }
  class ScoreFollower {
    constructor(graph, start = 0, automatic = false) {
      this.graph = graph;
      this.seek(start);
      if (automatic) {
        this.locator = new Locator(graph);
        this.position.status = "LOCATING";
      }
    }
    seek(tick) {
      this.locator = null;
      this.recovery = false;
      let start = this.graph.events.findIndex((e) => e.tick >= tick);
      if (start < 0) start = Math.max(0, this.graph.events.length - 1);
      this.groups = this.graph.events
        .map((e, i) => (i >= start && e.pitches.length ? i : -1))
        .filter((i) => i >= 0);
      this.tracker = this.groups.length
        ? new TempoPitchTracker(
            this.groups.map(
              (i) => this.graph.events[i].tick / this.graph.quarter,
            ),
            this.groups.map((i) => this.graph.events[i].pitches),
            60 / (this.graph.events[this.groups[0]].tempo || 120),
          )
        : null;
      this.prediction = new TempoPrediction(this.tracker?.period || 0.5);
      this.anchor = 0;
      this.anchorTime = null;
      this.lastTime = null;
      this.origin = null;
      this.quiet = null;
      this.excluded = 0;
      this.pending = -1;
      this.pendingAt = 0;
      this.pendingCount = 0;
      this.evidence = [];
      const e = this.graph.events[start];
      this.position = {
        eventIndex: start,
        tick,
        measure: e?.measure || 0,
        occurrence: e?.occurrence || 0,
        tempo: 120,
        confidence: 0,
        status: "WAITING",
        similarity: 0,
      };
    }
    confidence() {
      const avg = this.evidence.length
        ? this.evidence.reduce((a, b) => a + b, 0) / this.evidence.length
        : 0;
      return Math.min(1, 0.7 * avg + 0.3 / (1 + (this.tracker?.distance || 0)));
    }
    accept(o) {
      const time = o.timeMs - (o.exact ? 0 : o.analysisLatencyMs || 0),
        attacks = o.attacks || o.pitches;
      if (this.locator) {
        if (o.isAttack)
          for (let n = 0; n < attacks.length; n++)
            if (attacks[n] > 0 && (o.exact || attacks[n] >= 0.5)) {
              const found = this.locator.accept(time, n);
              if (!found) continue;
              this.groups = this.graph.events
                .map((e, i) =>
                  i >= found.eventIndex && e.pitches.length ? i : -1,
                )
                .filter((i) => i >= 0);
              this.tracker = found.tracker.extend(
                this.groups.map(
                  (i) => this.graph.events[i].tick / this.graph.quarter,
                ),
                this.groups.map((i) => this.graph.events[i].pitches),
              );
              this.prediction = new TempoPrediction(found.tracker.period);
              this.anchor = found.tracker.index;
              this.anchorTime = time;
              this.origin = found.startedAt;
              this.lastTime = time;
              this.excluded = 0;
              this.quiet = null;
              this.pending = -1;
              this.pendingCount = 0;
              this.locator = null;
              this.recovery = false;
              this.evidence = Array(8).fill(1);
              const e = this.graph.events[this.groups[this.anchor]];
              this.position = {
                eventIndex: this.groups[this.anchor],
                tick: e.tick,
                measure: e.measure,
                occurrence: e.occurrence,
                tempo: 60 / this.tracker.period,
                confidence: this.confidence(),
                status: "FOLLOWING",
              };
              return this.advance(o.timeMs, o.active);
            }
        if (!this.recovery)
          return (this.position = {
            ...this.position,
            status: "LOCATING",
            confidence: 0,
          });
      }
      const t = this.tracker;
      if (!t) return this.position;
      if (this.lastTime !== null && time < this.lastTime) return this.position;
      if (
        !this.locator &&
        o.isAttack &&
        this.quiet !== null &&
        time - this.quiet >= 400 &&
        this.anchorTime !== null
      ) {
        const next = this.graph.events[this.groups[this.anchor + 1]],
          e = this.graph.events[this.groups[this.anchor]],
          expected = next
            ? ((next.tick - e.tick) * 1000 * t.period) / this.graph.quarter
            : Infinity;
        if (next && time - this.anchorTime - expected > 750) {
          this.locator = new Locator(this.graph, t.period);
          this.recovery = true;
          return this.accept(o);
        }
      }
      this.lastTime = time;
      if (o.isAttack) {
        if (
          this.quiet !== null &&
          time - this.quiet >= 800 &&
          this.anchorTime !== null
        ) {
          const next = this.graph.events[this.groups[this.anchor + 1]];
          if (next && next.pitches.some((n) => attacks[n] > 0)) {
            let extra =
              time -
              this.anchorTime -
              ((next.tick - this.graph.events[this.groups[this.anchor]].tick) *
                1000 *
                t.period) /
                this.graph.quarter;
            if (extra > 750) this.excluded += Math.trunc(extra);
          }
        }
        this.quiet = null;
        for (let n = 0; n < attacks.length; n++)
          if (attacks[n] > 0 && (o.exact || attacks[n] >= 0.5)) {
            if (this.origin === null) this.origin = time;
            const index = t.accept(
                (time - this.origin - this.excluded) / 1000,
                n,
              ),
              fit = t.pitches[index].has(n);
            this.evidence.push(fit ? 1 : 0);
            if (this.evidence.length > 8) this.evidence.shift();
            if (!fit) continue;
            const jump = Math.abs(
                this.graph.events[this.groups[index]].tick -
                  this.graph.events[this.groups[this.anchor]].tick,
              ),
              disruptive =
                this.anchorTime !== null &&
                (index < this.anchor || jump > this.graph.quarter * 2);
            let commit = !disruptive;
            if (disruptive) {
              if (
                this.pending >= 0 &&
                Math.abs(index - this.pending) <= 10 &&
                time - this.pendingAt >= 70
              ) {
                this.pendingCount++;
                this.pendingAt = time;
              } else if (
                this.pending < 0 ||
                Math.abs(index - this.pending) > 10
              ) {
                this.pendingCount = 1;
                this.pendingAt = time;
              }
              this.pending = index;
              commit = this.pendingCount >= 2;
            }
            if (commit) {
              const backwards = index < this.anchor;
              if (index !== this.anchor || this.anchorTime === null) {
                this.anchor = index;
                this.anchorTime = time;
              }
              this.pending = -1;
              this.pendingCount = 0;
              const e = this.graph.events[this.groups[this.anchor]],
                confidence = this.confidence();
              this.prediction.confirm(
                e.tick,
                time,
                this.graph.quarter,
                t.period,
              );
              this.position = {
                eventIndex: this.groups[this.anchor],
                tick: backwards ? e.tick : Math.max(e.tick, this.position.tick),
                measure: e.measure,
                occurrence: e.occurrence,
                tempo: 60 / t.period,
                confidence,
                status: confidence >= 0.5 ? "FOLLOWING" : "LOST",
                similarity: confidence,
              };
            }
          }
      }
      return this.advance(o.timeMs, o.active);
    }
    advance(now, active) {
      if (this.locator && !this.recovery)
        return (this.position = {
          ...this.position,
          status: "LOCATING",
          confidence: 0,
        });
      const t = this.tracker;
      if (!t || this.anchorTime === null) return this.position;
      const confidence = this.confidence();
      if (!active) {
        if (this.quiet === null) this.quiet = now;
        return (this.position = { ...this.position, status: "WAITING" });
      }
      if (this.pending >= 0 || confidence < 0.5)
        return (this.position = {
          ...this.position,
          status: this.pending >= 0 ? "LOCATING" : "LOST",
          confidence: Math.min(0.49, confidence),
        });
      const e = this.graph.events[this.groups[this.anchor]],
        next = this.graph.events[this.groups[this.anchor + 1]],
        cap = next ? next.tick + this.graph.quarter / 2 : this.graph.endTick,
        predicted = Math.trunc(
          Math.max(
            e.tick,
            Math.min(
              cap,
              e.tick +
                (Math.max(0, now - this.anchorTime) * this.graph.quarter) /
                  (1000 * this.prediction.period),
            ),
          ),
        );
      return (this.position = {
        ...this.position,
        tick: Math.max(this.position.tick, predicted),
        confidence,
        status: "FOLLOWING",
        tempo: 60 / this.prediction.period,
        anticipatedNotes: [
          ...new Set(
            this.groups
              .slice(this.anchor + 1, this.anchor + 3)
              .flatMap((i) => this.graph.events[i].pitches),
          ),
        ],
      });
    }
  }
  Object.assign(g.ScoreFollowCore, { ScoreFollower, Locator, graph });
  if (typeof module !== "undefined") module.exports = g.ScoreFollowCore;
})(globalThis);
