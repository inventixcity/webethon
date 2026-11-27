/*
 * The boxed field look for app forms: a square paper-raised box with an ink hairline. The underlined look in
 * Input's default variant is for the sign-in screens. Focus is the 2px cobalt outline from DESIGN.md.
 */
export const boxField =
  "w-full min-w-0 border border-ink bg-paper-raised font-sans text-base text-ink outline-none transition-[border-color,background-color] duration-(--duration-fast) ease-(--ease-enter) placeholder:text-ink-muted hover:bg-paper focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:cursor-not-allowed disabled:border-rule disabled:bg-paper-sunk disabled:text-ink-soft aria-invalid:border-2 aria-invalid:border-vermilion-deep";
