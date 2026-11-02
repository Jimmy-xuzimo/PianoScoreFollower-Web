const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const at = require("../assets/alphatab/alphaTab.min.js");
const exporter = require("../assets/scoreviewer/graph.js");
test("offline TSV export preserves a tempo change inside a bar", () => {
  const os = require("node:os"),
    path = require("node:path"),
    { execFileSync } = require("node:child_process");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psf-tempo-")),
    source = path.join(dir, "score.musicxml"),
    target = path.join(dir, "graph.tsv");
  const xml =
    '<score-partwise version="3.1"><part-list><score-part id="P"><part-name>Piano</part-name></score-part></part-list><part id="P"><measure number="1"><attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes><direction><direction-type><words>Tempo</words></direction-type><sound tempo="120"/></direction><note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration><type>quarter</type></note><direction><direction-type><words>Slow</words></direction-type><sound tempo="60"/></direction><note><pitch><step>D</step><octave>4</octave></pitch><duration>1</duration><type>quarter</type></note><note><pitch><step>E</step><octave>4</octave></pitch><duration>2</duration><type>half</type></note></measure></part></score-partwise>';
  try {
    fs.writeFileSync(source, xml);
    execFileSync(process.execPath, ["tools/export-graph.cjs", source, target]);
    const lines = fs
      .readFileSync(target, "utf8")
      .split("\n")
      .map((l) => l.split("\t"));
    assert.equal(Number(lines[0][7]), 120);
    assert.equal(Number(lines[1][7]), 60);
  } finally {
    if (fs.existsSync(source)) fs.unlinkSync(source);
    if (fs.existsSync(target)) fs.unlinkSync(target);
    fs.rmdirSync(dir);
  }
});
const load = (path) =>
  at.importer.ScoreLoader.loadScoreFromBytes(fs.readFileSync(path));
test("both hands share their real playback ticks and stay inside the measure", () => {
  const score = load("assets/samples/c_major_study.musicxml");
  const g = exporter.build(at, score, null);
  assert.equal(g.bars.length, 32);
  assert.deepEqual(
    g.bars[0].events[0].notes.sort((a, b) => a - b),
    [48, 72],
  );
  for (const b of g.bars)
    for (const e of b.events) {
      assert.ok(e.tick >= b.start && e.tick < b.end);
      assert.ok(e.duration > 0);
    }
});
test("staff filtering preserves the selected hand", () => {
  const score = load("assets/samples/c_major_study.musicxml");
  const g = exporter.build(at, score, null, [1]);
  assert.deepEqual(g.bars[0].events[0].notes, [48]);
  assert.ok(
    g.bars
      .flatMap((b) => b.events)
      .flatMap((e) => e.voices)
      .every((v) => v.staff === 1),
  );
});
test("repeat occurrences have separate playback ticks but the same printed bars", () => {
  const xml =
    '<score-partwise version="3.1"><part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list><part id="P1"><measure number="1"><attributes><divisions>1</divisions><time><beats>1</beats><beat-type>4</beat-type></time></attributes><barline location="left"><repeat direction="forward"/></barline><note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration><type>quarter</type></note></measure><measure number="2"><note><pitch><step>D</step><octave>4</octave></pitch><duration>1</duration><type>quarter</type></note><barline location="right"><repeat direction="backward" times="2"/></barline></measure></part></score-partwise>';
  const g = exporter.build(
    at,
    at.importer.ScoreLoader.loadScoreFromBytes(Buffer.from(xml)),
    null,
  );
  assert.deepEqual(
    g.bars.map((b) => b.index),
    [0, 1, 0, 1],
  );
  assert.deepEqual(
    g.bars.map((b) => b.occurrence),
    [0, 0, 1, 1],
  );
  assert.deepEqual(
    g.bars.map((b) => b.start),
    [0, 960, 1920, 2880],
  );
});
test("malformed voice timing produces an actionable error", () => {
  const source = fs.readFileSync(
    "assets/samples/c_major_study.musicxml",
    "utf8",
  );
  const invalid = source.replace(/<backup>[\s\S]*?<\/backup>/, "");
  assert.throws(
    () =>
      exporter.build(
        at,
        at.importer.ScoreLoader.loadScoreFromBytes(Buffer.from(invalid)),
        null,
      ),
    /声部时值/,
  );
});
