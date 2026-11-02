const { test } = require("node:test");
const assert = require("node:assert/strict");
const { Anchor } = require("../assets/scoreviewer/navigation.js");
test("small corrections inside a line do not constrain the musical cursor", () => {
  const a = new Anchor();
  a.update(5000, 1, 0);
  assert.equal(a.update(4600, 1, 20), 4600);
});
test("temporary corrections across a line edge do not scroll back and forth", () => {
  const a = new Anchor();
  a.update(5000, 1, 0);
  assert.equal(a.update(4600, 0, 20), 5000);
  assert.equal(a.update(4700, 0, 200), 5000);
  assert.equal(a.update(5100, 1, 300), 5100);
  assert.equal(a.update(4700, 0, 400), 5100);
  assert.equal(a.update(4800, 0, 1060), 4800);
});
test("confirmed restarts and notated repeats can immediately navigate backwards", () => {
  const a = new Anchor();
  a.update(30000, 4, 0);
  assert.equal(a.update(3000, 0, 20), 3000);
  a.update(5000, 1, 40);
  assert.equal(a.update(6000, 0, 60), 6000);
});
test("seek relayout and stopping clear pending navigation history", () => {
  const a = new Anchor();
  a.update(5000, 1, 0);
  a.update(4600, 0, 20);
  a.reset(4600, 0);
  assert.equal(a.update(4800, 0, 30), 4800);
  assert.equal(a.update(null, -1, 40), null);
});
