const test = require("node:test"),
  assert = require("node:assert/strict");
require("../js/core/tempo-pitch.js");
const { ScoreFollower } = require("../js/core/score-follower.js");
const Assessment = require("../js/core/assessment.js");
const { encode } = require("../js/core/midi-recording.js");
const graph = (...notes) => ({
  quarter: 960,
  endTick: notes.length * 960,
  events: notes.map((n, i) => ({
    tick: i * 960,
    duration: 960,
    measure: Math.floor(i / 4),
    occurrence: 0,
    pitches: [n],
    tempo: 120,
  })),
});
const note = (t, n) => ({
  timeMs: t,
  pitches: Float32Array.from({ length: 128 }, (_, i) => (i === n ? 1 : 0)),
  isAttack: true,
  active: true,
  exact: true,
});
test("silence never advances the confirmed cursor", () => {
  const f = new ScoreFollower(graph(60, 62, 64));
  f.accept(note(1000, 60));
  const tick = f.position.tick;
  for (let i = 0; i < 100; i++)
    assert.equal(f.advance(1100 + i * 100, false).tick, tick);
});
test("one wrong note does not jump backwards", () => {
  const f = new ScoreFollower(graph(60, 62, 64, 65, 67));
  f.accept(note(1000, 60));
  f.accept(note(1500, 62));
  const tick = f.position.tick;
  f.accept(note(1750, 61));
  assert.ok(f.position.tick >= tick);
  f.accept(note(2000, 64));
  assert.equal(f.position.eventIndex, 2);
});
test("a pause does not permanently reduce tempo", () => {
  const f = new ScoreFollower(graph(60, 62, 64, 65));
  f.accept(note(1000, 60));
  f.advance(1300, false);
  f.accept(note(6000, 62));
  f.accept(note(6500, 64));
  assert.equal(f.position.eventIndex, 2);
  assert.ok(f.position.tempo > 110);
});
test("identical repetitions stay ambiguous when finding an unknown start", () => {
  const f = new ScoreFollower(
    graph(...Array.from({ length: 12 }, () => [60, 62, 64, 65]).flat()),
    0,
    true,
  );
  [60, 62, 64, 65, 60, 62, 64, 65].forEach((n, i) =>
    f.accept(note(1000 + i * 500, n)),
  );
  assert.equal(f.position.status, "LOCATING");
  assert.equal(f.position.tick, 0);
});
test("predicted notes do not count as played notes", () => {
  const g = graph(60, 62, 64),
    a = new Assessment(g);
  const o = note(1000, 60);
  a.observe(o, { eventIndex: 0, tempo: 120, confidence: 1 });
  assert.equal(a.snapshot().correct, 1);
  assert.equal(a.snapshot().pending, 2);
  assert.equal(a.finish().missed, 2);
});
test("each expected note contributes equally to pitch and rhythm score", () => {
  const g = graph(60, 62, 64),
    a = new Assessment(g);
  [60, 62, 64].forEach((n, i) =>
    a.observe(note(1000 + i * 500, n), {
      eventIndex: i,
      tempo: 120,
      confidence: 1,
    }),
  );
  assert.equal(a.finish().score, 100);
});
test("MIDI writer keeps velocity, channel and sustain bytes with source time", () => {
  const bytes = encode([
    { time: 0, bytes: [0x92, 60, 101] },
    { time: 500, bytes: [0xb2, 64, 127] },
    { time: 1000, bytes: [0x82, 60, 34] },
    { time: 1200, bytes: [0xb2, 64, 0] },
  ]);
  assert.equal(Buffer.from(bytes).toString("ascii", 0, 4), "MThd");
  assert.ok(Buffer.from(bytes).includes(Buffer.from([0x92, 60, 101])));
  assert.ok(Buffer.from(bytes).includes(Buffer.from([0xb2, 64, 127])));
  assert.equal(new DataView(bytes.buffer).getUint32(18), bytes.length - 22);
});
