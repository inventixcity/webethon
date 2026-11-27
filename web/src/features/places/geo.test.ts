import { describe, expect, it } from "vitest";
import { formatDistance, parseCoordinates, viewportBbox, wrapLng } from "./geo";

describe("viewportBbox", () => {
  it("keeps an ordinary view as it is", () => {
    expect(viewportBbox({ lng: -0.5, lat: 51 }, { lng: 0.5, lat: 52 })).toEqual({
      minLng: -0.5,
      minLat: 51,
      maxLng: 0.5,
      maxLat: 52,
    });
  });

  it("wraps a view that has been pushed past 180 degrees into the API's range", () => {
    const bbox = viewportBbox({ lng: 170, lat: -1 }, { lng: 190, lat: 1 });
    expect(bbox.minLng).toBe(170);
    expect(bbox.maxLng).toBe(-170);
    expect(bbox.minLng > bbox.maxLng).toBe(true);
  });

  it("uses the whole world for a view wider than 360 degrees", () => {
    const bbox = viewportBbox({ lng: -200, lat: 10 }, { lng: 200, lat: 20 });
    expect([bbox.minLng, bbox.maxLng]).toEqual([-180, 180]);
  });

  it("clamps latitudes", () => {
    const bbox = viewportBbox({ lng: 0, lat: -95 }, { lng: 1, lat: 95 });
    expect([bbox.minLat, bbox.maxLat]).toEqual([-90, 90]);
  });
});

describe("wrapLng", () => {
  it("keeps 180 as the east edge", () => {
    expect(wrapLng(180)).toBe(180);
    expect(wrapLng(-180)).toBe(-180);
    expect(wrapLng(540)).toBe(180);
    expect(wrapLng(-190)).toBe(170);
  });
});

describe("formatDistance", () => {
  it("reads metres and kilometres", () => {
    expect(formatDistance(0)).toBe("0 m");
    expect(formatDistance(843.4)).toBe("843 m");
    expect(formatDistance(1234)).toBe("1.2 km");
    expect(formatDistance(48_600)).toBe("49 km");
    expect(formatDistance(Number.NaN)).toBe("");
  });
});

describe("parseCoordinates", () => {
  it("accepts comma or space separated pairs in range", () => {
    expect(parseCoordinates("51.5074, -0.1278")).toEqual({ lat: 51.5074, lng: -0.1278 });
    expect(parseCoordinates("  -33.9 151.2 ")).toEqual({ lat: -33.9, lng: 151.2 });
  });

  it("refuses anything that isn't two plain numbers in range", () => {
    for (const text of ["", "51.5", "91, 0", "0, 181", "1e5, 2", "a, b", "1,2,3", "NaN, 0", "Infinity, 0"]) {
      expect(parseCoordinates(text), text).toBeNull();
    }
  });
});
