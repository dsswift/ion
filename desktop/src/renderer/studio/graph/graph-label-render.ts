/**
 * Label and hover rendering for the graph stage.
 *
 * Sigma's stock drawers are built for a white page: `defaultDrawNodeLabel`
 * paints the label in `labelColor`, whose default is opaque black, to the
 * RIGHT of the node with no width bound, and `defaultDrawNodeHover` paints
 * an opaque white pill behind it. On Ion's dark surfaces that reads as
 * black text on the background and a white slab on hover, and an
 * untruncated label runs the full width of the stage across every node it
 * passes. Both drawers are replaced here with themed, width-bounded
 * versions.
 *
 * A stage label sits centred BELOW its node, the way a caption sits under
 * a figure: the node stays the anchor of its own name, and a label never
 * crosses the edges fanning out of the node's side. Readability against a
 * busy stage comes from a translucent plate under the text — one rounded
 * rectangle per label — which survives any background, where a stroked
 * halo thins out over bright edges.
 *
 * A hub (see `graph-label-priority.ts`) draws heavier and brighter than
 * an ordinary node, so the corpus's landmarks read first at any zoom.
 */

import type { Settings } from 'sigma/settings'
import type { NodeDisplayData, PartialButFor } from 'sigma/types'
import type { ColorPalette } from '../../theme-tokens'
import type { LabelTier } from './graph-label-priority'

/** Widest a stage label may draw, in screen pixels, before it is ellipsized. */
export const MAX_LABEL_WIDTH_PX = 150
/** The hover pill may run wider than a stage label: it is one label, on demand. */
export const MAX_HOVER_LABEL_WIDTH_PX = 260
/** Vertical clearance between the node's bottom edge and the label plate. */
export const LABEL_GAP_PX = 3
/** A hub label is one size up from an ordinary one. */
export const HUB_LABEL_SIZE_BONUS_PX = 1

const PLATE_PADDING_X_PX = 4
const PLATE_PADDING_Y_PX = 2
const PLATE_RADIUS_PX = 3
const RING_WIDTH_PX = 3
const HOVER_PADDING_PX = 6
const HOVER_RADIUS_PX = 5
const ELLIPSIS = '…'

type LabelData = PartialButFor<NodeDisplayData, 'x' | 'y' | 'size' | 'label' | 'color'> & { labelTier?: LabelTier }

/**
 * Shorten `label` until it fits `maxWidth` under the context's current font,
 * appending an ellipsis. Returns the label unchanged when it already fits,
 * and never returns more than the ellipsis itself.
 */
export function truncateToWidth(context: Pick<CanvasRenderingContext2D, 'measureText'>, label: string, maxWidth: number): string {
  if (context.measureText(label).width <= maxWidth) return label

  let low = 0
  let high = label.length
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (context.measureText(label.slice(0, mid) + ELLIPSIS).width <= maxWidth) low = mid
    else high = mid - 1
  }
  return label.slice(0, low) + ELLIPSIS
}

function isHub(data: LabelData): boolean {
  return data.labelTier === 'hub'
}

function labelFontSize(data: LabelData, settings: Settings): number {
  return settings.labelSize + (isHub(data) ? HUB_LABEL_SIZE_BONUS_PX : 0)
}

function applyFont(context: CanvasRenderingContext2D, data: LabelData, settings: Settings): void {
  const weight = isHub(data) ? '600' : settings.labelWeight
  context.font = `${weight} ${labelFontSize(data, settings)}px ${settings.labelFont}`
}

/**
 * Where a label's plate and baseline go for a node: centred horizontally,
 * the plate's top just under the node's disc. Exported so the placement is
 * pinned by a test rather than by reading pixels.
 */
export function labelPlacement(data: Pick<LabelData, 'x' | 'y' | 'size'>, fontSize: number, textWidth: number): { plateX: number; plateY: number; plateWidth: number; plateHeight: number; textX: number; baselineY: number } {
  const plateWidth = textWidth + PLATE_PADDING_X_PX * 2
  const plateHeight = fontSize + PLATE_PADDING_Y_PX * 2
  const plateX = data.x - plateWidth / 2
  const plateY = data.y + data.size + LABEL_GAP_PX
  return {
    plateX,
    plateY,
    plateWidth,
    plateHeight,
    textX: data.x,
    // Alphabetic baseline sits roughly 0.8em below the text's top edge.
    baselineY: plateY + PLATE_PADDING_Y_PX + fontSize * 0.8,
  }
}

/**
 * Draw a stage label: centred under the node on a translucent plate,
 * ellipsized at `MAX_LABEL_WIDTH_PX`, heavier for a hub.
 */
export function createNodeLabelDrawer(colors: ColorPalette): (context: CanvasRenderingContext2D, data: LabelData, settings: Settings) => void {
  return (context, data, settings) => {
    if (!data.label) return
    applyFont(context, data, settings)

    const text = truncateToWidth(context, data.label, MAX_LABEL_WIDTH_PX)
    const textWidth = context.measureText(text).width
    const place = labelPlacement(data, labelFontSize(data, settings), textWidth)

    context.fillStyle = colors.graphLabelPlate
    context.beginPath()
    context.roundRect(place.plateX, place.plateY, place.plateWidth, place.plateHeight, PLATE_RADIUS_PX)
    context.closePath()
    context.fill()

    context.textAlign = 'center'
    context.textBaseline = 'alphabetic'
    context.fillStyle = isHub(data) ? colors.graphLabelHub : colors.graphLabel
    context.fillText(text, place.textX, place.baselineY)
  }
}

/**
 * Draw the hover treatment: a ring around the node plus a themed pill
 * carrying its full label under the node, matching the app's popover
 * surface rather than Sigma's white default.
 */
export function createNodeHoverDrawer(colors: ColorPalette): (context: CanvasRenderingContext2D, data: LabelData, settings: Settings) => void {
  return (context, data, settings) => {
    applyFont(context, data, settings)

    context.fillStyle = colors.graphLabelHalo
    context.beginPath()
    context.arc(data.x, data.y, data.size + RING_WIDTH_PX, 0, Math.PI * 2)
    context.closePath()
    context.fill()

    if (typeof data.label !== 'string' || data.label.length === 0) return

    const text = truncateToWidth(context, data.label, MAX_HOVER_LABEL_WIDTH_PX)
    const textWidth = context.measureText(text).width
    const fontSize = labelFontSize(data, settings)
    const boxWidth = textWidth + HOVER_PADDING_PX * 2
    const boxHeight = fontSize + HOVER_PADDING_PX * 2
    const boxLeft = data.x - boxWidth / 2
    const boxTop = data.y + data.size + LABEL_GAP_PX

    context.fillStyle = colors.popoverBg
    context.strokeStyle = colors.popoverBorder
    context.lineWidth = 1
    context.beginPath()
    context.roundRect(boxLeft, boxTop, boxWidth, boxHeight, HOVER_RADIUS_PX)
    context.closePath()
    context.fill()
    context.stroke()

    context.textAlign = 'center'
    context.textBaseline = 'alphabetic'
    context.fillStyle = isHub(data) ? colors.graphLabelHub : colors.graphLabel
    context.fillText(text, data.x, boxTop + HOVER_PADDING_PX + fontSize * 0.8)
  }
}
