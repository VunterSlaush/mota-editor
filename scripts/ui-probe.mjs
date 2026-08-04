/* eslint-disable no-console */
// UI probe — drives the demo-mode app in headless Chromium and captures
// screenshots at each interesting state. Run: node scripts/ui-probe.mjs
import { chromium } from "playwright";
import fs from "node:fs";

const OUT = "/tmp/ui-shots";
fs.mkdirSync(OUT, { recursive: true });

const shot = async (page, name) => {
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: false });
  console.log(`shot: ${name}`);
};

const browser = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium",
  args: ["--no-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on("pageerror", (e) => console.log("pageerror:", e.message));

await page.goto("http://127.0.0.1:5199/", { waitUntil: "networkidle" });
await shot(page, "01-empty");

const openBtn = page.getByText(/open.*(folder|project)/i).first();
if (await openBtn.count()) {
  await openBtn.click();
  await page.waitForTimeout(600);
}

const input = page.locator("textarea").first();

// --- Scenario 1: markdown + streaming caret ---
await input.fill("Summarize the project structure");
await input.press("Enter");
await page.waitForTimeout(1300);
await shot(page, "02-streaming-caret");

// --- Scenario 2: queue a message while busy ---
await input.fill("also check the tests");
await input.press("Enter");
await page.waitForTimeout(300);
await shot(page, "03-queued-chip");
console.log("queued chip present:", await page.locator(".queued-item").count());

// wait for turn 1 to finish → queued message should auto-send
await page.waitForTimeout(5500);
await shot(page, "04-queue-drained");
console.log(
  "user messages:",
  await page.locator(".msg--user").count(),
  "| rendered tables:",
  await page.locator(".msg--assistant table").count(),
  "| rendered code blocks:",
  await page.locator(".msg--assistant pre").count(),
  "| queued left:",
  await page.locator(".queued-item").count(),
);

// --- Scenario 3: Esc-to-stop ---
await input.fill("one more thing");
await input.press("Enter");
await page.waitForTimeout(700);
await input.press("Escape");
await page.waitForTimeout(400);
await shot(page, "05-esc-stopped");
console.log(
  "cancelled info shown:",
  (await page.getByText("Turn cancelled").count()) > 0,
);

// --- Scenario 4: autoscroll pins to bottom on long conversation ---
for (let i = 0; i < 2; i++) {
  await input.fill(`describe module ${i}`);
  await input.press("Enter");
  await page.waitForTimeout(5200);
}
const pinned = await page.evaluate(() => {
  const el = document.querySelector(".message-list");
  return el ? el.scrollHeight - el.scrollTop - el.clientHeight < 60 : null;
});
console.log("autoscroll pinned at bottom:", pinned);
await shot(page, "06-autoscroll-bottom");

// scroll up → "Latest" pill should appear and view must stay put
await page.locator(".message-list").evaluate((el) => (el.scrollTop = 0));
await page.waitForTimeout(300);
console.log("jump pill visible:", await page.locator(".jump-to-latest").count());
await shot(page, "07-scrolled-up-pill");

// --- Scenario 5: approval flow still fine ---
await page.locator(".jump-to-latest").click().catch(() => {});
await input.fill("run the tests please");
await input.press("Enter");
await page.waitForTimeout(1500);
await shot(page, "08-approval");
const allow = page.getByText(/allow once/i).first();
if (await allow.count()) await allow.click();
await page.waitForTimeout(4000);
await shot(page, "09-final");

await browser.close();
console.log("done");
