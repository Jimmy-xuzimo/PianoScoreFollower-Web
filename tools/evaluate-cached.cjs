const fs = require("node:fs"),
  path = require("node:path");
require("../js/core/tempo-pitch.js");
const { ScoreFollower } = require("../js/core/score-follower.js");
for (const folder of fs
  .readFileSync(process.argv[2], "utf8")
  .trim()
  .split(/\r?\n/)) {
  const rows = fs
    .readFileSync(path.join(folder, "graph.tsv"), "utf8")
    .trim()
    .split(/\r?\n/)
    .map((l) => l.split("\t"));
  const events = rows.map((p) => ({
      tick: +p[0],
      duration: +p[1],
      measure: +p[2],
      occurrence: +p[3],
      notationTick: +p[4],
      pitches: p[5] ? p[5].split(",").map(Number) : [],
      tempo: +p[7],
    })),
    graph = {
      events,
      quarter: 960,
      endTick: events.at(-1).tick + events.at(-1).duration,
    },
    follower = new ScoreFollower(graph);
  const raw = fs.readFileSync(
      path.join(folder, "magenta-linear.notes.frames.bin"),
    ),
    shift = raw.toString("utf8", 0, 4) === "NPF1" ? 64 : 0,
    pcm = fs.readFileSync(path.join(folder, "audio.f32"));
  let next = 4,
    samples = 0,
    active = false,
    db = -72,
    trace = [];
  for (let offset = 0; offset + 4096 <= pcm.length; offset += 4096) {
    samples += 1024;
    const now = Math.floor((samples * 1000) / 44100);
    let attack = false;
    while (
      next + 1040 <= raw.length &&
      Number(raw.readBigInt64LE(next + 8)) <= now
    ) {
      const onset = Number(raw.readBigInt64LE(next)) - shift,
        available = Number(raw.readBigInt64LE(next + 8)),
        pitches = Float32Array.from({ length: 128 }, (_, n) =>
          raw.readFloatLE(next + 16 + n * 4),
        ),
        attacks = Float32Array.from({ length: 128 }, (_, n) =>
          raw.readFloatLE(next + 528 + n * 4),
        ),
        isAttack = attacks.some((x) => x >= 0.5);
      active = isAttack || pitches.some((x) => x >= 0.5);
      attack = attack || isAttack;
      follower.accept({
        timeMs: available,
        pitches,
        attacks,
        isAttack,
        active,
        analysisLatencyMs: available - onset,
      });
      next += 1040;
    }
    let sum = 0;
    for (let n = 0; n < 1024; n++) {
      const x = pcm.readFloatLE(offset + n * 4);
      sum += x * x;
    }
    const level = Math.max(-72, 10 * Math.log10(Math.max(1e-18, sum / 1024)));
    db += (level - db) * (level > db ? 0.55 : 0.12);
    const p = follower.advance(now, active && db >= -65);
    trace.push(
      [samples / 44100, p.tick, p.confidence, p.status, attack, db].join("\t"),
    );
  }
  fs.writeFileSync(path.join(folder, "web-trace.tsv"), trace.join("\n") + "\n");
  console.log("WEB_REPLAY", path.basename(folder), samples / 44100);
}
