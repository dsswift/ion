/**
 * Studio's own processes, from Electron's `app.getAppMetrics()`.
 */
import type { DeviceProcess, DeviceProcessType } from '@ion/shared/types-device-metrics'

/** The fields of Electron's `ProcessMetric` this module reads. */
export interface AppProcessMetric {
  pid: number
  type: string
  serviceName?: string
  name?: string
  cpu: { percentCPUUsage: number }
  memory: { workingSetSize: number }
}

function processType(type: string): DeviceProcessType {
  switch (type) {
    case 'Browser': return 'browser'
    case 'GPU': return 'gpu'
    case 'Tab': return 'renderer'
    case 'Utility': return 'utility'
    default: return 'other'
  }
}

/** `network.mojom.NetworkService` → `network`; `audio.mojom.AudioService` → `audio`. */
function utilityName(serviceName: string | undefined, name: string | undefined): string {
  const source = serviceName || name || 'utility'
  return source.split('.')[0].toLowerCase()
}

/**
 * Label each Electron process. Electron reports working set in KB and CPU as
 * a percentage of one core since its previous call, which is exactly the
 * interval this sampler runs on.
 */
export function mapAppMetrics(metrics: AppProcessMetric[]): DeviceProcess[] {
  return metrics.map((m) => {
    const type = processType(m.type)
    const name = type === 'browser' ? 'main' : type === 'utility' ? utilityName(m.serviceName, m.name) : type === 'other' ? m.type.toLowerCase() : type
    return { pid: m.pid, type, name, cpuPercent: m.cpu.percentCPUUsage, rssBytes: m.memory.workingSetSize * 1024, gpuPercent: null }
  })
}
