import type { Bbox } from "./types";

export const WORLD: Bbox = { minLng: -180, minLat: -90, maxLng: 180, maxLat: 90 };

/** Wraps a longitude into [-180, 180]. Map libraries can report 190° when the world is repeated. */
export function wrapLng(value: number): number {
  const wrapped = ((((value + 180) % 360) + 360) % 360) - 180;
  // 180° itself is kept as the east edge rather than becoming -180°.
  return wrapped === -180 && value > 0 ? 180 : wrapped;
}

/**
 * Turns a map's corners into the API's viewport. A view wider than the world is the whole world. A
 * view that crosses the antimeridian has its west edge east of its east edge, which the API accepts.
 */
export function viewportBbox(southWest: { lng: number; lat: number }, northEast: { lng: number; lat: number }): Bbox {
  const minLat = Math.max(-90, Math.min(southWest.lat, northEast.lat));
  const maxLat = Math.min(90, Math.max(southWest.lat, northEast.lat));
  if (northEast.lng - southWest.lng >= 360) {
    return { ...WORLD, minLat, maxLat };
  }
  return {
    minLng: wrapLng(southWest.lng),
    minLat,
    maxLng: wrapLng(northEast.lng),
    maxLat,
  };
}

/** Metres as people read them: whole metres under a kilometre, then one decimal place. */
export function formatDistance(meters: number): string {
  if (!Number.isFinite(meters) || meters < 0) return "";
  if (meters < 1000) return `${Math.round(meters)} m`;
  const km = meters / 1000;
  return `${km < 10 ? km.toFixed(1) : Math.round(km)} km`;
}

export type Coordinates = { lat: number; lng: number };

/**
 * Reads "51.5074, -0.1278" or "51.5074 -0.1278". Returns null unless both are numbers in range, so a
 * pasted value can't put a point somewhere impossible.
 */
export function parseCoordinates(text: string): Coordinates | null {
  const parts = text.trim().split(/[\s,]+/).filter(Boolean);
  if (parts.length !== 2) return null;
  const [lat, lng] = parts.map((part) => (/^-?\d+(\.\d+)?$/.test(part) ? Number(part) : NaN));
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng };
}

/** Four decimal places: about 11 metres, plenty for a place name. */
export function formatCoordinate(value: number): string {
  return value.toFixed(4);
}
