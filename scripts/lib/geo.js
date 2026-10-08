// Minimal geometry helpers. Coordinates are GeoJSON order: [lng, lat].

export function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371.0088;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Ray casting on one ring.
function inRing(lng, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function polygons(geometry) {
  if (!geometry) return [];
  if (geometry.type === "Polygon") return [geometry.coordinates];
  if (geometry.type === "MultiPolygon") return geometry.coordinates;
  return [];
}

// Point in Polygon/MultiPolygon, honoring holes.
export function pointInGeometry(lng, lat, geometry) {
  for (const poly of polygons(geometry)) {
    if (!poly.length || !inRing(lng, lat, poly[0])) continue;
    let inHole = false;
    for (let h = 1; h < poly.length; h++) if (inRing(lng, lat, poly[h])) inHole = true;
    if (!inHole) return true;
  }
  return false;
}

export function bbox(geometry) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const poly of polygons(geometry))
    for (const ring of poly)
      for (const [x, y] of ring) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
  return [minX, minY, maxX, maxY];
}

// True when any vertex lies within the circle, or the circle's center lies
// inside the polygon. Good enough for municipal shapes at this scale.
export function geometryTouchesCircle(geometry, center, radiusKm) {
  if (pointInGeometry(center.lng, center.lat, geometry)) return true;
  for (const poly of polygons(geometry))
    for (const ring of poly)
      for (const [x, y] of ring) if (haversineKm(center.lat, center.lng, y, x) <= radiusKm) return true;
  return false;
}

// Area-weighted-ish label point: centroid of the largest outer ring,
// nudged inside if the centroid falls outside (C-shaped cities).
export function labelPoint(geometry) {
  let best = null, bestArea = -1;
  for (const poly of polygons(geometry)) {
    const ring = poly[0];
    let a = 0, cx = 0, cy = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const f = ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
      a += f;
      cx += (ring[j][0] + ring[i][0]) * f;
      cy += (ring[j][1] + ring[i][1]) * f;
    }
    if (Math.abs(a) > bestArea) {
      bestArea = Math.abs(a);
      best = a ? [cx / (3 * a), cy / (3 * a)] : ring[0];
    }
  }
  if (best && !pointInGeometry(best[0], best[1], geometry)) {
    const [minX, minY, maxX, maxY] = bbox(geometry);
    const y = best[1];
    for (let k = 1; k < 40; k++) {
      const x = minX + ((maxX - minX) * k) / 40;
      if (pointInGeometry(x, y, geometry)) return [round(x), round(y)];
    }
    return [round((minX + maxX) / 2), round((minY + maxY) / 2)];
  }
  return best ? [round(best[0]), round(best[1])] : null;
}

const round = (n) => Math.round(n * 1e5) / 1e5;
