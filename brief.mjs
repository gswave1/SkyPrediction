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

// road.txt: compact, plain-text ranking for Claude to read from the car (web readers truncate big JSON).
// Top 30 spots per event, every spot with coordinates so Claude can re-rank from wherever Gal is.
const ROAD_N = 30;
const lines = [
  "Golden Hour Board — generated " + brief.generated + " (UTC). Hourly 4 AM-9 PM ET.",
  "Columns: score 0-100 | spot | place | lat,lon | drive min FROM HOME (Meredith NH) | sun time | flags | why",
  "Scores under 30 = not worth the drive.",
];
for (const e of brief.events) {
  lines.push("", "## " + e.ev.toUpperCase() + " " + e.when + " (" + e.day + ", ~" + e.time + ")");
  for (const t of (e.all || e.top).slice(0, ROAD_N)) {
    lines.push([t.score, t.name, t.place, t.lat.toFixed(3) + "," + t.lon.toFixed(3), t.drive + " min",
                t.time || "", t.flags.join(", ") || "-", t.why].join(" | "));
  }
}
writeFileSync("road.txt", lines.join("\n") + "\n");

// README.md: same ranking on the repo's front page. The Claude app can only open pages that turned up
// in a web search, and the repo page (github.com/gswave1/SkyPrediction) does; road.txt doesn't.
const et = new Date(brief.generated).toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short", hour: "numeric", minute: "2-digit" });
writeFileSync("README.md", [
  "# Golden Hour Board — live sunset & sunrise ranking",
  "",
  "Updated " + et + " Eastern (hourly, 4 AM–9 PM). Board: https://gswave1.github.io/SkyPrediction/",
  "",
  "Columns: score 0–100 | spot | place | lat,lon | drive min from home (Meredith, NH) | sun time | flags | why. Under 30 = not worth the drive.",
  "",
  "```",
  lines.slice(3).join("\n").trim(),
  "```",
  "",
].join("\n"));

// brief.json stays small (Siri Shortcut + push alert): top 3 only.
for (const e of brief.events) delete e.all;
writeFileSync("brief.json", JSON.stringify(brief, null, 2) + "\n");
console.log(brief.text);
