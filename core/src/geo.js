// core/geo.js  (shared Core — ARCHITECTURE §3)
// Coarse offline jurisdiction candidate lookup over a bundled bounding-box
// table (core/data/geo-bounds.json, injected by the caller — the Core does no
// I/O). Boxes are deliberately generous and may overlap; this module returns
// ALL matching candidates and the PolicyEngine resolves overlaps by taking the
// strictest profile. Pure functions only — no Date, no I/O.

/** Default margin applied around every box, in degrees (~0.05° ≈ 5 km).
 *  Implements the "within ~5 km of a boundary → consider adjacent
 *  jurisdictions" rule: near-border points match both sides and the engine's
 *  stricter-of picks the safe profile. */
export const DEFAULT_MARGIN_DEG = 0.05;

/**
 * Resolve all candidate jurisdiction codes for a coordinate.
 *
 * @param {number} lat
 * @param {number} lon
 * @param {Object|Array} bounds  The geo-bounds table: either the full
 *   geo-bounds.json object ({entries:[...]}) or the entries array itself.
 *   Each entry: { code, boxes: [{minLat, maxLat, minLon, maxLon}] }.
 * @param {number} [marginDeg]   Expansion applied to every box edge.
 * @returns {string[]} ALL matching jurisdictionCodes, subdivision codes
 *   (e.g. 'AU-VIC') before bare country codes (e.g. 'AU'), otherwise in table
 *   order. Multiple candidates are expected (e.g. ACT ⊂ NSW ⊂ AU, border
 *   zones). Empty array = no candidate (caller fails safe).
 */
export function resolveCandidates(lat, lon, bounds, marginDeg = DEFAULT_MARGIN_DEG) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return [];
  const entries = Array.isArray(bounds) ? bounds : (bounds && bounds.entries) || [];
  const hits = [];
  for (const entry of entries) {
    if (!entry || typeof entry.code !== 'string' || !Array.isArray(entry.boxes)) continue;
    for (const b of entry.boxes) {
      if (
        lat >= b.minLat - marginDeg &&
        lat <= b.maxLat + marginDeg &&
        lon >= b.minLon - marginDeg &&
        lon <= b.maxLon + marginDeg
      ) {
        hits.push(entry.code);
        break; // one hit per entry is enough
      }
    }
  }
  const isSubdivision = (code) => code.includes('-');
  return [...hits.filter(isSubdivision), ...hits.filter((c) => !isSubdivision(c))];
}
