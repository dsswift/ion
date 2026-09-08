/**
 * What the camera's ratio decides about how the stage draws: the level of
 * detail (points and hulls past the overview threshold) and the label
 * zoom step the reducer's label budget is built for. Both change rarely
 * across a zoom; the tracker reports each only when it does, so the
 * canvas re-installs its reducer a handful of times per zoom, not per frame.
 */

import type { LevelOfDetail } from './graph-reducers'
import { LOD_RATIO_THRESHOLD, quantizeLabelZoom } from './graph-label-priority'

export interface CameraDetailCallbacks {
  onLod(lod: LevelOfDetail, ratio: number): void
  onLabelZoom(labelZoom: number, ratio: number): void
}

/** Returns a function to call with the camera ratio on every camera update. */
export function createCameraDetailTracker(callbacks: CameraDetailCallbacks): (ratio: number) => void {
  let lastLod: LevelOfDetail = 'detail'
  let lastLabelZoom = 1
  return (ratio) => {
    const lod: LevelOfDetail = ratio > LOD_RATIO_THRESHOLD ? 'overview' : 'detail'
    if (lod !== lastLod) {
      lastLod = lod
      callbacks.onLod(lod, ratio)
    }
    const labelZoom = quantizeLabelZoom(ratio)
    if (labelZoom !== lastLabelZoom) {
      lastLabelZoom = labelZoom
      callbacks.onLabelZoom(labelZoom, ratio)
    }
  }
}
