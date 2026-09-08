import type { EngineBridge } from './engine-bridge'
import { resolveEngineAddress, probeEngine } from './engine-address'

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

  // Ask the supervisor to stop the daemon, whatever the supervisor is on this
  // platform. The `shutdown` command above asks the engine to exit, but on
  // every platform a supervisor exists precisely to bring it back -- launchd
  // respawns a booted-in agent, and a Windows Scheduled Task is simply still
  // registered and running. Only the supervisor verb makes the stop stick.
  //
  // This used to be an inline `launchctl bootout` behind a darwin check, so
  // Quit All stopped nothing at all on Windows: the engine kept serving after
  // the desktop exited, and because engine.json is read once at start, a
  // config edit between quit and relaunch was silently ignored by the
  // still-running daemon.
  // Imported lazily: engine-bootstrap reaches the supervisor implementations
  // and through them child_process, and pulling that into this module's static
  // graph makes every engine-bridge test carry a supervisor's dependencies.
  // This path runs once, at quit, so the cost is irrelevant.
  const { stopEngineDaemon } = await import('./engine-bootstrap')
  await stopEngineDaemon()

  // Wait until the engine stops accepting connections. A unix socket file
  // existing proves nothing about liveness (and there is no file at all for
  // the win32 TCP address), so this polls the same connect-probe the
  // readiness wait uses, rather than checking for a path.
  const addr = resolveEngineAddress()
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!(await probeEngine(addr))) break
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
