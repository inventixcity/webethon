export type KitItem = { name: string; href: string; note: string };

export const authSets = [
  { id: 1, name: "Editorial", note: "Giant type and Lottie loops" },
  { id: 2, name: "Living", note: "Scenes that react as you type" },
  { id: 3, name: "Mechanical", note: "Machines you drive with the keyboard" },
  { id: 4, name: "Maison", note: "Couture: oxblood, silk and gold" },
  { id: 5, name: "Botanica", note: "A garden: forest, bone and brass" },
  { id: 6, name: "Polar", note: "The Arctic: midnight, ice and aurora" },
] as const;

export const authScreens = [
  { id: "login", name: "Login" },
  { id: "signup", name: "Signup" },
  { id: "forgot-password", name: "Forgot password" },
  { id: "verify", name: "Verification" },
  { id: "reset-password", name: "Reset password" },
] as const;

export type AuthSetId = (typeof authSets)[number]["id"];
export type AuthScreenId = (typeof authScreens)[number]["id"];

/** What each screen is, in each set. */
const screenNotes: Record<AuthSetId, Record<AuthScreenId, string>> = {
  1: {
    login: "Masthead",
    signup: "Ledger",
    "forgot-password": "One sentence, swinging keys",
    verify: "Full-bleed code",
    "reset-password": "Vault band",
  },
  2: {
    login: "ASCII owl that watches you type",
    signup: "ASCII tree that grows",
    "forgot-password": "Paper plane that folds",
    verify: "ASCII radar tracks each digit",
    "reset-password": "Password cuts a key",
  },
  3: {
    login: "Departure board",
    signup: "Membership card press",
    "forgot-password": "Typewriter",
    verify: "Safe tumblers",
    "reset-password": "Analogue gauge",
  },
  4: {
    login: "Silk drapes that part and close",
    signup: "An invitation written live",
    "forgot-password": "A stitch for every letter",
    verify: "A strand of six pearls",
    "reset-password": "A monogram gilded in gold",
  },
  5: {
    login: "Koi pond that ripples as you type",
    signup: "A fern that unfurls",
    "forgot-password": "Fireflies fill a lantern",
    verify: "Six lotuses bloom",
    "reset-password": "Growth rings of a tree",
  },
  6: {
    login: "Aurora that answers your typing",
    signup: "A snowflake unique to you",
    "forgot-password": "A compass finds north",
    verify: "Six moons fall into line",
    "reset-password": "Ice shards rise and cap",
  },
};

export function authHref(set: AuthSetId, screen: AuthScreenId) {
  const query = screen === "verify" ? "?email=you@studio.com" : "";
  return `/auth/${set}/${screen}${query}`;
}

export const authItems: KitItem[] = authSets.flatMap((set) =>
  authScreens.map((screen) => ({
    name: `${screen.name} ${set.id}`,
    href: authHref(set.id, screen.id),
    note: screenNotes[set.id][screen.id],
  })),
);

export const kitPages: KitItem[] = [
  { name: "404", href: "/does-not-exist", note: "ASCII sharks" },
  { name: "Loaders", href: "/kit/loaders", note: "Thirteen ways to wait" },
  { name: "Buttons", href: "/kit/buttons", note: "Variants, sizes, loading and focus" },
  { name: "Error pages", href: "/error/400", note: "ASCII sharks for 19 error codes, one link each" },
];

export const kitEffects: KitItem[] = [
  { name: "Wave text", href: "/kit/effects/wave-text", note: "Text flips along a live wave" },
  { name: "Ink tide", href: "/kit/effects/ink-tide", note: "Liquid that inverts type" },
  { name: "Invert lens", href: "/kit/effects/invert-lens", note: "Square lens, exact inversion" },
  { name: "Type river", href: "/kit/effects/type-river", note: "Letters flow around a headline" },
  { name: "Variable swell", href: "/kit/effects/variable-swell", note: "Font axes in motion" },
  { name: "Split flap", href: "/kit/effects/split-flap", note: "Departure board" },
  { name: "Long shadow", href: "/kit/effects/long-shadow", note: "Sundial shadows" },
  { name: "Warp grid", href: "/kit/effects/warp-grid", note: "Bending square grid" },
  { name: "Pendulum type", href: "/kit/effects/pendulum-type", note: "Letters on threads" },
  { name: "Halftone field", href: "/kit/effects/halftone-field", note: "Square-dot print" },
  { name: "Hold button", href: "/kit/effects/hold-button", note: "Press and hold to confirm" },
  { name: "Magnetic button", href: "/kit/effects/magnetic-button", note: "Leans toward the pointer" },
  { name: "Rotary knob", href: "/kit/effects/rotary-knob", note: "A dial with detents" },
  { name: "Wheel picker", href: "/kit/effects/wheel-picker", note: "3D drum with inertia" },
  { name: "Token input", href: "/kit/effects/token-input", note: "Tags with live suggestions" },
  { name: "Velocity marquee", href: "/kit/effects/velocity-marquee", note: "Reacts to scroll speed" },
  { name: "Expanding panels", href: "/kit/effects/expanding-panels", note: "Panels that swell like a lens" },
  { name: "Compare slider", href: "/kit/effects/compare-slider", note: "Before and after divider" },
  { name: "Reading marker", href: "/kit/effects/reading-marker", note: "A pen that follows your scroll" },
  { name: "Image trail", href: "/kit/effects/image-trail", note: "Tiles that land under the pointer" },
  { name: "Flip table", href: "/kit/effects/flip-table", note: "Rows that glide when sorted" },
  { name: "Kanban board", href: "/kit/effects/kanban-board", note: "Throwable cards, shared board" },
  { name: "Toast stack", href: "/kit/effects/toast-stack", note: "Fanning, swipeable alerts" },
  { name: "Treemap shift", href: "/kit/effects/treemap-shift", note: "A treemap you can play" },
  { name: "Force graph", href: "/kit/effects/force-graph", note: "A living network" },
];

/** Every reviewable screen, in the order the Previous and Next buttons follow. */
export const kitItems: KitItem[] = [...authItems, ...kitPages, ...kitEffects];

export { screenNotes };
