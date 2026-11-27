"use client";

import { useEffect, useRef, useState } from "react";
import type { GeoJSONSource, Map as MapLibreMap, MapMouseEvent, Popup as MapLibrePopup } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type { Theme } from "@/components/theme/theme";
import { viewportBbox } from "@/features/places/geo";
import type { Bbox, Place } from "@/features/places/types";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// OpenFreeMap serves both styles without a key. Dark mode switches the style, so the basemap stays readable.
const STYLES: Record<Theme, string> = {
  light: "https://tiles.openfreemap.org/styles/liberty",
  dark: "https://tiles.openfreemap.org/styles/dark",
};
const PLACES = "places";
const PICK = "pick";
const CLUSTERS = "place-clusters";
const COUNTS = "place-cluster-count";
const POINTS = "place-points";
const SELECTED = "place-selected";
const PICKED = "pick-point";
/** A filter value that matches nothing, used when no place is selected. */
const NONE = "__none__";
/** Used only if the page's colour tokens can't be read. Matches the light theme. */
const FALLBACK = { ink: "#12110e", inkSoft: "#3a372e", paper: "#f3eee3", vermilion: "#d23a1c" };

type Point = { lat: number; lng: number };

export type PickState = {
  active: boolean;
  point: Point | null;
  onPick: (point: Point) => void;
};

/** Moves the map to a place. `nonce` changes on every request, so the same place can be focused twice. */
export type Focus = { id?: string; lat: number; lng: number; zoom?: number; nonce: number };

export type MapCanvasProps = {
  places: Place[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onViewportChange: (bbox: Bbox) => void;
  onEdit?: (place: Place) => void;
  theme: Theme;
  pick?: PickState;
  focus?: Focus | null;
  className?: string;
};

type Colours = typeof FALLBACK;
type MapLib = typeof import("maplibre-gl");

function prefersReducedMotion() {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Reads the palette from the map's own element, so the map follows the page theme. */
function readColours(element: HTMLElement): Colours {
  const style = getComputedStyle(element);
  const read = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  return {
    ink: read("--ink", FALLBACK.ink),
    inkSoft: read("--ink-soft", FALLBACK.inkSoft),
    paper: read("--paper", FALLBACK.paper),
    vermilion: read("--vermilion", FALLBACK.vermilion),
  };
}

/** The provider's dark style uses near-black text for water and dim grey for roads and places. */
function improveDarkLabels(map: MapLibreMap, colours: Colours) {
  for (const layer of map.getStyle().layers ?? []) {
    if (layer.type !== "symbol" || !/^(water_name|highway_name_|place_)/.test(layer.id)) continue;
    // Leave data-driven colours alone: they may encode distinctions in future provider styles.
    const colour = map.getPaintProperty(layer.id, "text-color");
    if (colour !== undefined && typeof colour !== "string") continue;
    map.setPaintProperty(layer.id, "text-color", colours.inkSoft);
    map.setPaintProperty(layer.id, "text-halo-color", colours.paper);
    map.setPaintProperty(layer.id, "text-halo-width", 1.25);
  }
}

type Collection = {
  type: "FeatureCollection";
  features: { type: "Feature"; geometry: { type: "Point"; coordinates: [number, number] }; properties: { id: string; name: string } }[];
};

function placesCollection(places: Place[]): Collection {
  return {
    type: "FeatureCollection",
    features: places.map((place) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [place.lng, place.lat] },
      properties: { id: place.id, name: place.name },
    })),
  };
}

function pickCollection(point: Point | null | undefined): Collection {
  return {
    type: "FeatureCollection",
    features: point
      ? [{ type: "Feature", geometry: { type: "Point", coordinates: [point.lng, point.lat] }, properties: { id: "pick", name: "Picked point" } }]
      : [],
  };
}

/** Adds the sources and layers for the current style. Each style switch wipes them, so this runs again. */
function addLayers(map: MapLibreMap, places: Place[], selectedId: string | null, pick: Point | null, colours: Colours) {
  const cluster = ["has", "point_count"] as const;
  map.addSource(PLACES, {
    type: "geojson",
    data: placesCollection(places) as never,
    cluster: true,
    clusterMaxZoom: 14,
    clusterRadius: 48,
  });
  map.addLayer({
    id: CLUSTERS,
    type: "circle",
    source: PLACES,
    filter: [...cluster],
    paint: {
      "circle-color": colours.ink,
      "circle-stroke-color": colours.paper,
      "circle-stroke-width": 2,
      "circle-radius": ["step", ["get", "point_count"], 16, 10, 20, 50, 26],
    },
  });
  map.addLayer({
    id: COUNTS,
    type: "symbol",
    source: PLACES,
    filter: [...cluster],
    layout: {
      "text-field": ["get", "point_count_abbreviated"],
      "text-font": ["Noto Sans Regular"],
      "text-size": 12,
      "text-allow-overlap": true,
    },
    paint: { "text-color": colours.paper },
  });
  map.addLayer({
    id: POINTS,
    type: "circle",
    source: PLACES,
    filter: ["!", [...cluster]] as never,
    paint: {
      "circle-color": colours.vermilion,
      "circle-stroke-color": colours.paper,
      "circle-stroke-width": 2,
      "circle-radius": 7,
    },
  });
  map.addLayer({
    id: SELECTED,
    type: "circle",
    source: PLACES,
    filter: ["all", ["!", [...cluster]], ["==", ["get", "id"], selectedId ?? NONE]] as never,
    paint: {
      "circle-color": "rgba(0,0,0,0)",
      "circle-stroke-color": colours.ink,
      "circle-stroke-width": 3,
      "circle-radius": 13,
    },
  });
  map.addSource(PICK, { type: "geojson", data: pickCollection(pick) as never });
  map.addLayer({
    id: PICKED,
    type: "circle",
    source: PICK,
    paint: {
      "circle-color": "rgba(0,0,0,0)",
      "circle-stroke-color": colours.vermilion,
      "circle-stroke-width": 3,
      "circle-radius": 10,
    },
  });
}

/** Builds the popup from text nodes only. Place names come from users, so they are never parsed as HTML. */
function popupContent(place: Place, onEdit?: () => void): HTMLElement {
  const root = document.createElement("div");
  root.className = "flex min-w-[180px] flex-col gap-2 font-sans text-ink";

  const title = document.createElement("p");
  title.className = "text-base font-semibold leading-tight";
  title.textContent = place.name;
  root.append(title);

  const meta = [place.category, place.address].filter(Boolean);
  if (meta.length) {
    const line = document.createElement("p");
    line.className = "text-sm text-ink-soft";
    line.textContent = meta.join(" · ");
    root.append(line);
  }

  if (place.description) {
    const body = document.createElement("p");
    body.className = "line-clamp-4 whitespace-pre-line text-sm text-ink-soft";
    body.textContent = place.description;
    root.append(body);
  }

  if (place.mine && onEdit) {
    const edit = document.createElement("button");
    edit.type = "button";
    // The popup is plain DOM, so it takes the Button's classes from buttonVariants rather than the component.
    edit.className = cn(buttonVariants({ variant: "secondary", size: "sm" }), "self-start");
    edit.textContent = "Edit place";
    edit.addEventListener("click", onEdit);
    root.append(edit);
  }
  return root;
}

export function MapCanvas({ places, selectedId, onSelect, onViewportChange, onEdit, theme, pick, focus, className }: MapCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const libRef = useRef<MapLib | null>(null);
  const popupRef = useRef<MapLibrePopup | null>(null);
  const styleRef = useRef<Theme>(theme);
  const loadedRef = useRef(false);
  const [status, setStatus] = useState<"loading" | "ready" | "failed">("loading");

  // Map events are bound once, so they read the latest props through this ref.
  const live = useRef({ places, selectedId, onSelect, onViewportChange, onEdit, pick });
  useEffect(() => {
    live.current = { places, selectedId, onSelect, onViewportChange, onEdit, pick };
  });

  function closePopup() {
    popupRef.current?.remove();
    popupRef.current = null;
  }

  function showPopup(place: Place, at: [number, number]) {
    const map = mapRef.current;
    const lib = libRef.current;
    if (!map || !lib) return;
    closePopup();
    const popup = new lib.Popup({ closeButton: true, closeOnClick: false, maxWidth: "280px", offset: 12 })
      .setLngLat(at)
      .setDOMContent(popupContent(place, live.current.onEdit ? () => { live.current.onEdit?.(place); closePopup(); } : undefined))
      .addTo(map);
    // Square, paper-coloured popup with no tip, to match the rest of the kit.
    const element = popup.getElement();
    const content = element?.querySelector<HTMLElement>(".maplibregl-popup-content");
    if (content) {
      content.style.borderRadius = "0";
      content.style.background = "var(--paper-raised)";
      content.style.color = "var(--ink)";
      content.style.border = "1px solid var(--ink)";
      content.style.boxShadow = "none";
    }
    const tip = element?.querySelector<HTMLElement>(".maplibregl-popup-tip");
    if (tip) tip.style.display = "none";
    const close = element?.querySelector<HTMLElement>(".maplibregl-popup-close-button");
    if (close) {
      close.style.color = "var(--ink)";
      close.style.borderRadius = "0";
    }
    popupRef.current = popup;
  }

  // Creates the map once. The library loads on demand, so the page's first paint doesn't wait for it.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let disposed = false;
    let map: MapLibreMap | undefined;

    (async () => {
      const lib = await import("maplibre-gl");
      if (disposed) return;
      // The worker is served from /public (see scripts/copy-maplibre-worker.mjs), since the bundler moves
      // the file MapLibre would otherwise load relative to its own module.
      lib.setWorkerUrl(`/vendor/maplibre-gl-worker-${lib.getVersion()}.mjs`);
      libRef.current = lib;
      map = new lib.Map({
        container,
        style: STYLES[styleRef.current],
        center: [0, 20],
        zoom: 1.5,
        attributionControl: { compact: true },
      });
      mapRef.current = map;
      map.addControl(new lib.NavigationControl({ showCompass: false }), "top-right");
      const instance = map;

      const emitViewport = () => {
        const bounds = instance.getBounds();
        live.current.onViewportChange(viewportBbox(bounds.getSouthWest(), bounds.getNorthEast()));
      };

      instance.on("style.load", () => {
        loadedRef.current = true;
        setStatus("ready");
        const state = live.current;
        const colours = readColours(container);
        if (styleRef.current === "dark") improveDarkLabels(instance, colours);
        addLayers(instance, state.places, state.selectedId, state.pick?.point ?? null, colours);
        emitViewport();
      });
      instance.on("error", () => {
        if (!loadedRef.current) setStatus("failed");
      });
      instance.on("moveend", emitViewport);

      instance.on("click", (event: MapMouseEvent) => {
        const state = live.current;
        if (state.pick?.active) {
          state.pick.onPick({ lat: event.lngLat.lat, lng: event.lngLat.lng });
          return;
        }
        const hit = instance.queryRenderedFeatures(event.point, { layers: [CLUSTERS, POINTS] })[0];
        if (!hit) {
          state.onSelect(null);
          closePopup();
          return;
        }
        const coordinates = (hit.geometry as { coordinates: [number, number] }).coordinates;
        if (hit.properties?.point_count) {
          const source = instance.getSource(PLACES) as GeoJSONSource | undefined;
          const clusterId = Number(hit.properties.cluster_id);
          void source?.getClusterExpansionZoom(clusterId).then((zoom) => {
            instance.easeTo({ center: coordinates, zoom, duration: prefersReducedMotion() ? 0 : 500 });
          });
          return;
        }
        const id = String(hit.properties?.id ?? "");
        state.onSelect(id);
        const place = state.places.find((item) => item.id === id);
        if (place) showPopup(place, coordinates);
      });

      for (const layer of [CLUSTERS, POINTS]) {
        instance.on("mouseenter", layer, () => {
          if (!live.current.pick?.active) instance.getCanvas().style.cursor = "pointer";
        });
        instance.on("mouseleave", layer, () => {
          instance.getCanvas().style.cursor = live.current.pick?.active ? "crosshair" : "";
        });
      }
    })().catch(() => setStatus("failed"));

    return () => {
      disposed = true;
      closePopup();
      map?.remove();
      mapRef.current = null;
      loadedRef.current = false;
    };
    // The map is created once. Later changes arrive through the effects below.
  }, []);

  // A theme change swaps the style. The style.load handler adds the layers back with the new palette.
  useEffect(() => {
    const map = mapRef.current;
    styleRef.current = theme;
    if (!map || !loadedRef.current) return;
    map.setStyle(STYLES[theme]);
  }, [theme]);

  useEffect(() => {
    const source = mapRef.current?.getSource(PLACES) as GeoJSONSource | undefined;
    source?.setData(placesCollection(places) as never);
  }, [places]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.getLayer(SELECTED)) return;
    map.setFilter(SELECTED, ["all", ["!", ["has", "point_count"]], ["==", ["get", "id"], selectedId ?? NONE]] as never);
    if (!selectedId) closePopup();
  }, [selectedId]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    map.getCanvas().style.cursor = pick?.active ? "crosshair" : "";
    const source = map.getSource(PICK) as GeoJSONSource | undefined;
    source?.setData(pickCollection(pick?.point ?? null) as never);
  }, [pick?.active, pick?.point]);

  // A focus request from the list moves the map and opens that place's popup.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !focus) return;
    map.flyTo({
      center: [focus.lng, focus.lat],
      zoom: focus.zoom ?? Math.max(map.getZoom(), 14),
      duration: prefersReducedMotion() ? 0 : 900,
    });
    if (focus.id) {
      const place = live.current.places.find((item) => item.id === focus.id);
      if (place) showPopup(place, [place.lng, place.lat]);
    }
  }, [focus]);

  return (
    <div className={cn("relative min-h-[320px] border border-ink bg-paper-sunk", className)}>
      <div className="absolute inset-0">
        <div ref={containerRef} role="region" aria-label="Map of places. The list beside it has the same places." className="h-full w-full" />
      </div>
      {status === "loading" ? (
        <p role="status" className="absolute inset-0 grid place-items-center font-mono text-xs tracking-[0.12em] uppercase">
          Loading map…
        </p>
      ) : null}
      {status === "failed" ? (
        <p role="alert" className="absolute inset-0 grid place-items-center p-6 text-center font-sans text-ink-soft">
          The map couldn&apos;t load. The list still works.
        </p>
      ) : null}
    </div>
  );
}
