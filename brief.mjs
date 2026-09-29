// Loads the board headless, lets it pull Open-Meteo exactly as it does on the phone,
// then writes brief.txt (for Siri) and brief.json (for the push alert).
import { chromium } from "playwright";
import { writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";

const DRIVE = Number(process.env.BRIEF_DRIVE || 120);
const html = readFileSync("index.html");
const server = createServer((req, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end(html); })
  .listen(8765);

const browser = await chromium.launch();
const page = await browser.newPage({ timezoneId: "America/New_York" });
await page.addInitScript(d => { try { localStorage.setItem("ghb.ui", JSON.stringify({ drive: d })); } catch (e) {} }, DRIVE);
page.on("console", m => { if (m.type() === "error") console.log("page:", m.text()); });
await page.goto("http://127.0.0.1:8765/", { waitUntil: "domcontentloaded" });

const ready = () => page.waitForFunction(() => typeof MODEL !== "undefined" && MODEL && !loading, null, { timeout: 240000 });
// A single Open-Meteo request timing out (net::ERR_TIMED_OUT) leaves the board waiting forever.
// Reload once and try again before giving up.
try { await ready(); }
catch (e) {
  console.log("Board didn't finish loading (" + e.name + "); reloading once");
  await page.waitForTimeout(30000);
  await page.reload({ waitUntil: "domcontentloaded" });
  await ready();
}
if (await page.evaluate(() => !!MODEL.trimmedFrom)) {
  console.log("Open-Meteo per-minute allowance hit; waiting 65 s for the rest");
  await page.waitForTimeout(65000);
  await page.evaluate(() => load(true));
  await page.waitForTimeout(1000);
  await ready();
}
const brief = await page.evaluate(d => ghbBrief(d), DRIVE);
await browser.close(); server.close();
if (!brief || !brief.events.length) { console.error("No brief produced"); process.exit(1); }
writeFileSync("brief.txt", brief.text + "\n");
writeFileSync("brief.json", JSON.stringify(brief, null, 2) + "\n");
console.log(brief.text);
