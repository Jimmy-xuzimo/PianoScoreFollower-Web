const fs = require("node:fs"),
  assert = require("node:assert/strict");
const { TempoPitchTracker } = require("../js/core/tempo-pitch.js");
const folder = process.argv[2];
if (!folder) throw Error("Provide Android evaluation case folder");
const rows = fs
  .readFileSync(folder + "/graph.tsv", "utf8")
  .trim()
  .split(/\r?\n/)
  .map((l) => l.split("\t"))
  .filter((p) => p[5]);
const tracker = new TempoPitchTracker(
  rows.map((p) => +p[0] / 960),
  rows.map((p) => p[5].split(",").map(Number)),
  60 / 130,
);
const expected = fs
  .readFileSync(folder + "/magenta-symbolic-full.tsv", "utf8")
  .trim()
  .split(/\r?\n/)
  .slice(1);
const notes = fs
  .readFileSync(folder + "/magenta-full.notes.tsv", "utf8")
  .trim()
  .split(/\r?\n/)
  .slice(1);
notes.forEach((line, i) => {
  const n = line.split("\t"),
    index = tracker.accept(+n[1], +n[2]);
  assert.equal(index, +expected[i].split("\t")[3], "note " + i);
});
console.log(
  "PASS Android/upstream path parity: " + notes.length + " real piano onsets",
);
