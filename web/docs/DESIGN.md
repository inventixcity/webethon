# Design rules: Ivory & Ink

This file is the single source of truth for how the product looks. Every page and component must follow it.

## Character

Premium editorial print, in motion. Think of a fashion magazine, a Swiss poster and a watchmaker's catalogue.
Confident type, generous space, hairline rules, one sharp accent, and motion that never stops but never shouts.

## Hard rules

1. **Square everything.** `border-radius: 0` on all buttons, inputs, cards, images and frames. No pills or rounded corners anywhere.
2. **Only the palette below.** Use the CSS tokens. No raw hex in components unless a canvas or WebGL context needs resolved values, in which case read the tokens with `getComputedStyle`.
3. **One accent.** Vermilion is rare. Use it for one focal moment per view, not as decoration everywhere.
4. **Only two font families.** Bricolage Grotesque for display and body. JetBrains Mono for labels, data, captions and code.
5. **No gradients as decoration.** No purple. No glassmorphism, no blurred blobs, no soft drop shadows, no glowing edges, no emoji.
6. **No static vector illustrations.** ASCII scenes, Lottie, canvas or WebGL motion only.
7. **Every animation loops or responds continuously.** Nothing plays once and dies, except a short entrance.
8. **Animation responds to the user in real time.** Motion must react to typing, focus, pointer, scroll or state as it happens, not merely play in the background. If nothing changes when the user acts, the animation isn't finished.

## Colour tokens

Defined in `src/app/globals.css`.

| Token | Hex | Use |
|---|---|---|
| `--paper` | `#F3EEE3` | Page background |
| `--paper-raised` | `#FBF8F1` | Raised surfaces, input backgrounds |
| `--paper-sunk` | `#E9E2D3` | Sunken surfaces, disabled states |
| `--ink` | `#12110E` | Primary text, primary buttons, dark panels |
| `--ink-soft` | `#3A372E` | Secondary text |
| `--ink-muted` | `#6B6759` | Tertiary text and captions, meets AA on paper |
| `--vermilion` | `#D23A1C` | The accent: large shapes, focal marks |
| `--vermilion-deep` | `#B92D13` | Accent for small text and hover fills, meets AA with paper |
| `--cobalt` | `#2B4FD8` | Informational accent: info, online, sync and live states. Meets AA on paper (5.6:1) |
| `--cobalt-deep` | `#1E3BB0` | Cobalt for small text, links and hover, 7.9:1 on paper |
| `--amber` | `#E0862C` | Caution accent: integrity indicators, warnings, needs review. Use as a fill with ink text (6.9:1), not as text on paper |
| `--amber-deep` | `#944E0E` | Amber for small text, 5.4:1 on paper and 4.9:1 on sunk. Darkened from `#A85A10`, which only reaches 4.4:1 |

Tailwind classes: `bg-paper`, `bg-paper-raised`, `bg-paper-sunk`, `bg-ink`, `text-ink`, `text-ink-soft`, `text-ink-muted`, `text-paper`, `bg-vermilion`, `text-vermilion-deep`, `border-ink`, `border-rule`, `bg-cobalt`, `text-cobalt-deep`, `border-cobalt`, `bg-amber`, `text-amber-deep`, `border-amber`.

### Accent roles

Three accents, each with one job. Use each sparingly, and only where its meaning is needed.

- **Vermilion is the focal accent.** It is the one mark a view leads with: the focal stat, the focus ring, the page header rule and danger. Keep to one vermilion moment per view.
- **Cobalt is for information and live status.** Use it for info badges, online and sync states, a running exam, and links on hover. Never for danger.
- **Amber is for caution.** Use it for integrity indicators, warnings, and items that need review (review priority medium and high). Never for errors, which stay vermilion.
- Dark mode lightens cobalt and amber so their text passes AA on the dark paper. Read the table above for each value.

`--rule` is a hairline colour: ink at 16% opacity.

The cobalt and amber rows use the light values above. Dark mode uses `#7C97FF` / `#A9BBFF` for cobalt and `#F0A85A` / `#F7C48A` for amber.

## Light and dark

Every screen must work in both modes. The hex values above are the light mode. Dark mode swaps the same token names, so `--paper` becomes the dark page colour and `--ink` becomes the light text colour, and anything built from tokens flips by itself.

- Build pages from `bg-paper text-ink`. Never hard-code a dark page with `bg-ink text-paper`, because it inverts in dark mode.
- `bg-ink text-paper` is right for small solid things like buttons, which should invert.
- To keep one panel fixed in both modes, put `data-theme="dark"` or `data-theme="light"` on it and use normal tokens inside. The vermilion panels and the departure board do this.
- A canvas must read tokens with `getComputedStyle` on its own element, so it picks up the panel's theme, and must recolour when `subscribeTheme` from `@/components/theme/theme` fires. Effects demos restart on a mode change instead, so reading tokens once at start-up is fine there.

## Typography

- Headlines: `font-sans`, weight 500 to 700, tracking `-0.03em`, tight leading (`0.9` to `1`). Set very large and let them dominate. Tighter tracking makes Bricolage's letters collide.
- Body: `font-sans`, 15 to 17px.
- Labels: `font-mono`, 11 to 12px, uppercase, tracking `0.08em` to `0.14em`.

## Space and structure

- Use a strict 12-column feel and an 8px rhythm.
- Prefer 1px hairlines to boxes. Do not nest cards.
- Asymmetry over centring. Let large type crop or sit tight against rules.
- Small mono captions and numbering add the editorial detail, for example `01 / ACCESS`.

## Motion

- Ease: `cubic-bezier(0.22, 1, 0.36, 1)` for entrances.
- Loops are slow and continuous: 6 to 30 seconds per cycle.
- Animate only `transform` and `opacity` in the DOM, or draw on canvas or WebGL.
- Must hold 60fps on a mid-range laptop.
- Always honour `prefers-reduced-motion`: show a designed still frame, never a blank area.
- Pause loops when off-screen or when the tab is hidden.

## Buttons and motion

Use `Button` from `@/components/ui/button`. Do not write button class strings by hand.

- **Variants.** `primary`: ink fill, vermilion wipe on hover. `secondary`: ink outline, ink wipe. `danger`: vermilion fill. `ghost`: text with a `paper-sunk` background on hover. `link`: underlined text. `inverse` and `outline-inverse` are for paper-on-ink panels only.
- **Legacy names.** `default`, `outline` and `destructive` still render, as aliases of `primary`, `secondary` and `danger`. Migrate them when you touch a call site.
- **Sizes.** `sm` 40px, `md` 48px (the default), `lg` 56px, and `icon`, a 48px square. Labels are mono, uppercase, 12px.
- **States.** `loading` keeps the width, shows a square spinner, sets `aria-busy` and stops clicks. `disabled` keeps its size and takes a neutral token look: a panel fill for filled variants, a text-colour step for outline, ghost and link. Labels stay at 4.5:1 or better in both themes, and disabled takes no pointer events. `loading` keeps the variant look. `asChild` gives a link the same styles.
- **Focus.** A 2px vermilion outline with a 2px offset, on `:focus-visible` only. Vermilion is the one accent, and it reads in both themes.
- **Hover and press.** A filled button wipes its colour panel across in 300ms. A press moves the button down 1px. Nothing else moves.
- **Corners.** Square. Never add `rounded-*` to a button.

Motion tokens, defined in `src/app/globals.css` and mirrored in `src/lib/motion.ts`:

| Token | Value | Use |
|---|---|---|
| `--duration-fast` | 150ms | Colour and small state changes |
| `--duration-base` | 200ms | Default for hover, press and reveal |
| `--duration-slow` | 300ms | Large moves, such as the button wipe |
| `--ease-enter` | `cubic-bezier(0.22, 1, 0.36, 1)` | Entrances and answers to the user |
| `--ease-move` | `cubic-bezier(0.65, 0, 0.35, 1)` | Movement between two states |

Use the tokens in CSS (`duration-(--duration-base)`, `ease-(--ease-enter)`). In JavaScript, import `duration`, `durationSeconds`, `easing` and `easingCss` from `@/lib/motion`. Keep the two files in step.

**Reduced motion.** When the visitor prefers reduced motion, the duration tokens become 0ms, and CSS transitions stop. Motion (the `motion` package) and canvas code must call `useReducedMotion()` and pass their transitions through `motionTransition(reduced, transition)`. That lands the animation at its end state at once. A designed still frame still shows, and a colour change still happens, just without the transition.

## Engineering rules

- Next.js 16 App Router, React 19, TypeScript strict, Tailwind 4.
- Interactive components start with `"use client"`.
- No server or browser mismatch: touch `window` only inside effects.
- Clean up every animation frame, listener and observer on unmount.
- Components are theme-agnostic: text comes from props, and colours come from tokens, so a rebrand needs no component edits.
- Every component takes a `className` prop, is responsive from 360px wide, and is accessible.
- Decorative canvases use `aria-hidden`. Any text drawn on a canvas must also exist in the DOM for screen readers.
