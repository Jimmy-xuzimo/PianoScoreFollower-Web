const { chromium } = require("playwright");
const fs = require("node:fs");
(async () => {
  const browser = await chromium.launch({
    ...(process.env.CI ? {} : { channel: "chrome" }),
    headless: true,
  });
  try {
    const page = await browser.newPage({
      viewport: { width: 1280, height: 800 },
    });
    let errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("response", (r) => {
      if (r.status() >= 400) console.log("HTTP", r.status(), r.url());
    });
    await page.goto(process.env.PSF_BASE_URL || "http://127.0.0.1:8767/");
    await page.locator("#btn-empty-samples").click();
    await page
      .locator('[data-sample="' + (process.argv[2] || 1) + '"]')
      .click();
    await page
      .waitForFunction(
        () => !document.querySelector("#loading-chip").hidden === false,
        {},
        { timeout: 30000 },
      )
      .catch(() => {});
    const frame = page.frameLocator("#viewer");
    await frame.locator("#score svg").first().waitFor({ timeout: 30000 });
    await page.locator("#notation-toggle").click();
    await frame.locator("#numbered:not([hidden])").waitFor();
    await page.screenshot({ path: "shots/rebuild-desktop.png" });
    console.log(
      JSON.stringify({
        errors,
        text: await page.locator("body").innerText(),
        numbered: await frame.locator(".numbered-system").count(),
      }),
    );
    if (errors.length) throw Error(errors.join(";"));
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
