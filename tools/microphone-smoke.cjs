const { chromium } = require("playwright");
const path = require("node:path"),
  fs = require("node:fs");
(async () => {
  const browser = await chromium.launch({
    ...(process.env.CI ? {} : { channel: "chrome" }),
    headless: true,
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      "--autoplay-policy=no-user-gesture-required",
      "--use-file-for-fake-audio-capture=" +
        path.resolve("tools/fixtures/audio.wav"),
    ],
  });
  try {
    const context = await browser.newContext({
      permissions: ["microphone"],
      viewport: { width: 1280, height: 800 },
    });
    await context.addInitScript(() => {
      window.__frames = [];
      const Base = window.Worker;
      window.Worker = class extends Base {
        constructor(...args) {
          super(...args);
          this.addEventListener("message", (e) => {
            if (e.data.kind === "frame" && e.data.follow)
              window.__frames.push(e.data);
            if (e.data.kind === "error")
              window.__lastWorkerError = e.data.message;
          });
        }
      };
    });
    const page = await context.newPage(),
      errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(process.env.PSF_BASE_URL || "http://127.0.0.1:8767/");
    await page.locator("#btn-empty-samples").click();
    await page.locator('[data-sample="0"]').click();
    await page.frameLocator("#viewer").locator("#score svg").first().waitFor();
    // The fake microphone starts playing immediately on capture. Warm the model
    // download first, equivalent to a performer waiting for the ready prompt.
    await page.evaluate(async () => {
      const response = await fetch(
        "assets/models/onsets_frames_wavinput_uni.tflite",
        { signal: AbortSignal.timeout(90000) },
      );
      if (!response.ok) throw Error("Model download failed");
      await response.arrayBuffer();
    });
    await page.locator("#mic-tab").click();
    await page.locator("#btn-follow").click();
    await page.waitForFunction(
      () =>
        window.__frames.some((f) => f.follow.cursorTick > 960) ||
        window.__lastWorkerError,
      {},
      { timeout: 45000 },
    );
    await page.waitForTimeout(8000);
    const result = await page.evaluate(() => ({
      frames: __frames.length,
      first: __frames.find((f) => f.follow.cursorTick > 0)?.follow,
      last: __frames.at(-1)?.follow,
      confirmedFollowing: __frames.filter(
        (f) => f.follow.status === "FOLLOWING" && f.follow.confidence > 0.7,
      ).length,
      error: window.__lastWorkerError,
    }));
    fs.writeFileSync(
      "shots/microphone-result.json",
      JSON.stringify({ ...result, pageErrors: errors }, null, 2),
    );
    console.log(JSON.stringify({ ...result, pageErrors: errors }));
    if (
      result.error ||
      errors.length ||
      result.last.cursorTick <= 960 ||
      !result.confirmedFollowing
    )
      throw Error("Microphone pipeline failed");
    await page.locator("#btn-follow").click();
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
