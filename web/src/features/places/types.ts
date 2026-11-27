/** A place as the API returns it. `mine` tells whether the signed-in person owns it. */
export type Visibility = "private" | "public";

export type Place = {
  id: string;
  name: string;
  description: string;
  lat: number;
  lng: number;
  address: string;
  category: string;
  visibility: Visibility;
  mine: boolean;
  /** Sent to the owner only. Public responses leave it out. */
  moderationHidden?: boolean;
  createdAt: string;
  updatedAt: string;
};

/** A place from the radius search, with its distance from the search point in whole metres. */
export type NearbyPlace = Place & { distanceM: number };

/** The fields a person can set. The server decides `id`, `mine` and the timestamps. */
export type PlaceInput = {
  name: string;
  description: string;
  address: string;
  category: string;
  visibility: Visibility;
  lat: number;
  lng: number;
};

/** A map viewport in the API's order: west, south, east, north. West greater than east crosses 180°. */
export type Bbox = { minLng: number; minLat: number; maxLng: number; maxLat: number };

/** One address match from the geocoder. */
export type GeocodeMatch = { label: string; lat: number; lng: number };
