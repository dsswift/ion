/**
 * Device Metrics: what Ion Studio itself uses on the machine it runs on.
 *
 * Studio's Electron processes (main, GPU helper, renderer, utility helpers)
 * belong to the device, not to an Environment: when Studio is connected to a
 * remote server, its GPU load is still the laptop's. So these numbers are read
 * and kept on the device. They never go to a server or to another client.
 */

/** Electron's process kinds, named for people. */
export type DeviceProcessType = 'browser' | 'gpu' | 'renderer' | 'utility' | 'other'

export interface DeviceProcess {
  pid: number
  type: DeviceProcessType
  /** `main`, `gpu`, `renderer`, or a utility's service (`network`, `audio`). */
  name: string
  /** CPU since the previous sample, 100 = one full core. */
  cpuPercent: number
  /** Working set (resident) memory. */
  rssBytes: number
  /**
   * GPU time since the previous sample as a share of wall time, 100 = one
   * GPU fully busy. Null when not measured: the first sample, a platform
   * with no reader yet, or a counter that restarted. Never 0 for "unknown".
   */
  gpuPercent: number | null
}

/** One Device Metrics sample. A complete snapshot; replace, never merge. */
export interface DeviceMetricsSample {
  sampledAt: number
  intervalMs: number
  processes: DeviceProcess[]
  /** Whether a Studio window had focus when the sample was taken. */
  focused: boolean
  /** `active`, `idle`, `locked`, or `unknown`, from the OS. */
  systemIdleState: string
}
