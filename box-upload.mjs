// Uploads the run in out/ to Box: Photography › Apps › SkyPrediction
//   LATEST.md            overwritten each run (new Box version) — the car reads this first
//   Latest/…             ranking-full.txt, analysis-models.csv, analysis-fog.csv, run.json
//   Archive/YYYY-MM-DD/HHMM/…  the whole run, including raw/ Open-Meteo replies
// Auth: a Box "Server Authentication (Client Credentials Grant)" app, acting as Gal's own user.
// GitHub secrets: BOX_CLIENT_ID, BOX_CLIENT_SECRET, BOX_USER_ID. Skips quietly if they're missing.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const { BOX_CLIENT_ID: id, BOX_CLIENT_SECRET: secret, BOX_USER_ID: user } = process.env;
const ROOT = process.env.BOX_FOLDER_ID || "422966754478";   // Photography/Apps/SkyPrediction
if (!id || !secret || !user) { console.log("Box secrets not set — skipping Box upload."); process.exit(0); }

const tok = await fetch("https://api.box.com/oauth2/token", { method: "POST",
  body: new URLSearchParams({ grant_type: "client_credentials", client_id: id, client_secret: secret,
                              box_subject_type: "user", box_subject_id: user }) }).then(r => r.json());
if (!tok.access_token) { console.error("Box auth failed:", JSON.stringify(tok)); process.exit(1); }
const H = { authorization: "Bearer " + tok.access_token };

async function folder(parent, name) {
  const r = await fetch("https://api.box.com/2.0/folders", { method: "POST", headers: { ...H, "content-type": "application/json" },
    body: JSON.stringify({ name, parent: { id: parent } }) });
  const j = await r.json();
  if (r.ok) return j.id;
  const c = j.context_info && j.context_info.conflicts;
  if (r.status === 409 && c) return (Array.isArray(c) ? c[0] : c).id;
  throw new Error("folder " + name + ": " + r.status + " " + JSON.stringify(j));
}
async function put(parent, name, path) {
  const data = new Blob([readFileSync(path)]);
  const form = () => { const f = new FormData(); f.append("attributes", JSON.stringify({ name, parent: { id: parent } })); f.append("file", data, name); return f; };
  let r = await fetch("https://upload.box.com/api/2.0/files/content", { method: "POST", headers: H, body: form() });
  if (r.status === 409) {                       // already there: upload a new version of it
    const fid = (await r.json()).context_info.conflicts.id;
    const f = new FormData(); f.append("attributes", JSON.stringify({ name })); f.append("file", data, name);
    r = await fetch("https://upload.box.com/api/2.0/files/" + fid + "/content", { method: "POST", headers: H, body: f });
  }
  if (!r.ok) throw new Error("upload " + name + ": " + r.status + " " + (await r.text()).slice(0, 300));
}
async function putDir(parent, dir) {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) await putDir(await folder(parent, n), p);
    else await put(parent, n, p);
  }
}

const run = JSON.parse(readFileSync("out/run.json", "utf8"));
const et = new Date(run.brief_generated).toLocaleString("sv-SE", { timeZone: "America/New_York" });  // 2026-09-30 11:47:00
const [day, hm] = [et.slice(0, 10), et.slice(11, 16).replace(":", "")];

// Archive first, so a half-finished upload never leaves LATEST.md pointing at a run that isn't there.
const arch = await folder(await folder(await folder(ROOT, "Archive"), day), hm);
await putDir(arch, "out");
const latest = await folder(ROOT, "Latest");
for (const n of ["ranking-full.txt", "analysis-models.csv", "analysis-fog.csv", "run.json"]) await put(latest, n, join("out", n));
await put(ROOT, "LATEST.md", "out/LATEST.md");
console.log("Box: uploaded run " + day + " " + hm + " (Archive + Latest + LATEST.md)");
