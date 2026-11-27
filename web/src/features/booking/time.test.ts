// The week helpers use local calendar days, so pin the local zone for these tests.
process.env.TZ = "Europe/London";

import { describe, expect, it } from "vitest";
import type { Slot } from "./client";
import {
  addDaysToKey,
  buildWeekGrid,
  dateKey,
  startOfWeek,
  timeKey,
  weekDays,
  zoneDateRange,
  zoneOptions,
} from "./time";

function slot(startsAt: string): Slot {
  const start = new Date(startsAt);
  return {
    startsAt,
    endsAt: new Date(start.getTime() + 60 * 60_000).toISOString(),
    localDate: "",
    localStart: "",
    localEnd: "",
    seatsLeft: 1,
  };
}

describe("zone keys across daylight saving", () => {
  it("reads the wall clock in the given zone, not UTC", () => {
    // London moves to BST at 01:00 UTC on 31 March 2030, so 23:30 UTC on the 31st is 00:30 on the 1st.
    const instant = new Date("2030-03-31T23:30:00Z");
    expect(dateKey(instant, "Europe/London")).toBe("2030-04-01");
    expect(timeKey(instant, "Europe/London")).toBe("00:30");
    // Before the change it is still GMT, and after it the wall clock jumps forward an hour.
    expect(timeKey(new Date("2030-03-31T00:30:00Z"), "Europe/London")).toBe("00:30");
    expect(timeKey(new Date("2030-03-31T01:30:00Z"), "Europe/London")).toBe("02:30");
    expect(timeKey(new Date("2030-03-31T00:30:00Z"), "UTC")).toBe("00:30");
  });

  it("uses 24-hour labels at midnight", () => {
    expect(timeKey(new Date("2030-01-15T00:05:00Z"), "UTC")).toBe("00:05");
  });
});

describe("calendar arithmetic", () => {
  it("adds days to date keys, including leap years and month ends", () => {
    expect(addDaysToKey("2030-02-28", 1)).toBe("2030-03-01");
    expect(addDaysToKey("2030-03-01", -1)).toBe("2030-02-28");
    expect(addDaysToKey("2028-02-28", 1)).toBe("2028-02-29");
    expect(addDaysToKey("2030-12-31", 1)).toBe("2031-01-01");
  });

  it("starts weeks on Monday and returns seven days", () => {
    // Wednesday 6 March 2030 belongs to the week that starts on Monday 4 March.
    const monday = startOfWeek(new Date(2030, 2, 6, 15, 20));
    expect(monday.getDate()).toBe(4);
    expect(monday.getHours()).toBe(0);
    expect(weekDays(monday)).toHaveLength(7);
    expect(weekDays(monday)[6].getDate()).toBe(10);
  });

  it("pads the zone date range by one day either side of the viewer's week", () => {
    const monday = startOfWeek(new Date(2030, 2, 4));
    expect(zoneDateRange(monday, "Europe/London")).toEqual({ from: "2030-03-03", to: "2030-03-11" });
  });
});

describe("buildWeekGrid", () => {
  it("places slots in their day and time columns and ignores other weeks", () => {
    const monday = startOfWeek(new Date(2030, 2, 4));
    const grid = buildWeekGrid(
      [
        slot("2030-03-04T09:00:00Z"),
        slot("2030-03-04T10:00:00Z"),
        slot("2030-03-10T09:00:00Z"),
        slot("2030-03-11T09:00:00Z"),
        slot("2030-02-25T09:00:00Z"),
      ],
      monday,
      "Europe/London",
    );
    expect(grid.count).toBe(3);
    expect(grid.days).toHaveLength(7);
    expect(grid.times).toEqual(["09:00", "10:00"]);
    expect(grid.cells[0][0].slot?.startsAt).toBe("2030-03-04T09:00:00Z");
    expect(grid.cells[1][0].slot?.startsAt).toBe("2030-03-04T10:00:00Z");
    expect(grid.cells[1][1].slot).toBeNull();
    expect(grid.cells[0][6].slot?.startsAt).toBe("2030-03-10T09:00:00Z");
  });

  it("shows slots in the viewer's zone, so a 09:00 Londoner is 10:00 in Paris", () => {
    const monday = startOfWeek(new Date(2030, 2, 4));
    const grid = buildWeekGrid([slot("2030-03-04T09:00:00Z")], monday, "Europe/Paris");
    expect(grid.times).toEqual(["10:00"]);
  });

  it("has no rows when the week is empty", () => {
    const grid = buildWeekGrid([], startOfWeek(new Date(2030, 2, 4)), "Europe/London");
    expect(grid.times).toEqual([]);
    expect(grid.count).toBe(0);
  });
});

describe("zoneOptions", () => {
  it("keeps a zone the platform does not list, so existing data still shows", () => {
    expect(zoneOptions("Mars/Olympus")[0]).toBe("Mars/Olympus");
    expect(zoneOptions("Europe/London")).toContain("Europe/London");
  });
});
