/**
 * Every node `type` the app can assign to a node's `type` attribute (LOD
 * override, shape-channel cycle in channels/scales.ts, pinned and
 * border-tint rendering) must have a program registered here. Sigma throws
 * "could not find a suitable program for node type" for anything else, so
 * an unregistered type here is a live crash, not a cosmetic gap; see
 * graph-node-programs.test.ts for the pinned coverage check.
 *
 * `circle` is re-registered rather than left to Sigma's default: the
 * ordinary node is a disc with a one-pixel outline in `outlineColor`, so
 * two same-coloured neighbours stay two nodes instead of fusing into one
 * blob. `border` is the emphasised variant — a two-pixel ring in
 * `ringColor` — used for pinned nodes and border-tint cluster rendering.
 * Both colours are attributes the reducer sets from the live palette, so a
 * theme switch never needs a program rebuild.
 *
 * Kept in its own module, separate from GraphCanvas.tsx, so a plain test
 * can import this map without pulling in the base `sigma` package — whose
 * module-scope code touches the global `WebGL2RenderingContext`, which
 * jsdom does not define.
 */
import { createNodeBorderProgram } from '@sigma/node-border'
import { NodePointProgram } from 'sigma/rendering'
import { NodeRoundedSquareProgram } from './graph-node-square-program'

/** Attribute the reducer sets on every node: the thin separating outline. */
export const OUTLINE_COLOR_ATTRIBUTE = 'outlineColor'
/** Attribute the reducer sets on a `border` node: the emphasis ring. */
export const RING_COLOR_ATTRIBUTE = 'ringColor'

const OUTLINE_WIDTH_PX = 1
const RING_WIDTH_PX = 2

export const NODE_PROGRAM_CLASSES = {
  circle: createNodeBorderProgram({
    borders: [
      { size: { value: OUTLINE_WIDTH_PX, mode: 'pixels' }, color: { attribute: OUTLINE_COLOR_ATTRIBUTE } },
      { size: { fill: true }, color: { attribute: 'color' } },
    ],
  }),
  border: createNodeBorderProgram({
    borders: [
      { size: { value: RING_WIDTH_PX, mode: 'pixels' }, color: { attribute: RING_COLOR_ATTRIBUTE } },
      { size: { value: OUTLINE_WIDTH_PX, mode: 'pixels' }, color: { attribute: OUTLINE_COLOR_ATTRIBUTE } },
      { size: { fill: true }, color: { attribute: 'color' } },
    ],
  }),
  square: NodeRoundedSquareProgram,
  point: NodePointProgram,
}
