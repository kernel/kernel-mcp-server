import { chromium } from "playwright";

const authMode = process.argv.includes("--auth");
const qaBaseUrl = process.env.QA_BASE_URL ?? "http://localhost:3003";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1000, height: 1500 } });
page.on("pageerror", (error) => console.log("[pageerror]", error.message));
const logText = () => page.locator("#log").textContent();

if (authMode) {
  let failure;
  try {
    await page.goto(`${qaBaseUrl}/qa/auth`);
    await page.fill("#profile", `mcp-auth-qa-${Date.now()}`);
    await page.click("#start");
    await page.waitForFunction(
      () => {
        const text = document.getElementById("log").textContent;
        return (
          text.includes("Secure App resource rendered") ||
          text.includes("ERROR")
        );
      },
      null,
      { timeout: 60000 },
    );
    if ((await logText()).includes("ERROR")) {
      throw new Error(`Auth QA launcher failed:\n${await logText()}`);
    }

    const exchangeResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname.endsWith("/exchange") &&
        response.request().method() === "POST",
      { timeout: 120000 },
    );
    const retrieveResponse = page.waitForResponse(
      (response) =>
        /^\/managed-auth-proxy\/auth\/connections\/[^/]+$/.test(
          new URL(response.url()).pathname,
        ) && response.request().method() === "GET",
      { timeout: 120000 },
    );

    const app = page.frameLocator("#view");
    await app.getByRole("button", { name: /continue/i }).click();
    await page.waitForFunction(
      () => {
        const text = document.getElementById("log").textContent;
        return (
          text.includes("Managed-auth connection ready") ||
          text.includes("ERROR")
        );
      },
      null,
      { timeout: 120000 },
    );
    if ((await logText()).includes("ERROR")) {
      throw new Error(`Auth QA begin failed:\n${await logText()}`);
    }

    const [exchange, retrieve] = await Promise.all([
      exchangeResponse,
      retrieveResponse,
    ]);
    if (!exchange.ok() || !retrieve.ok()) {
      throw new Error(
        `Managed-auth relay failed: exchange=${exchange.status()} retrieve=${retrieve.status()}`,
      );
    }
    await page.screenshot({
      path: "/tmp/qa-managed-auth-app.png",
      fullPage: true,
    });
    console.log(
      `--- managed-auth QA ---\n${await logText()}relay exchange=${exchange.status()} retrieve=${retrieve.status()}\n`,
    );
  } catch (error) {
    failure = error;
  } finally {
    if (
      await page
        .locator("#cleanup")
        .isEnabled()
        .catch(() => false)
    ) {
      await page.click("#cleanup");
      await page.waitForFunction(
        () => document.getElementById("log").textContent.includes("deleted"),
        null,
        { timeout: 60000 },
      );
    }
  }
  if (failure) throw failure;
} else {
  await page.goto(`${qaBaseUrl}/qa`);
  await page.click("#start");
  await page.waitForFunction(
    () => {
      const text = document.getElementById("log").textContent;
      return text.includes("view rendered") || text.includes("ERROR");
    },
    null,
    { timeout: 180000 },
  );
  console.log("--- after start ---\n" + (await logText()));

  await page.waitForTimeout(10000);
  await page.screenshot({ path: "/tmp/qa-1-rendered.png", fullPage: true });

  await page.click("#navigate");
  await page.waitForFunction(
    () => {
      const text = document.getElementById("log").textContent;
      return text.includes("navigated") || text.split("ERROR").length > 1;
    },
    null,
    { timeout: 120000 },
  );
  await page.waitForTimeout(5000);
  await page.screenshot({ path: "/tmp/qa-2-navigated.png", fullPage: true });
  console.log("--- after navigate ---\n" + (await logText()));

  await page.click("#cleanup");
  await page.waitForFunction(
    () =>
      document.getElementById("log").textContent.includes("browser deleted"),
    null,
    { timeout: 60000 },
  );
  console.log("--- after cleanup ---\n" + (await logText()));
}

await browser.close();
