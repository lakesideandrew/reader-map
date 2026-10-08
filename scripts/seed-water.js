// Cut lakes and rivers out of the city shapes so map shading stops at the
// shoreline. Writes web/data/boundaries-land.geojson for display only;
// camera assignment keeps using the full boundaries.geojson, so a camera
// on a bridge or causeway still counts for its city.
//
// Source: MN DNR Hydrography, "Dnr Hydro Features All" polygon layer
// https://gis.data.mn.gov (DNR Hydrography Dataset)
//
// Run after seed:boundaries. Re-run only if boundaries change.
import polygonClipping from "polygon-clipping";
import { CENTER, RADIUS_KM, FILES, WEB_DATA, log, politeFetch, readJson, writeJson } from "./lib/common.js";
import { bbox } from "./lib/geo.js";
import path from "node:path";

const LAYER =
  "https://enterprise.gisdata.mn.gov/aghost/rest/services/us_mn_state_dnr/water_dnr_hydrography/FeatureServer/1/query";
const OUT = path.join(WEB_DATA, "boundaries-land.geojson");
const MIN_LAKE_ACRES = 30;

const dLat = RADIUS_KM / 111.2;
const dLng = RADIUS_KM / (111.32 * Math.cos((CENTER.lat * Math.PI) / 180));
const envelope = [CENTER.lng - dLng, CENTER.lat - dLat, CENTER.lng + dLng, CENTER.lat + dLat].map((n) => n.toFixed(4)).join(",");

async function fetchPolys(where) {
  const polys = [];
  for (let offset = 0; ; offset += 2000) {
    const params = new URLSearchParams({
      where,
      geometry: envelope,
      geometryType: "esriGeometryEnvelope",
      inSR: "4326",
      spatialRel: "esriSpatialRelIntersects",
      outFields: "pw_basin_name,wb_class,acres",
      outSR: "4326",
      maxAllowableOffset: "0.0002",
      geometryPrecision: "5",
      resultOffset: String(offset),
      resultRecordCount: "2000",
      f: "geojson",
    });
    const fc = await (await politeFetch(`${LAYER}?${params}`)).json();
    for (const f of fc.features) {
      if (!f.geometry) continue;
      if (f.geometry.type === "Polygon") polys.push(f.geometry.coordinates);
      else if (f.geometry.type === "MultiPolygon") polys.push(...f.geometry.coordinates);
    }
    if (!fc.properties?.exceededTransferLimit && fc.features.length < 2000) break;
  }
  return polys;
}

const boxOf = (poly) => bbox({ type: "Polygon", coordinates: poly });
const overlaps = (a, b) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];

async function main() {
  log("fetching lakes and river channels…");
  const water = await fetchPolys(
    `(wb_class IN ('Lake or Pond','Mine Pit Lake') AND acres >= ${MIN_LAKE_ACRES}) OR wb_class = 'Riverine polygon'`,
  );
  log("fetching islands…");
  const islands = await fetchPolys("wb_class IN ('Island or Land','Riverine island')");
  log(`${water.length} water polygons, ${islands.length} islands`);

  // Water minus islands, so island land keeps its city's color.
  const waterBoxes = water.map(boxOf);
  const islandBoxes = islands.map(boxOf);

  const boundaries = readJson(FILES.boundaries);
  let clipped = 0;
  const features = boundaries.features.map((f) => {
    const cityBox = bbox(f.geometry);
    const near = water.filter((_, i) => overlaps(waterBoxes[i], cityBox));
    if (!near.length) return f;
    let cut = polygonClipping.difference(f.geometry.coordinates, ...near);
    const nearIslands = islands.filter((_, i) => overlaps(islandBoxes[i], cityBox));
    if (nearIslands.length) {
      // Add back island land that lies inside the original city shape.
      const islandLand = polygonClipping.intersection(f.geometry.coordinates, polygonClipping.union(...nearIslands));
      if (islandLand.length) cut = polygonClipping.union(cut, islandLand);
    }
    clipped++;
    return { ...f, geometry: { type: "MultiPolygon", coordinates: round(cut) } };
  });

  writeJson(OUT, { type: "FeatureCollection", features });
  log(`wrote ${path.basename(OUT)}: ${clipped} of ${features.length} shapes trimmed at the shoreline`);
}

const r5 = (n) => Math.round(n * 1e5) / 1e5;
function round(mp) {
  return mp.map((poly) => poly.map((ring) => ring.map(([x, y]) => [r5(x), r5(y)])));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
