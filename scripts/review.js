// Editor tools for statuses.
//
//   npm run review
//       Walk through open AI proposals: accept, reject, or skip each.
//
//   npm run review -- --set "<place>" <status> <source-url|-> "<summary>" [YYYY-MM-DD]
//       ("-" for the URL records an editor note instead of a link)
//       Set a status by hand, e.g.
//       npm run review -- --set "Bloomington" none https://... "Police say the city uses no plate readers." 2026-10-01
//
// Changes are written to web/data/ and logged in history.json as "manual".
// Commit and push afterwards to publish.
import readline from "node:readline";
import { stdin, stdout } from "node:process";
import { FILES, STATUSES, readJson, writeJson, today } from "./lib/common.js";
import { applyFinding, buildIndex, resolvePlace } from "./lib/apply.js";

const cities = readJson(FILES.cities);
const agencies = readJson(FILES.agencies);
const history = readJson(FILES.history, []);
const proposals = readJson(FILES.proposals, []);

function record(target) {
  return target.kind === "city" ? cities[target.id] : agencies[target.id];
}

function save() {
  writeJson(FILES.cities, cities);
  writeJson(FILES.agencies, agencies);
  writeJson(FILES.history, history);
  writeJson(FILES.proposals, proposals);
}

function manualApply(target, f) {
  const rec = record(target);
  const entry = applyFinding(rec, target, { confidence: "high", ...f }, today());
  rec.set_by = "manual";
  entry.by = "manual";
  history.push(entry);
}

async function setStatus(argv) {
  const [place, status, url, summary, date] = argv;
  if (!place || !STATUSES.includes(status) || !(url === "-" || /^https?:\/\//.test(url || "")) || !summary) {
    console.error('Usage: npm run review -- --set "<place>" <status> <source-url|-> "<summary>" [YYYY-MM-DD]');
    console.error('Use "-" for the URL when the source is your own knowledge; it shows as an editor note.');
    console.error(`Statuses: ${STATUSES.join(", ")}`);
    process.exit(2);
  }
  const target = resolvePlace(buildIndex(cities, agencies), place);
  if (!target) {
    console.error(`No tracked place named "${place}".`);
    process.exit(2);
  }
  const rec = record(target);
  manualApply(target, {
    proposed_status: status,
    url: url === "-" ? null : url,
    title: url === "-" ? "Editor note" : url,
    outlet: url === "-" ? "Reader Map editor" : "",
    summary,
    effective_date: date || today(),
  });
  save();
  console.log(`${rec.name}: now ${status}. Commit and push to publish.`);
}

async function walk() {
  const open = proposals.filter((p) => p.state === "open");
  if (!open.length) {
    console.log("No open proposals.");
    return;
  }
  // Line iterator works for a terminal and for piped input alike.
  const rl = readline.createInterface({ input: stdin, terminal: false });
  const lines = rl[Symbol.asyncIterator]();
  const ask = async (q) => {
    stdout.write(q);
    const r = await lines.next();
    return r.done ? "q" : r.value;
  };
  let changed = 0;
  for (const p of open) {
    const target = p.city ? { kind: "city", id: p.city } : { kind: "agency", id: p.agency };
    const rec = record(target);
    if (!rec) continue;
    console.log("\n" + "-".repeat(70));
    console.log(`${rec.name}: ${rec.status}  ->  ${p.proposed_status}   (found ${p.found}, ${p.confidence} confidence)`);
    console.log(`Summary:  ${p.summary}`);
    console.log(`Evidence: ${p.evidence}`);
    console.log(`Source:   ${p.outlet ? p.outlet + " — " : ""}${p.url}`);
    console.log(`Date:     ${p.effective_date ?? "not stated"}`);
    console.log(`Held because: ${p.why_not_applied}`);
    const ans = (await ask("[a]ccept  [r]eject  [s]kip  [q]uit > ")).trim().toLowerCase();
    if (ans === "q") break;
    if (ans === "a") {
      manualApply(target, { ...p, confidence: "high" });
      p.state = "accepted";
      p.reviewed = today();
      changed++;
    } else if (ans === "r") {
      p.state = "rejected";
      p.reviewed = today();
      changed++;
    }
  }
  rl.close();
  if (changed) {
    save();
    console.log(`\nSaved ${changed} decision(s). Commit and push to publish.`);
  }
}

const i = process.argv.indexOf("--set");
if (i >= 0) await setStatus(process.argv.slice(i + 1));
else await walk();
