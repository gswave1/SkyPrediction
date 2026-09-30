// Loads the board headless, lets it pull Open-Meteo exactly as it does on the phone,
// then writes brief.txt (for Siri) and brief.json (for the push alert).
import { chromium } from "playwright";
import { writeFileSync, mkdirSync } from "node:fs";
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
// Keep every raw Open-Meteo reply (forecast + air quality) exactly as it arrived, for the Box archive.
const RAW = new Map();
const rawJobs = [];
page.on("response", r => {
  const u = r.url();
  if (!/open-meteo\.com\//.test(u) || !r.ok()) return;
  rawJobs.push(r.json().then(j => RAW.set(u, j)).catch(() => {}));
});
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
// Full per-model analysis: every spot, every day, sunset + sunrise + fog, each model's score and
// every input that fed it, plus the lead-time-weighted consensus the board actually ranks on.
let exp = null;
try { exp = await page.evaluate(() => {
  const SN = Object.keys(S).sort((a, b) => S[a] - S[b]);
  const GN = Object.keys(G).sort((a, b) => G[a] - G[b]);
  const light = [], fog = [], per = {};
  for (const sp of SPOTS) {
    const r = MODEL.rows[sp.id]; if (!r) continue;
    const base = { spot_id: sp.id, spot: sp.n, place: sp.s, type: sp.t, lat: sp.lat, lon: sp.lon,
                   drive_min: sp.d, open_arc: sp.az.join("-") };
    MODEL.days.forEach((date, di) => {
      for (const ev of ["sunset", "sunrise"]) {
        const o = r[ev] && r[ev][di]; if (!o) continue;
        const res = resolveAt(sp.id, ev, di);
        const row0 = Object.assign({ date, event: ev }, base, { sun_time: o.t, sun_az: o.az,
          lead_h: res ? +res.lead.toFixed(1) : null, lead_band: res ? res.band.label : null,
          cirrus_300: o.cir ? o.cir[0] : null, cirrus_250: o.cir ? o.cir[1] : null,
          cirrus_200: o.cir ? o.cir[2] : null, rh_300: o.cir ? o.cir[3] : null, cirrus_state: o.cst });
        for (const m of Object.keys(o.m)) {
          const x = Object.assign({}, row0, { model: shortOf(m), weight: res ? weightFor(m, res.lead) : null });
          SN.forEach((k, i) => x[k] = o.m[m][i] ?? null);
          light.push(x);
        }
        if (res) {
          const x = Object.assign({}, row0, { model: "CONSENSUS", weight: null });
          SN.forEach((k, i) => x[k] = res.v[i] == null ? null : +(+res.v[i]).toFixed(1));
          x.spread = +res.spread.toFixed(1); x.agreement = agree(res.spread).l;
          x.missing_models = res.miss.join(" ");
          light.push(x);
          per[ev + "|" + date + "|" + sp.id] = res.per.map(p => p.short + " " + Math.round(p.score)).join(" · ") +
            " (spread " + Math.round(res.spread) + ", " + agree(res.spread).l.toLowerCase() + ")";
        }
      }
      const f = r.fog && r.fog[di];
      if (f) for (const m of Object.keys(f.m)) {
        const x = Object.assign({ date, event: "fog" }, base, { sun_time: f.t, model: shortOf(m) });
        GN.forEach((k, i) => x[k] = f.m[m][i] ?? null);
        fog.push(x);
      }
    });
  }
  return { light, fog, per, meta: { generated: new Date(MODEL.generated).toISOString(), models: MODEL.models,
    days: MODEL.days, spots_scored: MODEL.spots, spots_total: SPOTS.length, trimmedFrom: MODEL.trimmedFrom,
    cirrus: MODEL.cirrus, aerosols: MODEL.aq, drive_cover_min: MODEL.cover,
    score_fields: SN, fog_fields: GN } };
}); } catch (e) { console.log("Full export failed (brief still written): " + e.message); }
await Promise.all(rawJobs);
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
// Valley fog: viewpoints above a river valley get their fog odds listed every run, even when their
// sunrise score keeps them out of the top 30 (a fog sea can be the whole shot on a grey sunrise).
const fogRows = [];
for (const e of brief.events) {
  if (e.ev !== "sunrise") continue;
  for (const t of (e.all || [])) {
    const f = t.flags.find(x => x.includes("valley fog"));
    if (f) fogRows.push([f, t.name, t.place, t.lat.toFixed(3) + "," + t.lon.toFixed(3), t.drive + " min",
                         "sunrise " + e.when + " " + (t.time || ""), "sunrise score " + t.score].join(" | "));
  }
}
if (fogRows.length) lines.push("", "## VALLEY FOG (river fog below the viewpoint, at sunrise)", ...fogRows);
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

// out/: the full run for Box (not committed — the Action uploads it and keeps it as a run artifact).
//   LATEST.md          what the car reads first: top 30 per event, each with every model's score
//   ranking-full.txt   every scored spot for the three events, same columns plus the models
//   analysis-models.csv  every spot x day x sunset/sunrise x model (and CONSENSUS): score + all inputs
//   analysis-fog.csv   the fog/valley-fog scores per model
//   run.json           run metadata; raw/ = every Open-Meteo reply exactly as received
if (exp) try {
mkdirSync("out/raw", { recursive: true });
const csv = rows => {
  if (!rows.length) return "";
  const cols = [...rows.reduce((s, r) => { Object.keys(r).forEach(k => s.add(k)); return s; }, new Set())];
  const q = v => v == null ? "" : /[",\n]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : String(v);
  return [cols.join(","), ...rows.map(r => cols.map(c => q(r[c])).join(","))].join("\n") + "\n";
};
const withModels = (e, list) => list.map(t => [t.score, t.name, t.place, t.lat.toFixed(3) + "," + t.lon.toFixed(3),
  t.drive + " min", t.time || "", t.flags.join(", ") || "-", t.why,
  "models: " + (exp.per[e.ev + "|" + e.day + "|" + t.id] || "n/a")].join(" | "));
const carLines = [], fullLines = [];
for (const e of brief.events) {
  const head = ["", "## " + e.ev.toUpperCase() + " " + e.when + " (" + e.day + ", ~" + e.time + ")"];
  carLines.push(...head, ...withModels(e, (e.all || e.top).slice(0, ROAD_N)));
  fullLines.push(...head, ...withModels(e, e.all || e.top));
}
const colsLine = "Columns: score 0-100 (lead-time-weighted consensus) | spot | place | lat,lon | drive min FROM HOME (Meredith NH) | sun time | flags | why | each model's own score + spread";
const models = exp.meta.models.map(m => ({ gem_hrdps_continental: "HRDPS", gfs_seamless: "HRRR", ecmwf_ifs025: "ECMWF" }[m] || m)).join(", ");
const header = [
  "# Golden Hour Board — latest run",
  "",
  "Updated " + et + " Eastern (" + brief.generated + " UTC). Models: " + models + ". Spots scored: " + exp.meta.spots_scored + ".",
  colsLine,
  "Scores under 30 = not worth the drive. Spread = how far apart the models are (tight < 12, mixed < 28, split above).",
  "Full detail in this folder: Latest/ranking-full.txt (every spot), Latest/analysis-models.csv (every model's inputs), Latest/analysis-fog.csv, Archive/ (every run, with raw model data).",
];
writeFileSync("out/LATEST.md", [...header, ...carLines, ...(fogRows.length ? ["", "## VALLEY FOG (river fog below the viewpoint, at sunrise)", ...fogRows] : [])].join("\n") + "\n");
writeFileSync("out/ranking-full.txt", [...header.slice(2), ...fullLines].join("\n") + "\n");
writeFileSync("out/analysis-models.csv", csv(exp.light));
writeFileSync("out/analysis-fog.csv", csv(exp.fog));
writeFileSync("out/run.json", JSON.stringify(Object.assign({}, exp.meta, { brief_generated: brief.generated,
  drive_limit: DRIVE, raw_files: RAW.size }), null, 2) + "\n");
let ri = 0;
for (const [url, body] of RAW) {
  const kind = url.includes("air-quality") ? "airquality" : (url.match(/models=([^&]+)/) || [, "ecmwf"])[1].split(",").length > 1 ? "clouds" : "ecmwf-extra";
  writeFileSync("out/raw/" + String(++ri).padStart(3, "0") + "-" + kind + ".json", JSON.stringify({ url, response: body }));
}
} catch (e) { console.log("Writing out/ failed (brief still written): " + e.message); }
if (exp) console.log("out/: " + exp.light.length + " model rows, " + exp.fog.length + " fog rows, " + RAW.size + " raw replies");

// brief.json stays small (Siri Shortcut + push alert): top 3 only.
for (const e of brief.events) delete e.all;
writeFileSync("brief.json", JSON.stringify(brief, null, 2) + "\n");
console.log(brief.text);
