import type { ErrorPageCode } from "@/lib/errors/types";
import type { SharkSpec } from "@/vendor/ascii-sharks";

/**
 * Which sharks swim in each error page. The art is the vendored shark engine, so each code gets
 * its own cast rather than a new drawing: kind, relative size and how many.
 * 404 keeps the original three-shark ocean.
 */
export const ERROR_SCENES: Record<ErrorPageCode, SharkSpec[]> = {
  400: [
    { kind: "classic", size: 1 },
    { kind: "hammerhead", size: 0.7 },
  ],
  401: [
    { kind: "greathammer", size: 0.9 },
    { kind: "classic", size: 0.6 },
  ],
  403: [
    { kind: "mako", size: 1 },
    { kind: "classic", size: 0.62 },
  ],
  404: [
    { kind: "classic", size: 1 },
    { kind: "hammerhead", size: 0.8 },
    { kind: "classic", size: 0.64 },
  ],
  405: [
    { kind: "mako", size: 0.9 },
    { kind: "classic", size: 0.6 },
  ],
  408: [
    { kind: "thresher", size: 0.95 },
    { kind: "classic", size: 0.6 },
  ],
  409: [
    { kind: "classic", size: 1 },
    { kind: "classic", size: 0.78 },
  ],
  410: [{ kind: "nurse", size: 0.8 }],
  413: [
    { kind: "tiger", size: 1 },
    { kind: "zebra", size: 0.7 },
  ],
  415: [
    { kind: "zebra", size: 0.9 },
    { kind: "nurse", size: 0.6 },
  ],
  422: [
    { kind: "hammerhead", size: 1 },
    { kind: "hammerhead", size: 0.6 },
  ],
  428: [
    { kind: "mako", size: 0.8 },
    { kind: "mako", size: 0.6 },
  ],
  429: [
    { kind: "thresher", size: 1 },
    { kind: "thresher", size: 0.7 },
    { kind: "nurse", size: 0.5 },
  ],
  500: [
    { kind: "tiger", size: 1 },
    { kind: "hammerhead", size: 0.6 },
  ],
  502: [
    { kind: "greathammer", size: 1 },
    { kind: "classic", size: 0.6 },
  ],
  503: [
    { kind: "greathammer", size: 1 },
    { kind: "mako", size: 0.6 },
    { kind: "classic", size: 0.5 },
  ],
  504: [
    { kind: "thresher", size: 0.9 },
    { kind: "greathammer", size: 0.6 },
  ],
  offline: [{ kind: "classic", size: 0.5 }],
  "session-expired": [
    { kind: "nurse", size: 1 },
    { kind: "classic", size: 0.6 },
  ],
};
