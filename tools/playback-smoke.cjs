const { chromium } = require("playwright"),
  fs = require("node:fs");
(async () => {
  const b = await chromium.launch({
    ...(process.env.CI ? {} : { channel: "chrome" }),
    headless: true,
  });
  try {
    const p = await b.newPage({ viewport: { width: 390, height: 844 } }),
      errors = [];
    p.on("pageerror", (e) => errors.push(e.message));
    await p.goto(process.env.PSF_BASE_URL || "http://127.0.0.1:8767/");
    await p.locator("#btn-empty-samples").click();
    await p.locator('[data-sample="1"]').click();
    await p.frameLocator("#viewer").locator("#score svg").first().waitFor();
    await p.locator("#bar-handle").click();
    await p.locator("#btn-play").click();
    await p
      .locator('#btn-play[data-state="playing"]')
      .waitFor({ timeout: 30000 });
    await p.waitForTimeout(800);
    const f = p
      .frames()
      .find((f) => f.url().includes("scoreviewer/index.html"));
    const tick = await f.evaluate(() => PianoScoreViewer.getPosition());
    await p.locator("#btn-play").click();
    await p.locator('#btn-play[data-state="idle"]').waitFor();
    await p.locator("#score-options-toggle").click();
    await p.locator("#playback-controls-toggle").click();
    const result = {
      tick,
      paused: true,
      collapsed:
        (await p.locator("#bar-layer").getAttribute("data-hidden")) === "true",
      errors,
    };
    if (tick <= 0 || !result.collapsed || errors.length)
      throw Error(JSON.stringify(result));
    fs.writeFileSync(
      "shots/playback-result.json",
      JSON.stringify(result, null, 2),
    );
    console.log(JSON.stringify(result));
  } finally {
    await b.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
