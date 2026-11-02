const { chromium } = require("playwright"),
  fs = require("node:fs");
(async () => {
  const b = await chromium.launch({
    ...(process.env.CI ? {} : { channel: "chrome" }),
    headless: true,
  });
  const rows = [];
  try {
    async function pageFor(stub) {
      const p = await b.newPage({ viewport: { width: 390, height: 844 } });
      const errors = [];
      p.on("pageerror", (e) => errors.push(e.message));
      await p.addInitScript(
        ({ stub }) => {
          window.__captures = 0;
          window.__tracks = [];
          const native = navigator.mediaDevices.getUserMedia.bind(
            navigator.mediaDevices,
          );
          navigator.mediaDevices.getUserMedia = async () => {
            __captures++;
            if (stub === "denied")
              throw new DOMException("denied", "NotAllowedError");
            if (stub === "late")
              return new Promise(
                (r) =>
                  (window.__resolveCapture = () => {
                    const track = {
                      readyState: "live",
                      stop() {
                        this.readyState = "ended";
                      },
                    };
                    __tracks.push(track);
                    r({ getTracks: () => [track] });
                  }),
              );
            return native({ audio: true });
          };
          if (stub && window === window.top) {
            window.Worker = class {
              postMessage(m) {
                if (m.type === "prepareModel")
                  setTimeout(
                    () =>
                      this.onmessage?.({
                        data: { kind: "modelReady", generation: m.generation },
                      }),
                    20,
                  );
              }
              terminate() {}
            };
          }
        },
        { stub },
      );
      await p.goto(process.env.PSF_BASE_URL || "http://127.0.0.1:8767/");
      await p.locator("#btn-empty-samples").click();
      await p.locator('[data-sample="1"]').click();
      await p.frameLocator("#viewer").locator("#score svg").first().waitFor();
      await p.locator("#mic-tab").click();
      return { p, errors };
    }
    for (const name of [
      "download-failure",
      "cancel-preparing",
      "denied",
      "late",
    ]) {
      const { p, errors } = await pageFor(
        ["denied", "late"].includes(name) ? name : null,
      );
      let release, requested;
      if (name === "download-failure")
        await p.route("**/*.tflite", (r) =>
          r.fulfill({ status: 503, body: "unavailable" }),
        );
      if (name === "cancel-preparing") {
        await p.route("**/*.tflite", async (r) => {
          await new Promise((done) => (release = done));
          await r.abort().catch(() => {});
        });
        requested = p.waitForRequest("**/*.tflite");
      }
      await p.locator("#btn-follow").click();
      if (name === "cancel-preparing") {
        await requested;
        await p.locator("#btn-follow").click();
        release();
      }
      if (name === "late") {
        await p.waitForFunction(() => !!window.__resolveCapture);
        await p.locator("#btn-follow").click();
        await p.evaluate(() => __resolveCapture());
      }
      await p.waitForFunction(
        () =>
          document
            .querySelector("#btn-follow")
            .textContent.includes("开始跟谱") &&
          document.getElementById("loading-chip").hidden,
      );
      const result = await p.evaluate(() => ({
        captures: __captures,
        tracksEnded: __tracks.every((t) => t.readyState === "ended"),
        hasRetry: !document.getElementById("btn-follow").disabled,
      }));
      if (
        (name === "download-failure" || name === "cancel-preparing") &&
        result.captures !== 0
      )
        throw Error("Captured before ready");
      if (!result.tracksEnded || !result.hasRetry || errors.length)
        throw Error(JSON.stringify({ name, result, errors }));
      await p.locator("#mic-panel-close").click();
      rows.push({ name, ...result, errors });
      await p.close();
    }
    fs.writeFileSync(
      "shots/lifecycle-result.json",
      JSON.stringify(rows, null, 2),
    );
    console.log(JSON.stringify(rows));
  } finally {
    await b.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
