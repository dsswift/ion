import { registerWindowIpc } from './window'
import { registerSessionIpc } from './session'
import { registerEngineIpc } from './engine'
import { registerBashIpc } from './bash'
import { registerTerminalIpc } from './terminal'
import { registerPermissionsIpc } from './permissions'
import { registerSystemIpc } from './system'
import { registerTranscribeIpc } from './transcribe'
import { registerSessionsListIpc } from './sessions-list'
import { registerFileDialogIpc } from './file-dialog'
import { registerAttachmentsIpc } from './attachments'
import { registerFilesIpc } from './files'
import { registerGitIpc } from './git'
import { registerWorktreeIpc } from './worktree'
import { registerSettingsIpc } from './settings'
import { registerRemoteControlIpc } from './remote-control'

export function registerAllIpc(): void {
  registerWindowIpc()
  registerSessionIpc()
  registerEngineIpc()
  registerBashIpc()
  registerTerminalIpc()
  registerPermissionsIpc()
  registerSystemIpc()
  registerTranscribeIpc()
  registerSessionsListIpc()
  registerFileDialogIpc()
  registerAttachmentsIpc()
  registerFilesIpc()
  registerGitIpc()
  registerWorktreeIpc()
  registerSettingsIpc()
  registerRemoteControlIpc()
}
