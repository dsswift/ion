/**
 * The renderer's door to profile capture (`shared/desktop-ipc.ts`,
 * `PROFILE_CAPTURE`): one `invoke` handler over `ProfileCapturer`, wired to
 * this desktop's device policy, data dir, and Studio window.
 */
import { ipcMain } from 'electron'
import { dataDir } from '@ion/server/paths'
import { DESKTOP_IPC } from '../../shared/desktop-ipc'
import { devicePolicy } from '../device-policy'
import { state } from '../state'
import { log } from '../logger'
import { ProfileCapturer } from './profile-capture'
import { rendererDebugger } from './renderer-profile'

export function registerProfilingIpc(): void {
  const capturer = new ProfileCapturer({
    policy: devicePolicy,
    dataDir,
    rendererDebugger: () => rendererDebugger(state.studioWindow?.webContents),
  })
  ipcMain.handle(DESKTOP_IPC.PROFILE_CAPTURE, (_event, request: unknown) => capturer.capture(request))
  log('profiling', 'profile capture ipc registered')
}
