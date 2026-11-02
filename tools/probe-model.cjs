const { chromium } = require("playwright");
(async () => {
  const browser = await chromium.launch({
    ...(process.env.CI ? {} : { channel: "chrome" }),
    headless: true,
  });
  try {
    const page = await browser.newPage();
    page.on("response", (r) => {
      if (r.status() >= 400) console.log("HTTP", r.status(), r.url());
    });
    page.on("request", (r) => {
      if (!r.url().startsWith("http://127.0.0.1"))
        console.log("EXTERNAL", r.url());
    });
    page.on("console", (m) => console.log(m.type(), m.text().slice(0, 300)));
    await page.goto(
      "http://127.0.0.1:8767/tools/" + (process.argv[2] || "model-probe.html"),
    );
    await page.waitForFunction(
      () => result.status !== "loading",
      {},
      { timeout: 120000 },
    );
    console.log(JSON.stringify(await page.evaluate(() => result)));
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
