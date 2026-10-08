// Build web/data/cities.json and web/data/agencies.json from the boundary
// file plus the hand-curated seeds in data/seed/. Existing records are
// kept as-is; only missing cities/agencies are added. Pass --force to
// rebuild every record from the seed (this discards AI and manual edits).
import path from "node:path";
import { FILES, SEED_DIR, log, normName, readJson, writeJson, today } from "./lib/common.js";

const force = process.argv.includes("--force");
const seed = readJson(path.join(SEED_DIR, "status-seed.json"));
const agencySeed = readJson(path.join(SEED_DIR, "agencies-seed.json"));
const boundaries = readJson(FILES.boundaries);

const sheriffFor = (county) => `${county.toLowerCase().replace(/\s+/g, "-")}-sheriff`;

function blank(f) {
  const p = f.properties;
  return {
    id: p.id,
    name: p.kind === "township" ? `${p.name} Twp` : p.name,
    kind: p.kind,
    counties: p.counties,
    population: p.population,
    status: "unknown",
    vendor: null,
    cameras_reported: null,
    sharing_restricted: false,
    since: null,
    summary: "",
    sources: [],
    confidence: null,
    covered_by: [],
    last_reviewed: null,
    last_ai_check: null,
    notes: "",
  };
}

function main() {
  const existing = force ? {} : readJson(FILES.cities, {});
  const cityByName = new Map();
  for (const f of boundaries.features)
    if (f.properties.kind === "city") cityByName.set(normName(f.properties.name), f.properties.id);

  const fresh = {};
  for (const f of boundaries.features) {
    const r = blank(f);
    // Townships and unorganized land are policed by the county sheriff.
    if (r.kind !== "city") r.covered_by = [sheriffFor(r.counties[0])];
    fresh[r.id] = r;
  }
  const fortSnelling = boundaries.features.find((f) => normName(f.properties.name) === "fort snelling");
  if (fortSnelling) fresh[fortSnelling.id].covered_by = ["msp-airport-pd", "hennepin-sheriff"];

  const missing = [];
  const lookup = (name) => {
    const id = cityByName.get(normName(name));
    if (!id) missing.push(name);
    return id;
  };

  for (const [agency, names] of Object.entries(seed.sheriffContract)) {
    if (agency.startsWith("_")) continue;
    for (const n of names) {
      const id = lookup(n);
      if (id) fresh[id].covered_by = [agency];
    }
  }

  const src = seed.trackerActive.source;
  for (const [n, count] of Object.entries(seed.trackerActive.cities)) {
    const id = lookup(n);
    if (!id) continue;
    Object.assign(fresh[id], {
      status: "active",
      vendor: "Flock Safety",
      cameras_reported: count,
      summary: "Listed as an active Flock deployment in state-mandated reports. No cancellation reported.",
      sources: [src],
      confidence: "medium",
      last_reviewed: "2026-10-06",
    });
  }

  for (const s of seed.cities) {
    const id = lookup(s.name);
    if (!id) continue;
    Object.assign(fresh[id], {
      status: s.status,
      vendor: s.vendor ?? null,
      cameras_reported: s.cameras ?? null,
      sharing_restricted: !!s.sharing_restricted,
      since: s.since ?? null,
      summary: s.summary,
      sources: s.sources,
      confidence: s.confidence,
      last_reviewed: "2026-10-06",
    });
  }

  if (missing.length) log(`WARNING: seed names with no matching city: ${missing.join(", ")}`);

  // Merge: keep existing records untouched, add new ones.
  const cities = {};
  let added = 0;
  for (const id of Object.keys(fresh).sort((a, b) => fresh[a].name.localeCompare(fresh[b].name))) {
    if (existing[id]) cities[id] = existing[id];
    else {
      cities[id] = fresh[id];
      added++;
    }
  }
  writeJson(FILES.cities, cities);

  // Agencies.
  const existingAgencies = force ? {} : readJson(FILES.agencies, {});
  const agencies = { ...existingAgencies };
  for (const a of agencySeed) {
    if (agencies[a.id]) continue;
    agencies[a.id] = {
      vendor: null, cameras: null, sharing_restricted: false, since: null, summary: "",
      sources: [], confidence: null, cities: [], last_reviewed: a.status === "unknown" ? null : "2026-10-06",
      last_ai_check: null, ...a,
    };
  }
  writeJson(FILES.agencies, agencies);

  // Seed the change feed with the dated statuses so it is useful on day one.
  const history = readJson(FILES.history, []);
  if (!history.some((h) => h.by === "seed")) {
    for (const r of Object.values(cities)) {
      if (r.status === "unknown" || !r.since) continue;
      history.push({ date: r.since, city: r.id, type: "status", from: null, to: r.status, summary: r.summary, source: r.sources[0]?.url ?? null, by: "seed" });
    }
    for (const a of Object.values(agencies)) {
      if (a.status === "unknown" || !a.since) continue;
      history.push({ date: a.since, agency: a.id, type: "status", from: null, to: a.status, summary: a.summary, source: a.sources[0]?.url ?? null, by: "seed" });
    }
    history.sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : 0));
    writeJson(FILES.history, history);
  }

  const meta = readJson(FILES.meta, {});
  meta.seededAt ??= today();
  writeJson(FILES.meta, meta);

  const counts = Object.values(cities).reduce((m, c) => ((m[c.status] = (m[c.status] || 0) + 1), m), {});
  log(`cities.json: ${Object.keys(cities).length} records (${added} added)`, counts);
  log(`agencies.json: ${Object.keys(agencies).length} records`);
}

main();
