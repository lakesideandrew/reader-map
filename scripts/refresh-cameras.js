// Weekly: pull ALPR cameras from OpenStreetMap (the dataset DeFlock maps
// into), assign each to a city by point-in-polygon, and write
//   web/data/cameras.geojson       one point per camera
//   web/data/cameras-by-city.json  counts per city id
// A per-city change summary is appended to web/data/history.json.
//
// Data © OpenStreetMap contributors, ODbL. https://www.openstreetmap.org/copyright
import { CENTER, RADIUS_KM, FILES, log, politeFetch, readJson, writeJson, today, isMain } from "./lib/common.js";
import { bbox, pointInGeometry } from "./lib/geo.js";

const ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
];

const radiusM = Math.round(RADIUS_KM * 1000);
const QUERY = `[out:json][timeout:90];
(
  node["man_made"="surveillance"]["surveillance:type"="ALPR"](around:${radiusM},${CENTER.lat},${CENTER.lng});
  way["man_made"="surveillance"]["surveillance:type"="ALPR"](around:${radiusM},${CENTER.lat},${CENTER.lng});
);
out body center;`;

async function overpass() {
  let last;
  for (const url of ENDPOINTS) {
    try {
      log(`querying ${url}`);
      const r = await politeFetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ data: QUERY }),
        retries: 3,
        backoffMs: 30000,
      });
      return await r.json();
    } catch (e) {
      log(`  failed: ${e.message}`);
      last = e;
    }
  }
  throw last;
}

// Collapse the many spellings of vendors into a short key for coloring.
export function vendorKey(tags) {
  const m = `${tags.manufacturer || ""} ${tags.brand || ""}`.toLowerCase();
  if (m.includes("flock")) return "flock";
  if (m.includes("motorola") || m.includes("vigilant")) return "motorola";
  if (m.includes("axon")) return "axon";
  if (m.includes("genetec")) return "genetec";
  if (m.trim()) return "other";
  return "unknown";
}

async function main() {
  const boundaries = readJson(FILES.boundaries);
  const shapes = boundaries.features.map((f) => ({ id: f.id, name: f.properties.name, geometry: f.geometry, box: bbox(f.geometry) }));

  const body = await overpass();
  const elements = body.elements || [];
  log(`received ${elements.length} ALPR elements`);

  const features = [];
  for (const el of elements) {
    const lat = el.lat ?? el.center?.lat;
    const lng = el.lon ?? el.center?.lon;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const t = el.tags || {};
    const shape = shapes.find(
      (s) => lng >= s.box[0] && lng <= s.box[2] && lat >= s.box[1] && lat <= s.box[3] && pointInGeometry(lng, lat, s.geometry),
    );
    const props = {
      osm: `${el.type}/${el.id}`,
      vendor: vendorKey(t),
      city: shape?.id ?? null,
    };
    if (t.manufacturer) props.manufacturer = t.manufacturer;
    if (t.operator) props.operator = t.operator;
    if (t.direction) props.direction = t.direction;
    if (t["camera:mount"]) props.mount = t["camera:mount"];
    if (t["surveillance:zone"]) props.zone = t["surveillance:zone"];
    if (t.check_date) props.checked = t.check_date;
    features.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: [Math.round(lng * 1e6) / 1e6, Math.round(lat * 1e6) / 1e6] },
      properties: props,
    });
  }
  features.sort((a, b) => a.properties.osm.localeCompare(b.properties.osm));

  // Per-city counts.
  const byCity = {};
  for (const f of features) {
    const id = f.properties.city;
    if (!id) continue;
    const c = (byCity[id] ||= { total: 0, vendors: {}, operators: {} });
    c.total++;
    c.vendors[f.properties.vendor] = (c.vendors[f.properties.vendor] || 0) + 1;
    const op = f.properties.operator || "unspecified";
    c.operators[op] = (c.operators[op] || 0) + 1;
  }

  // Diff against last run so the change feed shows cameras added/removed.
  const prev = readJson(FILES.camerasByCity, null);
  const history = readJson(FILES.history, []);
  if (prev?.cities) {
    const ids = new Set([...Object.keys(prev.cities), ...Object.keys(byCity)]);
    for (const id of ids) {
      const before = prev.cities[id]?.total || 0;
      const after = byCity[id]?.total || 0;
      if (before === after) continue;
      history.push({
        date: today(),
        city: id,
        type: "cameras",
        from: before,
        to: after,
        summary: `OpenStreetMap camera count changed from ${before} to ${after}.`,
        by: "osm-refresh",
      });
    }
  }

  const fetchedAt = new Date().toISOString();
  writeJson(FILES.cameras, { type: "FeatureCollection", fetchedAt, features });
  writeJson(FILES.camerasByCity, { fetchedAt, cities: byCity });
  writeJson(FILES.history, history);

  const meta = readJson(FILES.meta, {});
  meta.camerasFetchedAt = fetchedAt;
  meta.cameraCount = features.length;
  writeJson(FILES.meta, meta);

  const inside = features.filter((f) => f.properties.city).length;
  const flock = features.filter((f) => f.properties.vendor === "flock").length;
  log(`wrote ${features.length} cameras (${inside} inside a mapped city, ${flock} Flock)`);
}

if (isMain(import.meta.url)) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
