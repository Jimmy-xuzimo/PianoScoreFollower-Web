const { chromium } = require("playwright");
const fs = require("node:fs");
(async () => {
  const browser = await chromium.launch({
    ...(process.env.CI ? {} : { channel: "chrome" }),
    headless: true,
  });
  try {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
    });
    await context.addInitScript(() => {
      window.__frames = [];
      const Base = window.Worker;
      window.Worker = class extends Base {
        constructor(...args) {
          super(...args);
          this.addEventListener("message", (e) => {
            if (e.data.kind === "frame") window.__frames.push(e.data);
          });
        }
      };
      const input = {
        id: "test-piano",
        name: "Virtual piano (test)",
        state: "connected",
        open: async () => {},
        onmidimessage: null,
      };
      window.__midiInput = input;
      Object.defineProperty(navigator, "requestMIDIAccess", {
        value: async () => ({
          inputs: new Map([[input.id, input]]),
          outputs: new Map(),
          onstatechange: null,
        }),
      });
    });
    const page = await context.newPage(),
      errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(process.env.PSF_BASE_URL || "http://127.0.0.1:8767/");
    await page.locator("#btn-empty-samples").click();
    await page.locator('[data-sample="1"]').click();
    await page.frameLocator("#viewer").locator("#score svg").first().waitFor();
    await page.locator("#mic-tab").click();
    await page.locator("#assessment-enabled").check();
    await page.locator("#midi-section > summary").click();
    await page.locator("#midi-connect").click();
    await page.locator("#midi-record").click();
    const score = await page
      .frames()
      .find((f) => f.url().includes("scoreviewer/index.html"))
      .evaluate(() => PianoScoreViewer.exportGraph());
    const events = score.bars
        .flatMap((b) => b.events)
        .filter((e) => e.notes.length)
        .slice(0, 8),
      tempo = score.bars[0].tempo;
    let previous = 0;
    for (const e of events) {
      await page.waitForTimeout((((e.tick - previous) / 960) * 60000) / tempo);
      previous = e.tick;
      await page.evaluate((notes) => {
        for (const n of notes)
          __midiInput.onmidimessage({ data: new Uint8Array([144, n, 96]) });
      }, e.notes);
      await page.waitForTimeout(25);
      await page.evaluate((notes) => {
        for (const n of notes)
          __midiInput.onmidimessage({ data: new Uint8Array([128, n, 32]) });
      }, e.notes);
    }
    await page.locator("#midi-record").click();
    await page.locator("#assessment-finish").click();
    await page.waitForTimeout(100);
    const summary = await page.evaluate(() => ({
      frames: __frames.length,
      last: __frames.at(-1)?.follow,
      assessment: document.getElementById("assessment-result").textContent,
    }));
    await page.locator("#btn-follow").click();
    const savedPosition = await page.evaluate(
      async () => (await PianoLibrary.listNotation())[0].tick,
    );
    if (!(savedPosition > 960)) throw Error("Practice position was not saved");
    summary.savedPosition = savedPosition;
    await page.locator("#midi-save").click();
    await page.frameLocator("#viewer").locator("#score svg").first().waitFor();
    await page.waitForTimeout(500);
    await page.locator("#btn-more").click();
    const downloaded = page.waitForEvent("download");
    await page.locator("#more-export-original").click();
    const download = await downloaded;
    if (!download.suggestedFilename().endsWith(".mid"))
      throw Error("Raw MIDI export extension");
    summary.exportedMidi = true;
    const records = await page.evaluate(async () => {
      const db = await PianoLibrary.open();
      return await new Promise((resolve, reject) => {
        const r = db.transaction("notation").objectStore("notation").getAll();
        r.onsuccess = () =>
          resolve(
            r.result.map((x) => ({
              name: x.name,
              rawBytes: x.originalBlob?.size,
            })),
          );
        r.onerror = reject;
      });
    });
    console.log(JSON.stringify({ ...summary, records, errors }));
    fs.writeFileSync(
      "shots/midi-result.json",
      JSON.stringify({ ...summary, records, errors }, null, 2),
    );
    if (
      errors.length ||
      summary.last.cursorTick <= 960 ||
      !records.some((r) => r.name.startsWith("钢琴录制") && r.rawBytes > 22)
    )
      throw Error("MIDI integration failed");
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
