"use client";

import dynamic from "next/dynamic";
import type { MapCanvasProps } from "./map-canvas";

/**
 * The map, loaded only in the browser when the page needs it. MapLibre is large and draws on a canvas,
 * so the server never renders it and the rest of the page isn't held back by it.
 */
const MapCanvas = dynamic(() => import("./map-canvas").then((module) => module.MapCanvas), {
  ssr: false,
  loading: () => (
    <div className="relative grid min-h-[320px] place-items-center border border-ink bg-paper-sunk">
      <p role="status" className="font-mono text-xs tracking-[0.12em] uppercase">
        Loading map…
      </p>
    </div>
  ),
});

export function MapView(props: MapCanvasProps) {
  return <MapCanvas {...props} />;
}
