# Ion Desktop Style Guide — Default (Dark) Theme

The reference for how the Ion desktop renderer is colored, layered, and made
interactive. New components and refactors follow this guide; deviations are
defects. The machine-enforced half of this guide lives in tests
(`src/renderer/theme/palette-parity.test.ts`,
`src/renderer/theme/hardcoded-colors-scan.test.ts`) — this document is the
human-readable contract behind them.

## Principles

1. **Neutral base, one accent.** Surfaces are cool near-black neutrals. Blue
   (`accent`, `#366FFB` in dark) is reserved for primary actions, the input
   focus treatment, selection emphasis, and running state. If everything is
   blue, nothing is.
2. **Layer with alpha, not hue.** Elevation and interaction depth come from
   white-alpha layers on dark (black-alpha on light): 4% hover, 6–8% borders,
   ~8% input shell, 10% pressed. Never invent a new gray; pick the layer.
3. **Amber means "needs attention."** Permission prompts, waiting-on-children,
   warnings. Emerald = success/complete, red = error/destructive, blue-400 =
   info. Semantic hue is never decorative.
4. **Every color is a token.** Components read colors exclusively from
   `useColors()`. The scan test fails the build on raw literals; the escape
   hatch (`// hardcoded-ok: <reason>`) exists only for genuinely theme-neutral
   values (pure-black scrims handled by the `scrim` token, brand colors,
   values computed from runtime data).
5. **Every interactive element answers to the keyboard.** Focus-visible is not
   optional chrome; it is part of the component.

## Theme architecture

| Piece | Where |
|---|---|
| Palettes (dark / light / classic / hud) | `desktop/src/renderer/theme/palette-{dark,light,classic,hud}.ts` |
| Registry, CSS-var sync, scales | `desktop/src/renderer/theme-tokens.ts` |
| Reactive hook | `useColors()` via `desktop/src/renderer/theme.ts` |
| CSS variables | `--ion-<kebab-token>` synced by `syncTokensToCss()` |
| Interactive-state CSS | `.ion-focusable`, `.ion-input-shell` in `index.css` |
| Pointer-state hook | `useInteractiveState()` / `interactiveBg()` in `hooks/useInteractiveState.ts` |

`ColorPalette` is a mapped type over `darkColors` — a token added to the dark
palette will not compile until it exists in all four palettes. Theme selection
is single-axis: every built-in theme declares its scheme via
`forcedColorScheme` and the theme picker is the only control (there is no
separate dark/light toggle). Jarvis HUD and Ion Classic (the preserved
original warm palette) are fully self-contained (no spread) and pinned by
freeze tests: changes to Ion Dark can never alter them.

### Adding a token

1. Add the key to `palette-dark.ts` (with its section comment), then satisfy
   the compiler in `palette-light.ts`, `palette-classic.ts`, and
   `palette-hud.ts`. For HUD and Classic, pick values that preserve each
   theme's current look (cyan family / classic warm family, or pinned value).
2. If the HUD or Classic value pins pre-existing rendering, add it to the
   frozen maps in `palette-parity.test.ts`.
3. The CSS variable appears automatically (`--ion-my-token`); nothing else to
   wire.
4. Consume via `colors.myToken` — never copy the value.

## Token reference (dark theme)

Values below are the dark palette; light mirrors with black-alpha layering and
600-weight hues; Classic preserves the original warm palette verbatim; HUD is
its own frozen cyan system. Classic and HUD are freeze-tested.

### Surfaces and layering

| Token | Value | Role |
|---|---|---|
| `containerBg` | `#131316` | Base glass surface (windows, panels, pills) |
| `containerBgCollapsed` | `#101013` | Collapsed container variant |
| `codeBg` | `#0e0e11` | Code blocks — one layer below base |
| `surfacePrimary` | `#1e1e23` | First solid layer above base (headers, bubbles) |
| `surfaceSecondary` | `#26262c` | Second solid layer (nested chips, dividers) |
| `popoverBg` / `toolBg` | `#1a1a1f` | Floating menus / tool cards |
| `inputPillBg` | `#26262b` | The prompt input shell |
| `surfaceHover` | white 4% | Pointer-over layer |
| `surfaceActive` | white 7% | Activated-but-not-pressed layer |
| `surfacePressed` | white 10% | Mouse-down layer |
| `surfaceSelected` | white 4% | Selected rows (pair with `fontWeight: 500`) |
| `containerBorder` | white 8% | Card/panel edges |
| `borderSubtle` / `inputBorder` | white 6% | Hairlines, resting input edge |
| `scrim` | black 40% | Modal backdrops — always this token |

### Accent and focus

| Token | Value | Role |
|---|---|---|
| `accent` | `#366FFB` | Primary actions, links, running state, selection emphasis |
| `accentHover` / `accentPressed` | `#2B60EA` / `#2453D3` | Accent button states |
| `accentLight` / `accentSoft` | blue 12% / 18% | Accent-tinted fills (menu selection, badges) |
| `accentBorder` / `accentBorderMedium` | blue 22% / 32% | Accent-tinted borders |
| `focusBorder` | `#366FFB` | Focus-visible border (used by `.ion-focusable`) |
| `focusRing` | blue 24% | The 3px outer focus ring |
| `sendBg` / `sendHover` / `sendDisabled` | accent family | Send button |
| `textOnAccent` / `textOnAccentMuted` | white / white 70% | Text and dimmed text on any solid status/accent fill |

### Text

`textPrimary #f5f5f5` → `textSecondary #b9b9c0` → `textTertiary #818188` →
`placeholder #6b6b73` → `textMuted #2e2e33` (muted is a *surface-grade* tone
for separators, not readable text). UI chrome defaults to `textTertiary` and
brightens on interaction; content defaults to `textPrimary`.

### Semantic families

| Family | Fill / dot | Foreground text | Tinted background |
|---|---|---|---|
| Info | `statusCompacting` | `infoFg` | `infoBg` |
| Success | `statusComplete` | `successFg` | `statusCompleteBg`, `permissionAllowBg` |
| Warning / attention | `statusWarning`, `statusPermission` | `warningFg` | `permissionHeaderBg` |
| Danger | `statusError`, `stopBg` | `dangerFg` | `statusErrorBg`, `permissionDenyBg` |
| Bash mode | `statusBash` | — | `bashModeRing` (input inset) |

Status dots: `statusIdle` gray, `statusRunning` blue (pulse), `statusCompacting`
blue-400, `statusWaitingChildren` amber-400 + glow, `statusPermission` amber-500
+ glow, `statusComplete` emerald, `statusError`/`statusDead` red, `statusBash`
pink + glow. Running foreground work is blue; amber always means the system is
waiting on something.

Domain sets: `git*` (Added/Modified/Deleted/Renamed/Untracked/Conflict),
`diff*`, `mode*` (thinking violet, accept-edits teal), `icon*` (file-type
icons), `ansi*` (terminal 16-color), `bubble*` (user-bubble prose), tab tokens
(`tabActive`, `tabActiveBorder`, `tabHover`, glow pairs), timeline, scrollbar,
mic, permission card sets. See `palette-dark.ts` — the file is the by-name
reference; do not restate values elsewhere.

### Scales

- **Radius** (`radius` in `theme-tokens.ts`): sm 6 (chips, inline inputs),
  md 8 (menus, cards), lg 10 (dialog inners, code blocks), xl 14 (bubbles).
  Pills/circles use `spacing.pillRadius`.
- **Transitions** (`transitions`): `fast` 120ms (glyph motion — chevron
  rotation), `base` 150ms (hover/pressed/focus color and background), `slow`
  250ms (panel-level). Framer Motion springs (`motion.spring`) handle layout
  animation; do not hand-roll durations.

## Interactive states — the contract

Every interactive element defines all applicable states. The standard stack:

| State | Treatment | Mechanism |
|---|---|---|
| Base | Component-specific tokens | inline style |
| Hover | `surfaceHover` bg (or documented color swap, e.g. icon buttons tertiary → accent) | `useInteractiveState().hover` |
| Pressed | `surfacePressed` bg; send button may scale 0.97 | `useInteractiveState().pressed` |
| Focus (keyboard) | `focusBorder` + 3px `focusRing` | `.ion-focusable` class |
| Focused input shell | same, on the container | `.ion-input-shell` class |
| Selected | `surfaceSelected` bg + `fontWeight: 500` (menus with an accent convention use `accentLight` bg + `accent` text) | inline style |
| Disabled | `opacity: 0.45`, `cursor: 'default'`, handlers inert | inline style |
| Drag-over | `dragOverBg` + inset 1px `dragOverBorder` | inline style |
| Drag insertion | 2px `dragInsertIndicator` bar | inline style |

Rules of composition:

- **CSS owns keyboard focus, the hook owns the pointer.** `:focus-visible`
  cannot be expressed inline, and inline token values cannot be driven by
  `:hover`. Never fake a focus ring with onFocus handlers (it would fire on
  mouse clicks too) and never add hover via CSS color literals.
- `interactiveBg(colors, { hover, pressed, selected }, base)` is the canonical
  cascade — use it instead of nested ternaries.
- Mode rings beat focus rings: an inline `boxShadow` (bash-mode ring)
  intentionally overrides the class ring while active.
- Transitions on interactive properties use `transitions.base`. An element
  that changes state instantly is a defect.
- Disabled elements do not respond to hover/pressed — gate the handlers, not
  just the colors.

### Recipes

Icon button:

```tsx
const { hover, pressed, handlers } = useInteractiveState()
<button
  className="ion-focusable"
  {...handlers}
  style={{
    color: hover ? colors.accent : colors.textTertiary,
    background: pressed ? colors.surfacePressed : 'transparent',
    borderRadius: radius.sm,
    transition: `color ${transitions.base}, background ${transitions.base}`,
  }}
/>
```

Selectable row (tree row, menu item) — one component per row so the hook is
legal:

```tsx
const { hover, pressed, handlers } = useInteractiveState()
<div
  {...handlers}
  style={{
    background: interactiveBg(colors, { hover, pressed, selected }),
    fontWeight: selected ? 500 : 400,
    transition: `background ${transitions.base}`,
  }}
/>
```

Disclosure (folders, collapsible sections): always the shared `Chevron`
component — one caret rotated by state, never a two-icon swap.

Text-input container: `className="glass-surface ion-input-shell"` on the
shell; the inner textarea keeps `outline: none` (global reset) and the shell
lights up via `:focus-within`.

## Iconography

Phosphor icons only (`@phosphor-icons/react`). Sizes: 8px status dots, 10px
chevrons, 14px tree/menu icons, 16–17px action buttons. Icon color follows the
text-token ladder unless the icon is semantic (file types → `icon*` tokens,
status → status tokens). `weight="fill"` for solid glyphs, default otherwise.

## Typography and scale contract

Ion has four independent desktop scale axes.

- **Interface scale** changes UI chrome, geometry, icons, controls, and spacing. It is a Desktop Appearance setting only. Cmd/Ctrl zoom shortcuts never change it.
- **Data-view scale** changes read-only long-form data: conversation text and output, plans, resources, Markdown previews, diffs, merge text, and their empty/error states.
- **Editor scale** changes only editable CodeMirror text.
- **Terminal scale** changes only xterm cells.

Mixed surfaces must mark these boundaries in code. Headers, menus, buttons, tabs, status rows, labels, and action affordances are interface chrome. Readable document or transcript payload is data. A UI scale change must not change data-view, editor, or terminal text size. A data-view scale change must update every data host, in Overlay and Studio, without changing chrome.

Root `document.documentElement.style.zoom` owns interface scale. `TypographySync` applies it in both renderer windows and applies the compensated `--ion-data-font-size`, `--ion-data-code-font-size`, `--ion-editor-font-size`, and canonical `--ion-font-mono` CSS variables. Do not set root zoom directly in a preference setter. New typography consumers use those variables instead of literal pixel font sizes.

CSS zoom creates viewport-pixel and zoomed-CSS coordinate spaces. `viewport-zoom.ts` owns conversion. A `position: fixed` implementation must use `zoomRect`, `zoomViewport`, and point/delta helpers as applicable. `useAnchoredPopover` accepts an explicit anchor coordinate space. Do not combine raw `getBoundingClientRect()`, `clientX`/`clientY`, or `window.innerWidth`/`window.innerHeight` with CSS fixed coordinates.

## Do / Don't

- **Do** read every color from `useColors()`; the scan test is the enforcement.
- **Do** add `.ion-focusable` to every new `<button>` and focusable control.
- **Do** put new tokens in all four palettes and pin HUD's and Classic's values.
- **Don't** hand-encode hex/rgba in components — including "just this shadow."
  Shadows have tokens (`cardShadow`, `containerShadow`, `popoverShadow`).
- **Don't** concatenate alpha onto token hex strings (`colors.accent + '22'`);
  use the rgba tokens (`accentLight`, `accentBorder`, ...). Runtime user data
  (tab pill colors) is the one exception.
- **Don't** swap icon pairs for open/close state — rotate one `Chevron`.
- **Don't** restate token values or counts in docs or comments; link to
  `palette-dark.ts`.
- **Don't** reach for `darkColors` directly in overlay components —
  `useColors()` keeps Ion Light and HUD working. (The Studio shell is the
  sanctioned dark-only exception.)

## Verification for UI changes

`npm run typecheck` · `npm run lint` · `npx vitest run src/renderer/theme`
(parity + freeze + scan gates) · scoped component tests · smoke in
`npm run dev` across Ion Dark, Ion Light, Ion Classic, and Jarvis HUD
(Classic and HUD must be unaffected by dark-palette work).
