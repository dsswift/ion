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

/**
 * Drop the desktop's socket to the engine daemon.
 *
 * Named `stopAll` until it was found to be the reason `EngineControlPlane
 * .shutdown()` ended every conversation on "Quit Desktop": the name promised
 * session teardown, so a shutdown path that called it plus a per-tab
 * `stopSession` loop read as belt-and-suspenders instead of as one wrong
 * decision. It stops nothing. It closes a socket, and the engine's ownership
 * grace window is what decides the fate of the sessions behind it.
 */
export async function disconnect(bridge: EngineBridge): Promise<void> {
  // Block both scheduled and in-flight connections before tearing down the
  // current socket. An in-flight socket can emit connect after conn becomes
  // null; its connect handler must then destroy itself instead of reviving
  // this retired bridge.
  bridge.reconnectDisabled = true

  // Nullify conn BEFORE destroying so the async close handler (which
  // checks bridge.conn === conn) sees a stale socket and does not
  // re-arm the reconnect loop.
  const conn = bridge.conn
  bridge.connected = false
  bridge.conn = null
  if (conn && !conn.destroyed) {
    conn.destroy()
  }
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

  const conn = bridge.conn
  bridge.connected = false
  bridge.conn = null
  if (conn && !conn.destroyed) {
    conn.destroy()
  }
  if (bridge.reconnectTimer) {
    clearTimeout(bridge.reconnectTimer)
    bridge.reconnectTimer = null
  }
}
