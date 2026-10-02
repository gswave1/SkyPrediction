// Bakes the build time into index.html next to the title, but only when the
// board itself changed (hash of the page with the stamp blanked out).
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
const RE = /<!--BUILD-->[\s\S]*?<!--\/BUILD-->/;
const html = readFileSync("index.html", "utf8");
if (!RE.test(html)) { console.log("no build marker; skipping"); process.exit(0); }
const hash = createHash("sha256").update(html.replace(RE, "<!--BUILD--><!--/BUILD-->")).digest("hex");
const prev = existsSync(".build-hash") ? readFileSync(".build-hash", "utf8").trim() : "";
if (hash === prev) { console.log("board unchanged; stamp kept"); process.exit(0); }
const when = new Date().toLocaleString("en-US", { timeZone: "America/New_York",
  month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
writeFileSync("index.html", html.replace(RE, "<!--BUILD-->" + when + "<!--/BUILD-->"));
writeFileSync(".build-hash", hash + "\n");
console.log("stamped", when);
