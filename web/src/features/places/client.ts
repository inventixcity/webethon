/**
 * Place calls through the same-origin /api/v1 proxy. Each function throws an ApiError on failure, so the
 * screens can show the message the API sent.
 */
import { api } from "@/lib/api/client";
import type { Bbox, GeocodeMatch, NearbyPlace, Place, PlaceInput } from "./types";

/** The page size for map views. A full page suggests there may be more places, so the UI says so. */
export const MAP_PAGE_SIZE = 200;

export type ListFilters = { q?: string; category?: string };

export function listPlaces(bbox: Bbox, filters: ListFilters = {}, limit = MAP_PAGE_SIZE) {
  const params = new URLSearchParams({ bbox: formatBbox(bbox), limit: String(limit) });
  const q = filters.q?.trim();
  if (q) params.set("q", q);
  const category = filters.category?.trim();
  if (category) params.set("category", category);
  return api<Place[]>(`/places?${params.toString()}`);
}

export function nearbyPlaces(lat: number, lng: number, radiusKm: number, limit = 20) {
  const params = new URLSearchParams({
    lat: String(lat),
    lng: String(lng),
    radiusKm: String(radiusKm),
    limit: String(limit),
  });
  return api<NearbyPlace[]>(`/places/nearby?${params.toString()}`);
}

export function createPlace(input: PlaceInput) {
  return api<Place>("/places", { body: input });
}

/** Sends only the fields given. The server ignores the rest, and `visibility` is refused on hidden places when sent. */
export function updatePlace(id: string, input: Partial<PlaceInput>) {
  return api<Place>(`/places/${encodeURIComponent(id)}`, { method: "PATCH", body: input });
}

export function deletePlace(id: string) {
  return api(`/places/${encodeURIComponent(id)}`, { method: "DELETE" });
}

/** Address search. The server answers `NOT_CONFIGURED` when no geocoder is set up. */
export function geocode(query: string) {
  const params = new URLSearchParams({ q: query.trim() });
  return api<GeocodeMatch[]>(`/places/geocode?${params.toString()}`);
}

/** The API takes west, south, east, north as four numbers. Numbers are sent as plain decimals. */
export function formatBbox(bbox: Bbox) {
  return [bbox.minLng, bbox.minLat, bbox.maxLng, bbox.maxLat].map((value) => String(value)).join(",");
}
