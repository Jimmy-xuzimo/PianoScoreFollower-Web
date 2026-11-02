const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const at = require("../assets/alphatab/alphaTab.min.js");
const exporter = require("../assets/scoreviewer/graph.js");
const numbered = require("../assets/scoreviewer/numbered.js");
test("Jianpu respects key signature, accidentals and octave", () => {
  assert.deepEqual(numbered.pitch(60, 0), {
    digit: 1,
    accidental: "",
    octave: 0,
  });
  assert.deepEqual(numbered.pitch(48, 0), {
    digit: 1,
    accidental: "",
    octave: -1,
  });
  assert.deepEqual(numbered.pitch(72, 0), {
    digit: 1,
    accidental: "",
    octave: 1,
  });
  assert.deepEqual(numbered.pitch(61, 0), {
    digit: 1,
    accidental: "♯",
    octave: 0,
  });
  assert.deepEqual(numbered.pitch(70, -1), {
    digit: 4,
    accidental: "",
    octave: 0,
  }); // Bb in F
  assert.deepEqual(numbered.pitch(66, 1), {
    digit: 7,
    accidental: "",
    octave: -1,
  }); // F# in G
});
test("Jianpu durations preserve dotted, short, long and tuplets", () => {
  assert.equal(numbered.rhythm(480, 960).lines, 1);
  assert.equal(numbered.rhythm(240, 960).lines, 2);
  assert.equal(numbered.rhythm(1440, 960).dots, 1);
  assert.equal(numbered.rhythm(3840, 960).dashes, 3);
  assert.equal(numbered.rhythm(320, 960).irregular, true);
});
test("both hands retain exact durations without duplicating sustained notes", () => {
  const score = at.importer.ScoreLoader.loadScoreFromBytes(
    fs.readFileSync("assets/samples/c_major_study.musicxml"),
  );
  const graph = exporter.build(at, score, [0], [0, 1]);
  graph.selectedStaffs = [0, 1];
  const model = numbered.model(graph, score);
  assert.equal(model.length, 32);
  assert.equal(model[0].lanes.length, 2);
  const left = model[0].lanes.find((l) => l.staff === 1);
  assert.equal(left.cells[0].end - left.cells[0].start, 1920);
  assert.equal(left.cells[0].notes.length, 1);
  assert.equal(left.cells[0].notes[0].pitch, 48);
  const repeated = numbered.model(
    {
      ...graph,
      bars: graph.bars.concat(graph.bars.map((b) => ({ ...b, occurrence: 1 }))),
    },
    score,
  );
  assert.equal(repeated.length, 32);
});

test("systems keep consecutive bars together and reflow at musical boundaries", () => {
  const score = at.importer.ScoreLoader.loadScoreFromBytes(
    fs.readFileSync("assets/samples/c_major_study.musicxml"),
  );
  const graph = exporter.build(at, score, [0], [0, 1]);
  graph.selectedStaffs = [0, 1];
  const bars = numbered.model(graph, score);
  const wide = numbered.systems(bars, 1100, 960),
    phone = numbered.systems(bars, 320, 960);
  assert.equal(wide[0].length, 4);
  assert.equal(phone[0].length, 1);
  assert.deepEqual(
    wide.flat().map((e) => e.bar.index),
    bars.map((b) => b.index),
  );
  assert.deepEqual(numbered.points(bars[0], 960), [0, 960, 1920, 2880, 3840]);
  // The half-note left-hand attack shares exactly the first right-hand column.
  const rh = bars[0].lanes.find((l) => l.staff === 0),
    lh = bars[0].lanes.find((l) => l.staff === 1);
  assert.equal(rh.cells[0].start, lh.cells[0].start);
  assert.equal(lh.cells[0].end, 1920);
});
