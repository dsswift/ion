# ATV shell (Agent Team Visualizer)

An alternative desktop shell: the pixel-art office canvas wrapped in the
overlay's real chrome. Read [ADR-021](../../../../docs/architecture/adr/021-atv-shell-mirror-store.md)
before changing anything here.

| Piece | Where |
|---|---|
| Layout root (mirror boot, TabStrip, marquee, dock, palette) | `AtvShell.tsx` |
| Canvas pane (engine host, tooltips, toolbar) | `AtvApp.tsx` |
| Mirror store boot + owner sync | `state/secondary-store.ts`, `state/hydrate-tabs.ts` |
| Action classification (parity mechanism 2) | `../../shared/atv-mirror-actions.ts` + `state/__tests__/mirror-parity.test.ts` |
| Telemetry (odometers/dashboards/export) | `state/stats.ts` |
| Replay ring | `state/recorder.ts` |
| Sim / render / overlays | `engine/` (`scene-fx.ts`, `render-overlays.ts` for new passes) |
| Procedural office generation | `generation/` (seeded PRNG only — no Date.now/Math.random) |
| Theme packs | `theme/` + `desktop/resources/atv/themes/` |

Rules that bite:
- New store action? Classify it in `atv-mirror-actions.ts` or the parity test fails.
- New main-process event push? Route through `broadcast()` or `make check-atv-parity` fails.
- New shared surface? Mount the overlay's component on the mirror store — never build a bespoke ATV widget for something the overlay already has.
