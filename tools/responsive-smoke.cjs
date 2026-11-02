const { chromium } = require("playwright"),
  fs = require("node:fs");
(async () => {
  const browser = await chromium.launch({
    ...(process.env.CI ? {} : { channel: "chrome" }),
    headless: true,
  });
  try {
    const result = [];
    for (const [name, width, height] of [
      ["phone", 393, 852],
      ["tablet", 1024, 768],
      ["desktop", 1440, 900],
    ]) {
      const page = await browser.newPage({ viewport: { width, height } }),
        errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto(process.env.PSF_BASE_URL || "http://127.0.0.1:8767/");
      await page.locator("#btn-empty-samples").click();
      await page.locator('[data-sample="1"]').click();
      const frame = page.frameLocator("#viewer");
      await frame.locator("#score svg").first().waitFor();
      await page.locator("#notation-toggle").click();
      await frame.locator(".numbered-system").first().waitFor();
      await page.waitForTimeout(250);
      await page.screenshot({ path: "shots/" + name + "-numbered.png" });
      const outer = await page.evaluate(() => ({
        overflow: document.documentElement.scrollWidth > innerWidth + 1,
        headerClipped:
          document
            .querySelector("#screen-score > .topbar")
            .getBoundingClientRect().top < -1,
        toolsCoverScore:
          document
            .querySelector(".performance-controls")
            .getBoundingClientRect().bottom >
          document.getElementById("viewer").getBoundingClientRect().top + 1,
      }));
      const inner = await page
        .frames()
        .find((f) => f.url().includes("scoreviewer/index.html"))
        .evaluate(() => ({
          overflow: document.documentElement.scrollWidth > innerWidth + 1,
          labels:
            document.getElementById("numbered").innerText.includes("右手") ||
            document.getElementById("numbered").innerText.includes("左手"),
        }));
      await page.locator("#focus-toggle").click();
      await page.screenshot({ path: "shots/" + name + "-focus.png" });
      await page.locator("#focus-toggle").click();
      await page.locator("#btn-settings").click();
      await page.getByText("智能琴谱 Web 1.0 · 关于与开源").waitFor();
      result.push({ name, outer, inner, errors });
      if (
        outer.overflow ||
        outer.headerClipped ||
        outer.toolsCoverScore ||
        inner.overflow ||
        inner.labels ||
        errors.length
      )
        throw Error(JSON.stringify(result));
      await page.close();
    }
    fs.writeFileSync(
      "shots/responsive-result.json",
      JSON.stringify(result, null, 2),
    );
    console.log(JSON.stringify(result));
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
