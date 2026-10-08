// Fetch city / township polygons from MnDOT's statewide CTU layer, keep
// those touching the coverage circle, merge multi-county pieces, and write
// web/data/boundaries.geojson. Run once, or when annexations matter.
//
// Source: MnDOT "City, Township, and Unorganized Territory in Minnesota"
// https://gis.data.mn.gov/datasets/mndot::city-township-and-unorganized-territory-in-minnesota
import { CENTER, RADIUS_KM, FILES, log, politeFetch, writeJson } from "./lib/common.js";
import { geometryTouchesCircle, labelPoint } from "./lib/geo.js";

const LAYER =
  "https://webgis.dot.state.mn.us/65agsf1/rest/services/sdw_govnt/CITY_TOWNSHIP_UNORG_TERR/FeatureServer/0/query";

const dLat = RADIUS_KM / 111.2;
const dLng = RADIUS_KM / (111.32 * Math.cos((CENTER.lat * Math.PI) / 180));
const envelope = [CENTER.lng - dLng, CENTER.lat - dLat, CENTER.lng + dLng, CENTER.lat + dLat]
  .map((n) => n.toFixed(4))
  .join(",");

const params = new URLSearchParams({
  where: "1=1",
  geometry: envelope,
  geometryType: "esriGeometryEnvelope",
  inSR: "4326",
  spatialRel: "esriSpatialRelIntersects",
  outFields: "GNIS_FEATURE_ID,FEATURE_NAME,CTU_CLASS,COUNTY_NAME,POPULATION",
  outSR: "4326",
  maxAllowableOffset: "0.0002", // ~20 m simplification keeps the file small
  geometryPrecision: "5",
  resultRecordCount: "4000",
  f: "geojson",
});

const toTitle = (s) => s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());

async function main() {
  log(`querying MnDOT CTU layer, envelope ${envelope}`);
  const r = await politeFetch(`${LAYER}?${params}`);
  const fc = await r.json();
  log(`received ${fc.features.length} features in envelope`);

  const byId = new Map();
  for (const f of fc.features) {
    if (!f.geometry || !geometryTouchesCircle(f.geometry, CENTER, RADIUS_KM)) continue;
    const p = f.properties;
    const id = String(p.GNIS_FEATURE_ID);
    const polys = f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates;
    const existing = byId.get(id);
    if (existing) {
      existing.geometry.coordinates.push(...polys);
      if (!existing.properties.counties.includes(p.COUNTY_NAME)) existing.properties.counties.push(p.COUNTY_NAME);
      existing.properties.population += p.POPULATION || 0;
      continue;
    }
    byId.set(id, {
      type: "Feature",
      id,
      properties: {
        id,
        name: p.FEATURE_NAME,
        kind: p.CTU_CLASS === "CITY" ? "city" : p.CTU_CLASS === "TOWNSHIP" ? "township" : "unorganized",
        counties: [p.COUNTY_NAME],
        population: p.POPULATION || 0,
      },
      geometry: { type: "MultiPolygon", coordinates: polys },
    });
  }

  const features = [...byId.values()].sort((a, b) => a.properties.name.localeCompare(b.properties.name));
  for (const f of features) {
    f.properties.name = f.properties.name.includes(" ") || /[a-z]/.test(f.properties.name)
      ? f.properties.name
      : toTitle(f.properties.name);
    f.properties.label = labelPoint(f.geometry);
  }

  writeJson(FILES.boundaries, { type: "FeatureCollection", features });
  const counts = features.reduce((m, f) => ((m[f.properties.kind] = (m[f.properties.kind] || 0) + 1), m), {});
  log(`wrote ${features.length} shapes inside ${RADIUS_KM.toFixed(1)} km`, counts);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
