/**
 * Build every channel's resolved `Scale` from the current model and
 * bindings in one pass. Scale domains are computed once per model build
 * (or binding change) here, never per frame — the reducer's job is a map
 * lookup or an interpolation, never a scan.
 */

import { nodeValue, edgeValue } from './dimension-values'
import { buildScale, type Scale } from './scales'
import type { ColorPalette } from '../../../theme-tokens'
import type { ChannelBindings } from '../../../../shared/graph-view-types'
import type { GraphModel } from '../../../../shared/graph-model-types'

export interface ChannelScales {
  nodeColor: Scale
  nodeShape: Scale
  nodeSize: Scale
  edgeColor: Scale
  edgeThickness: Scale
  edgeOpacity: Scale
}

const CHANNEL_KIND: Record<keyof ChannelBindings, 'color' | 'shape' | 'size' | 'thickness' | 'opacity'> = {
  nodeColor: 'color',
  nodeShape: 'shape',
  nodeSize: 'size',
  edgeColor: 'color',
  edgeThickness: 'thickness',
  edgeOpacity: 'opacity',
}

const NODE_CHANNELS: (keyof ChannelBindings)[] = ['nodeColor', 'nodeShape', 'nodeSize']

export function buildChannelScales(model: GraphModel, bindings: ChannelBindings, colors: ColorPalette): ChannelScales {
  const result = {} as ChannelScales
  for (const channel of Object.keys(bindings) as (keyof ChannelBindings)[]) {
    const binding = bindings[channel]
    const kind = CHANNEL_KIND[channel]
    if (!binding.dimension) {
      // An unbound channel still gets a scale object (never a code path
      // that skips it), built from an empty sample so every apply() call
      // resolves to the channel's fixed unknown/unbound appearance.
      result[channel] = buildScale(kind, binding.valueType, [], colors)
      continue
    }
    const values = NODE_CHANNELS.includes(channel)
      ? model.nodes.map((n) => nodeValue(n, binding.dimension!))
      : model.edges.map((e) => edgeValue(e, model, binding.dimension!))
    result[channel] = buildScale(kind, binding.valueType, values, colors)
  }
  return result
}
