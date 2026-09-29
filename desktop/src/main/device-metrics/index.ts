/**
 * Wires the Device Metrics sampler into the Electron main process: real
 * `app.getAppMetrics()`, window focus, the OS idle state, Device settings for
 * the idle-repaint limits, desktop.jsonl, and a push to this device's own
 * Studio window. Nothing here reaches a server.
 */
import { app, BrowserWindow, ipcMain, powerMonitor } from 'electron'
import { IPC } from '@ion/shared/types'
import { broadcast } from '../broadcast'
import { readDeviceSettings } from '../device-settings'
import { log, debug, warn } from '../logger'
import { DeviceMetricsSampler, platformGpuReader, thresholdsFromSettings } from './sampler'

const TAG = 'device-metrics'
/** Seconds without input before the OS reports the machine idle. */
const SYSTEM_IDLE_THRESHOLD_SECONDS = 60

let sampler: DeviceMetricsSampler | null = null

export function startDeviceMetrics(): void {
  if (sampler) return
  sampler = new DeviceMetricsSampler({
    appMetrics: () => app.getAppMetrics(),
    gpu: platformGpuReader(),
    focused: () => BrowserWindow.getFocusedWindow() !== null,
    systemIdleState: () => {
      try {
        return powerMonitor.getSystemIdleState(SYSTEM_IDLE_THRESHOLD_SECONDS)
      } catch (err) {
        debug(TAG, 'system idle state unreadable', { error: String(err) })
        return 'unknown'
      }
    },
    thresholds: () => thresholdsFromSettings(readDeviceSettings()),
    publish: (sample) => broadcast(IPC.DEVICE_METRICS, sample),
    log: (level, msg, fields) => {
      if (level === 'warn') warn(TAG, msg, fields)
      else if (level === 'info') log(TAG, msg, fields)
      else debug(TAG, msg, fields)
    },
  })
  ipcMain.handle(IPC.DEVICE_METRICS_WATCH, (_event, on: unknown) => {
    if (typeof on !== 'boolean') {
      warn(TAG, 'device metrics watch rejected: not a boolean', { type: typeof on })
      return sampler?.latest() ?? null
    }
    return sampler?.watch(on) ?? null
  })
  sampler.start()
}
