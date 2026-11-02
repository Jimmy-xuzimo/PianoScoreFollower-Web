const { chromium, devices } = require("playwright"),
  fs = require("node:fs");
(async () => {
  const browser = await chromium.launch({
    ...(process.env.CI ? {} : { channel: "chrome" }),
    headless: true,
  });
  try {
    const results = [];
    for (const [name, options] of [
      [
        "small-phone",
        { ...devices["iPhone SE"], defaultBrowserType: undefined },
      ],
      ["phone", { ...devices["iPhone 13"], defaultBrowserType: undefined }],
      [
        "landscape",
        { ...devices["iPhone 13 landscape"], defaultBrowserType: undefined },
      ],
      ["tablet", { viewport: { width: 1024, height: 768 }, hasTouch: true }],
      ["desktop", { viewport: { width: 1440, height: 900 } }],
    ]) {
      const page = await browser.newPage(options),
        errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto(process.env.PSF_BASE_URL || "http://127.0.0.1:8767/");
      await page.locator("#btn-empty-samples").click();
      await page.locator('[data-sample="1"]').click();
      await page
        .frameLocator("#viewer")
        .locator("#score svg")
        .first()
        .waitFor();
      const scoreFrame = page
        .frames()
        .find((f) => f.url().includes("scoreviewer/index.html"));
      const proportions = await scoreFrame.evaluate(() =>
        [...document.querySelectorAll("#score svg")]
          .filter(
            (s) => s.width.baseVal.value > 0 && s.height.baseVal.value > 0,
          )
          .map((s) => {
            const b = s.getBoundingClientRect();
            return (
              Math.abs(
                b.width / s.width.baseVal.value -
                  b.height / s.height.baseVal.value,
              ) < 0.01
            );
          }),
      );
      if (!proportions.length || proportions.some((p) => !p))
        throw Error("Score was stretched");
      for (let i = 0; i < 3; i++) {
        await page.locator("#mic-tab")[options.hasTouch ? "tap" : "click"]();
        await page
          .locator("#mic-panel-close")
          [options.hasTouch ? "tap" : "click"]({ timeout: 2000 });
        await page.waitForFunction(
          () =>
            document.getElementById("mic-panel").inert &&
            document.getElementById("mic-backdrop").hidden,
        );
      }
      await page.locator("#mic-tab")[options.hasTouch ? "tap" : "click"]();
      await page.keyboard.press("Escape");
      if (
        (await page.locator("#mic-tab").getAttribute("aria-expanded")) !==
        "false"
      )
        throw Error("Escape did not close");
      await page.locator("#mic-tab")[options.hasTouch ? "tap" : "click"]();
      const bounds = await page.locator("#mic-panel").boundingBox();
      if (bounds.width < options.viewport?.width - 5) {
        await page.locator("#mic-backdrop").click({
          position: {
            x: Math.min(bounds.width + 12, options.viewport.width - 2),
            y: 100,
          },
        });
      } else
        await page
          .locator("#mic-panel-close")
          [options.hasTouch ? "tap" : "click"]();
      await page.locator("#mic-tab")[options.hasTouch ? "tap" : "click"]();
      if (!(await page.locator("#btn-follow").isVisible()))
        throw Error("Start control hidden");
      if (await page.locator(".midi-controls").isVisible())
        throw Error("MIDI should be collapsed");
      await page.waitForTimeout(300);
      await page.screenshot({ path: "shots/" + name + "-panel.png" });
      await page
        .locator("#mic-panel-close")
        [options.hasTouch ? "tap" : "click"]();
      await page.waitForTimeout(300);
      const layout = await page.evaluate(() => ({
        width: innerWidth,
        overflow: document.documentElement.scrollWidth > innerWidth + 1,
        toolbarHeight: document
          .querySelector(".performance-controls")
          .getBoundingClientRect().height,
        scoreHeight: document.getElementById("viewer").getBoundingClientRect()
          .height,
        screenHeight: innerHeight,
      }));
      if (
        layout.overflow ||
        (layout.width <= 600 &&
          (layout.toolbarHeight > 48 ||
            layout.scoreHeight < layout.screenHeight - 180))
      )
        throw Error("Cramped layout " + JSON.stringify(layout));
      await page.screenshot({ path: "shots/" + name + "-performance.png" });
      if (layout.width <= 600) {
        await page.locator("#score-options-toggle").click();
        await page.locator("#navigation-mode").selectOption("page");
        await page.locator("#score-options-toggle").click();
      }
      await page.setViewportSize({
        width: options.viewport.height,
        height: options.viewport.width,
      });
      await page.locator("#mic-tab")[options.hasTouch ? "tap" : "click"]();
      await page
        .locator("#mic-panel-close")
        [options.hasTouch ? "tap" : "click"]({ timeout: 2000 });
      if (errors.length) throw Error(errors.join(";"));
      results.push({ name, layout, scoreProportions: true, errors });
      await page.close();
    }
    fs.writeFileSync(
      "shots/panel-result.json",
      JSON.stringify(results, null, 2),
    );
    console.log(JSON.stringify(results));
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
