/** Friendly descriptions of a device, built from its user agent and last-seen time. */

// Order matters: Edge, Opera and Samsung Internet also say "Chrome", and Chrome also says "Safari".
const BROWSERS: readonly (readonly [RegExp, string])[] = [
  [/\bEdg(?:A|iOS)?\//, "Edge"],
  [/\bOPR\/|\bOpera\b/, "Opera"],
  [/SamsungBrowser\//, "Samsung Internet"],
  [/Firefox\/|FxiOS\//, "Firefox"],
  [/Chrome\/|CriOS\//, "Chrome"],
  [/Safari\//, "Safari"],
];

// Order matters: iPhone user agents also say "Mac OS X", and Android ones also say "Linux".
const SYSTEMS: readonly (readonly [RegExp, string])[] = [
  [/Windows/, "Windows"],
  [/iPhone/, "iPhone"],
  [/iPad/, "iPad"],
  [/iPod/, "iPod"],
  [/Android/, "Android"],
  [/CrOS/, "ChromeOS"],
  [/Mac OS X|Macintosh/, "macOS"],
  [/Linux/, "Linux"],
];

/** "Edge on Windows", "Safari on iOS", or a plainer label when only one part is recognised. */
export function describeDevice(userAgent: string): string {
  const browser = BROWSERS.find(([pattern]) => pattern.test(userAgent))?.[1];
  const system = SYSTEMS.find(([pattern]) => pattern.test(userAgent))?.[1];

  if (browser && system) return `${browser} on ${system}`;
  if (browser) return browser;
  if (system) return `Browser on ${system}`;
  return "Unidentified browser or device";
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const relative = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

const UNITS: readonly (readonly [Intl.RelativeTimeFormatUnit, number])[] = [
  ["year", 365 * DAY],
  ["month", 30 * DAY],
  ["week", 7 * DAY],
  ["day", DAY],
  ["hour", HOUR],
  ["minute", MINUTE],
];

/** "Last active 5 minutes ago". `now` is passed in so the caller decides when the clock was read. */
export function formatLastActive(iso: string, now: number): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return "Last active unknown";

  // A timestamp ahead of this clock (small clock skew) counts as just now.
  const elapsed = Math.max(0, now - at);
  if (elapsed < MINUTE) return "Last active just now";

  const [unit, size] = UNITS.find(([, unitSize]) => elapsed >= unitSize) ?? ["minute", MINUTE];
  return `Last active ${relative.format(-Math.floor(elapsed / size), unit)}`;
}
