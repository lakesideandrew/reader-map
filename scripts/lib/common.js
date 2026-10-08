// Shared paths, constants and small helpers for every script.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, "..", "..");
export const WEB_DATA = path.join(ROOT, "web", "data");
export const SEED_DIR = path.join(ROOT, "data", "seed");
export const RUNS_DIR = path.join(ROOT, "data", "ai-runs");

export const FILES = {
  boundaries: path.join(WEB_DATA, "boundaries.geojson"),
  cities: path.join(WEB_DATA, "cities.json"),
  agencies: path.join(WEB_DATA, "agencies.json"),
  cameras: path.join(WEB_DATA, "cameras.geojson"),
  camerasByCity: path.join(WEB_DATA, "cameras-by-city.json"),
  history: path.join(WEB_DATA, "history.json"),
  proposals: path.join(WEB_DATA, "proposals.json"),
  meta: path.join(WEB_DATA, "meta.json"),
};

// Coverage circle: downtown Minneapolis, 30 miles. Watertown is 28.5 mi out.
export const CENTER = { lat: 44.9778, lng: -93.265 };
export const RADIUS_MI = 30;
export const RADIUS_KM = RADIUS_MI * 1.609344;

export const STATUSES = ["active", "other_vendor", "pending", "cancelled", "none", "unknown"];

export const USER_AGENT =
  "reader-map/0.1 (Twin Cities ALPR status map; https://github.com/lakesideandrew/reader-map)";

export function log(...args) {
  console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...args);
}

export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    if (fallback !== undefined && e.code === "ENOENT") return fallback;
    throw e;
  }
}

// Stable, diff-friendly JSON: 2-space indent, trailing newline. GeoJSON is
// written one feature per line instead, which keeps it small but diffable.
export function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (file.endsWith(".geojson") && Array.isArray(data.features)) {
    const { features, ...rest } = data;
    const head = JSON.stringify(rest).slice(0, -1);
    const body = features.map((f) => JSON.stringify(f)).join(",\n");
    fs.writeFileSync(file, `${head}${head.length > 1 ? "," : ""}"features":[\n${body}\n]}\n`);
    return;
  }
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
}

export function today() {
  return new Date().toISOString().slice(0, 10);
}

// Fetch with retries and backoff. Overpass asks for an identifying
// User-Agent and a pause after 429/504.
export async function politeFetch(url, { retries = 3, backoffMs = 5000, ...init } = {}) {
  let last;
  for (let i = 0; i < retries; i++) {
    try {
      const r = await fetch(url, {
        ...init,
        headers: { "User-Agent": USER_AGENT, Accept: "application/json", ...(init.headers || {}) },
      });
      if (r.ok) return r;
      last = new Error(`HTTP ${r.status} from ${url.slice(0, 120)}`);
      if (r.status < 500 && r.status !== 429) throw last;
    } catch (e) {
      last = e;
    }
    if (i < retries - 1) await new Promise((res) => setTimeout(res, backoffMs * (i + 1)));
  }
  throw last;
}

// Lowercase, strip punctuation and "city of" so names from news, OSM and
// the boundary layer compare equal ("St. Paul" == "Saint Paul").
export function normName(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/^city of\s+/, "")
    .replace(/\bst\.?\s/g, "saint ")
    .replace(/\bmt\.?\s/g, "mount ")
    .replace(/[^a-z0-9 ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// True when the calling module was run directly (node scripts/x.js),
// false when imported. Safe for paths containing spaces.
import { pathToFileURL } from "node:url";
export function isMain(metaUrl) {
  return process.argv[1] && metaUrl === pathToFileURL(path.resolve(process.argv[1])).href;
}
