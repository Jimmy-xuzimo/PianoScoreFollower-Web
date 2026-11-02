/* UI timeline adapter. Alignment lives in core/score-follower.js; navigation is
 * owned by the shared Android score renderer, not a second competing pager. */
(function (g) {
  "use strict";
  class ScoreTimeline {
    constructor(quarter, events, endTick, bars) {
      this.ticksPerQuarter = quarter;
      this.events = events;
      this.endTick = endTick;
      this.bars = bars;
      this.measureCount = bars.length;
    }
    isEmpty() {
      return !this.events.length;
    }
    secondsPerQuarter(bpm) {
      return 60 / bpm;
    }
    progressInMeasure(measure, tick) {
      const b = this.bars.find(
        (b) => b.index === measure && tick >= b.start && tick <= b.end,
      );
      return b
        ? Math.max(0, Math.min(1, (tick - b.start) / (b.end - b.start)))
        : 0;
    }
  }
  ScoreTimeline.EMPTY = new ScoreTimeline(960, [], 0, []);
  const PageTurnReason = { NONE: "NONE", ADVANCE: "ADVANCE", REWIND: "REWIND" };
  class PageTurnController {
    reset() {}
    onManualPage() {}
    onCursor() {
      return { reason: PageTurnReason.NONE, targetPage: -1 };
    }
  }
  function buildTimeline(structure) {
    const bars = structure.bars || [],
      events = bars.flatMap((b) =>
        b.events.map((e) => ({
          ...e,
          midiNotes: e.notes,
          measure: b.index,
          occurrence: b.occurrence || 0,
        })),
      );
    return new ScoreTimeline(
      structure.ticksPerQuarter || 960,
      events,
      Math.max(0, ...bars.map((b) => b.end)),
      bars,
    );
  }
  g.PianoFollower = {
    ScoreTimeline,
    PageTurnReason,
    PageTurnController,
    buildTimeline,
  };
})(globalThis);
