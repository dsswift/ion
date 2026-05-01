import { ipcMain } from 'electron'
import { spawn } from 'child_process'
import { IPC } from '../../shared/types'
import { log as _log } from '../logger'
import { state, sessionPlane, bashProcesses } from '../state'
import { getCliEnv } from '../cli-env'

function log(msg: string): void {
  _log('main', msg)
}

export function registerBashIpc(): void {
  ipcMain.handle(IPC.EXECUTE_BASH, async (_event, { id, command, cwd }: { id: string; command: string; cwd: string }) => {
    log(`IPC EXECUTE_BASH [${id}]: ${command} (cwd=${cwd})`)
    return new Promise<{ stdout: string; stderr: string; exitCode: number | null }>((resolve) => {
      const shell = process.env.SHELL || '/bin/bash'
      const child = spawn(shell, ['-lc', command], { cwd, env: getCliEnv(), stdio: ['ignore', 'pipe', 'pipe'] })
      bashProcesses.set(id, child)

      const stdoutChunks: Buffer[] = []
      const stderrChunks: Buffer[] = []

      child.stdout!.on('data', (chunk: Buffer) => stdoutChunks.push(chunk))
      child.stderr!.on('data', (chunk: Buffer) => stderrChunks.push(chunk))

      child.on('close', (code) => {
        bashProcesses.delete(id)
        sessionPlane.notifyExternalWorkDone()
        resolve({
          stdout: Buffer.concat(stdoutChunks).toString('utf-8'),
          stderr: Buffer.concat(stderrChunks).toString('utf-8'),
          exitCode: code,
        })
      })

      child.on('error', (err) => {
        bashProcesses.delete(id)
        sessionPlane.notifyExternalWorkDone()
        resolve({ stdout: '', stderr: err.message, exitCode: 1 })
      })
    })
  })

  ipcMain.on(IPC.CANCEL_BASH, (_event, id: string) => {
    const child = bashProcesses.get(id)
    if (child) {
      log(`IPC CANCEL_BASH [${id}]: sending SIGINT`)
      child.kill('SIGINT')
    }
  })

  ipcMain.on(IPC.REMOTE_SEND, (_event, remoteEvent: any) => {
    state.remoteTransport?.send(remoteEvent)
  })
}
