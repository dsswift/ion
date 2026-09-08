import { describe, expect, it, vi } from 'vitest'
import { createCameraDetailTracker } from './graph-camera-detail'
import { LOD_RATIO_THRESHOLD } from './graph-label-priority'

describe('createCameraDetailTracker', () => {
  it('reports the level of detail only when it crosses the threshold', () => {
    const onLod = vi.fn()
    const track = createCameraDetailTracker({ onLod, onLabelZoom: vi.fn() })
    track(1)
    track(2)
    expect(onLod).not.toHaveBeenCalled()
    track(LOD_RATIO_THRESHOLD + 1)
    expect(onLod).toHaveBeenCalledWith('overview', LOD_RATIO_THRESHOLD + 1)
    track(LOD_RATIO_THRESHOLD + 2)
    expect(onLod).toHaveBeenCalledTimes(1)
    track(1)
    expect(onLod).toHaveBeenLastCalledWith('detail', 1)
  })

  it('reports the label zoom in steps, not per frame', () => {
    const onLabelZoom = vi.fn()
    const track = createCameraDetailTracker({ onLod: vi.fn(), onLabelZoom })
    track(1.05)
    track(1.1)
    expect(onLabelZoom).not.toHaveBeenCalled()
    track(2.1)
    expect(onLabelZoom).toHaveBeenCalledWith(2, 2.1)
    track(2.2)
    expect(onLabelZoom).toHaveBeenCalledTimes(1)
  })
})
