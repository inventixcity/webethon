import fs from "node:fs";
import path from "node:path";
import Image from "next/image";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/*
 * Image slots for the editorial art. Files live in public/images and are added by hand. Each name is checked on
 * the server, so a missing file renders its fallback and never requests a URL that would 404.
 */

const EXTENSIONS = [".webp", ".png", ".jpg"] as const;
const IMAGE_DIR = path.join(process.cwd(), "public", "images");
const NAME = /^[a-z0-9-]+$/;
const production = process.env.NODE_ENV === "production";
const cache = new Map<string, string | null>();

/** The public URL of an image named in public/images, or null when no file exists for it. */
export function artSrc(name: string): string | null {
  if (!NAME.test(name)) return null;
  if (production && cache.has(name)) return cache.get(name) ?? null;
  let found: string | null = null;
  for (const ext of EXTENSIONS) {
    if (fs.existsSync(path.join(IMAGE_DIR, name + ext))) {
      found = `/images/${name}${ext}`;
      break;
    }
  }
  if (production) cache.set(name, found);
  return found;
}

/** True when public/images holds a file for this name (with .webp, .png or .jpg). */
export function hasArt(name: string): boolean {
  return artSrc(name) !== null;
}

type ArtProps = {
  /** File name without extension, for example "hero". */
  name: string;
  /** Alt text. Pass an empty string for a decorative image. */
  alt: string;
  /** Optional dark-mode file, for example "hero-dark". The page swaps between the two with the dark variant. */
  darkName?: string;
  /** Sizes and layout of the frame. The frame is positioned and clipped, so give it a size or an aspect ratio. */
  className?: string;
  /** The image's sizes hint for next/image. */
  sizes?: string;
  /** Load now, for images above the fold. */
  priority?: boolean;
  /** Ink treatment: greyscale and extra contrast, so the image reads as one ink tone with the palette. */
  duotone?: boolean;
  /** Shown in place of the image when no file exists. Absolutely fills the frame. */
  fallback?: ReactNode;
  /** Image position inside the frame, for example "object-right". */
  position?: string;
};

/**
 * A server component. It renders next/image when the file exists, and the fallback when it doesn't. The frame is
 * square-cornered and clipped. Dark mode is picked with CSS, so the page never loads both images in one mode.
 */
export function Art({
  name,
  alt,
  darkName,
  className,
  sizes = "100vw",
  priority = false,
  duotone = false,
  fallback,
  position = "object-center",
}: ArtProps) {
  const light = artSrc(name);
  const dark = darkName ? artSrc(darkName) : null;
  const decorative = alt === "";
  const base = cn("object-cover", position, duotone && "grayscale contrast-125");

  if (!light && !dark) {
    return (
      <div className={cn("relative overflow-hidden", className)} aria-hidden={decorative || undefined}>
        {fallback ? <div className="absolute inset-0">{fallback}</div> : null}
      </div>
    );
  }

  const both = Boolean(light && dark);
  return (
    <div className={cn("relative overflow-hidden", className)} aria-hidden={decorative || undefined}>
      {light ? (
        <Image
          src={light}
          alt={decorative ? "" : alt}
          fill
          sizes={sizes}
          priority={priority}
          className={cn(base, both && "dark:hidden")}
        />
      ) : null}
      {dark ? (
        <Image
          src={dark}
          alt={decorative || light ? "" : alt}
          fill
          sizes={sizes}
          priority={priority && !light}
          className={cn(base, both && "hidden dark:block")}
        />
      ) : null}
    </div>
  );
}
