# Palette conversion and upstream inventory

The browser build tokenizes the **pinned local source** in
`src/themes/blueprint.css`, then appends `palette.css`. The upstream CSS is kept
byte-for-byte as the reviewable original/fallback inventory. The generated
`dist/chrome/theme.js` contains the finished CSS; the browser does not receive
the converter, parse the graph's CSS, or rewrite colors with runtime regular
expressions. `blueprint.mjs` and `upstream.mjs` are build-time modules only.

This is deliberately a build-time implementation of the proposal's CSS
tokenization, rather than a 4,000-line mechanical source diff. A changed source
hash fails the build and requires a new review. Both the original file hash and
`add_css.sh`'s newline-to-space hash are packaged for the companion to recognize
the supported installed stylesheet.

## Role decisions

| Context | Local role |
| --- | --- |
| Page/root/main article, diagram and graph canvas | Required `background` |
| Body/headings/general text | Required `foreground` |
| Menus, dialogs, sidebars, cards, input/code surfaces | Small foreground/background mixes; not a terminal color guessed to be a web surface |
| Secondary labels, tags, placeholders | 94% foreground + 6% background, rather than the often unreadable terminal `muted`/`dark_foreground` |
| Disabled text | Separate lower-contrast role; active `:not(:disabled)` selectors are not mistaken for disabled states |
| Links and semantic text | Named color with foreground mixed in for readable pale accents on light backgrounds |
| Focus/indicator/border accents | `accent` → `blue` → `foreground` |
| Danger/success/warning and syntax colors | Named red/green/orange/etc. → accent; syntax strings and property names distinguish the same original literal by selector |
| Selected text | Explicit selection background/foreground, or a background/accent mix and foreground |
| Solid intent buttons, selected dates, checked controls, pills | Foreground-tinted accent/status fill with background-colored text; hover and active fills are separate |
| Tooltips, normal Blueprint tags, shortcut badges, slider labels | Foreground surface with background ink; not ordinary text/surface mapping |
| Popover arrows | Match their panel or inverse tooltip surface, with separate border ink |
| Hairline shadow outlines | Palette-derived border |
| Blurred elevation shadows / gradient highlights | Separate palette/opacity roles, with original lengths, stops, and shadow order intact |
| Diagram and graph defaults | Semantic custom properties; no blanket SVG/path/node recoloring |

Optional terminal shades remain valid source fields, but are not automatically
promoted to body text or large panel surfaces. Dark-mode elevation can use
`darker_background`. Available bright red/yellow/green/cyan/blue/magenta fields
feed their dark-mode semantic roles, falling back to their normal names.

The map is a reviewed list of Blueprint literals plus property/selector context,
not a nearest-color algorithm and not a list of Omarchy theme names. In
particular, the original light warning button's red literal still maps to
**warning**, and white differs between surfaces, ordinary dark text, and inverse
actions. Every changed value retains its exact original literal as a `var()`
fallback, including complete RGB(A), HSL(A), shadow colors, gradient stops, and
the upstream custom property's invalid-looking `rgba(#e1e8ed, 0.2)` spelling.

## Mode authority and content boundaries

All 620 `prefers-color-scheme: dark` blocks are retained. A zero-specificity
selector condition gates **only those blocks** while local following is active,
including pseudo-elements and root selectors. Their explicit `.bp3-dark` rules
were compared to the original declarations: every OS-dark rule already has a
counterpart, so no missing branch needed adding. The companion's root
`bp3-light`/`bp3-dark` classes select the local branches; `palette.css` explicitly
sets the native control color scheme from `data-omarchy-mode`. Responsive media,
layout, fonts, spacing, and declaration order do not change.

Every original inversion filter is literal-backed and resolves to `none` only
while following. Direct diagram/graph colors therefore are not inverted a
second time. Authored diagram fills, edge colors, SVGs, images, Mermaid content,
and color-picker swatches are not rewritten or counter-inverted. Only the
diagram's default custom properties change, so authored inline properties can
still override them. Mermaid-authored SVG styling is left to its renderer; this
is not a Mermaid theme/content rewriter.

The intentionally preserved color values are:

- 16 declarations in the existing authored-yellow-span rules, including their
  fixed contrasting text. They retain Blueprint's content-highlighter colors.
- Four white backgrounds for WorkBench embedded HTML documents, whose contents
  are not under this theme's control.
- 232 fully transparent colors in invisible shadows and gradient endpoints.
  Transparency remains transparency; it is not turned into a visible palette
  role.
- The four Zotero-Roam legacy comma-separated HSL channel tuples. Their actual
  color-valued custom properties (`--zr-accent-1`, `--zr-negative-co`, etc.) and
  Blueprint's plugin UI rules are tokenized. CSS cannot derive a legacy comma
  tuple from an arbitrary hex color; a third-party plugin that independently
  computes colors from those old tuples is outside this stylesheet's coverage.

## Checks performed with disposable data

The converter currently produces 4,197 color replacements and 14 filter
replacements. A structural round-trip check unwraps all 4,211 fallbacks and
recovers every original declaration in all 2,867 style rules exactly; selectors
only differ by the zero-specificity OS gates. Both supported hashes and all
referenced semantic-role definitions were checked. Two builds produced an
identical safely serialized JavaScript bundle, evaluated successfully in a
fresh Node VM.

An isolated headless Chrome fixture, **not Sylva or an installed extension**,
compared representative computed styles against stock Blueprint with following
off in Auto, explicit light, and explicit dark modes while the emulated OS was
dark: no differences across the checked colors, shadows, borders, filters,
typography, sizes, and spacing. Local mode/background/foreground, authored node
colors, graph/diagram filters, and authored highlights were then exercised with
all 22 installed resolved palettes, a previously unknown synthetic palette,
and required-background/foreground-only light and dark palettes. No desktop
theme switch or user-config installation was performed.

For those 25 inputs, sampled body, secondary, link, primary-button, tooltip, and
selected-text contrast exceeded 4.5:1; the lowest packaged-palette values were
6.66:1 body, 5.66:1 secondary, 5.26:1 link, 5.69:1 button, and 4.88:1 selection.
Sampled danger/success/warning buttons, normal tags, pills, tooltip code,
shortcut badges, and default highlights also exceeded 4.5:1 (minimum 5.57:1).
These checks do not guarantee arbitrary imported palettes are accessible. A
palette's own foreground/background or explicitly supplied selection pair can
be unreadable, and plugin-specific inline styles can bypass inheritance. The
main implementation's isolated visual/replacement checks remain a separate
acceptance step. No permanent UI test framework was added.
