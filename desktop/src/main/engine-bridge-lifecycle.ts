import { execSync } from 'child_process'
import { existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import type { EngineBridge } from './engine-bridge'
import { log as _log, warn as _warn } from './logger'

function log(msg: string, fields?: Record<string, unknown>): void { _log('engine-bridge', msg, fields) }
function warn(msg: string, fields?: Record<string, unknown>): void { _warn('engine-bridge', msg, fields) }

const ION_HOME = join(homedir(), '.ion')
const SOCKET_PATH = join(ION_HOME, 'engine.sock')

export async function stopAll(bridge: EngineBridge): Promise<void> {
  if (bridge.conn && !bridge.conn.destroyed) {
    bridge.conn.destroy()
  }
  bridge.connected = false
  bridge.conn = null
  if (bridge.reconnectTimer) {
    clearTimeout(bridge.reconnectTimer)
    bridge.reconnectTimer = null
  }
}

/**
 * Stop the engine daemon via launchctl bootout and wait for socket to disappear.
 * bootout removes the agent from the launchd bootstrap namespace, preventing
 * KeepAlive from restarting it until the next desktop launch re-bootstraps.
 */
export async function shutdownAndWait(bridge: EngineBridge, timeoutMs = 3000): Promise<void> {
  bridge.reconnectDisabled = true
  if (bridge.reconnectTimer) {
    clearTimeout(bridge.reconnectTimer)
    bridge.reconnectTimer = null
  }

  bridge._send({ cmd: 'shutdown' })

  if (process.platform === 'darwin') {
    try {
      const uid = process.getuid?.() ?? 501
      const plistPath = join(homedir(), 'Library', 'LaunchAgents', 'com.ion.engine.plist')
      execSync(`launchctl bootout gui/${uid} ${plistPath}`, { timeout: 5000 })
      log('launchctl bootout succeeded')
    } catch (err: any) {
      // 3 = "No such process" (already unloaded). Not an error.
      if (err.status !== 3) {
        warn('engine_bridge: launchctl bootout failed', { error: err.message })
      }
    }
  }

  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!existsSync(SOCKET_PATH)) break
    await new Promise(r => setTimeout(r, 50))
  }

  if (bridge.conn && !bridge.conn.destroyed) {
    bridge.conn.destroy()
  }
  bridge.connected = false
  bridge.conn = null
  if (bridge.reconnectTimer) {
    clearTimeout(bridge.reconnectTimer)
    bridge.reconnectTimer = null
  }
}
