// No browser or audio engine required. Uses the exact exporter bundled in the APK.
const fs = require("node:fs");
const at = require("../assets/alphatab/alphaTab.min.js");
const graph = require("../assets/scoreviewer/graph.js");
try {
  const score = at.importer.ScoreLoader.loadScoreFromBytes(
    fs.readFileSync(process.argv[2]),
  );
  const result = graph.build(at, score, null);
  if (process.argv[3]?.endsWith(".json"))
    fs.writeFileSync(process.argv[3], JSON.stringify(result));
  else {
    const lines = result.bars.flatMap((b) =>
      b.events.map((e) =>
        [
          e.tick,
          e.duration,
          b.index,
          b.occurrence,
          e.notationTick,
          e.notes.join(","),
          e.sounding.join(","),
          e.tempo,
        ].join("\t"),
      ),
    );
    fs.writeFileSync(process.argv[3], lines.join("\n"));
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
