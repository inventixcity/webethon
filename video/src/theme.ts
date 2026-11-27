import { loadFont as loadDisplay } from "@remotion/google-fonts/BricolageGrotesque";
import { loadFont as loadMono } from "@remotion/google-fonts/JetBrainsMono";

export const display = loadDisplay("normal", { weights: ["400", "500", "600", "700", "800"], subsets: ["latin"] }).fontFamily;
export const mono = loadMono("normal", { weights: ["400", "500", "700"], subsets: ["latin"] }).fontFamily;

/** The site's palette: ivory paper, ink, and the three accents. */
export const c = {
  paper: "#F3EEE3",
  paperRaised: "#FAF7F0",
  paperSunk: "#E9E3D6",
  ink: "#12110E",
  inkSoft: "#4A463E",
  inkMuted: "#7A7468",
  rule: "#D6CFBF",
  cobalt: "#2B4FD8",
  vermilion: "#D23A1C",
  amber: "#E0862C",
  night: "#0D0C0A",
};

export const FPS = 30;
