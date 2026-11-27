import Image from "next/image";
import type { ReactNode } from "react";
import manifest from "@/generated/art-manifest.json";
import { cn } from "@/lib/utils";

/*
 * Image slots for the editorial art. Files live in public/images and are added by hand. The manifest in
 * src/generated/art-manifest.json lists the files that exist (scripts/art-manifest.mjs writes it before dev and
 * build). Lookups are plain object reads, so this module runs on the server and in the browser alike, and a
 * missing file renders its fallback without requesting a URL.
 */

const files: Record<string, string> = manifest;

/** The public URL of an image in public/images, or null when no file exists for it. */
export function artSrc(name: string): string | null {
  return Object.prototype.hasOwnProperty.call(files, name) ? files[name] : null;
}

/** True when public/images holds a file for this name (.webp, .png or .jpg). */
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
  /** Size and clipping of the frame. The frame is positioned, so give it a size or an aspect ratio. */
  className?: string;
  /** The image's sizes hint for next/image. */
  sizes?: string;
  /** Load now, for images above the fold. */
  priority?: boolean;
  /** Ink treatment: greyscale and extra contrast, so the image reads as one ink tone with the palette. */
  duotone?: boolean;
  /** Shown in place of the image when no file exists. Fills the frame. */
  fallback?: ReactNode;
  /** Image position inside the frame, for example "object-right". */
  position?: string;
};

/**
 * Renders next/image when the file exists, and the fallback when it doesn't. The frame is square-cornered and
 * clipped. Dark mode is picked with CSS, so both files are never shown in the same mode.
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
