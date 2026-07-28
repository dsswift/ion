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
import { registerGitExtrasIpc } from './git-extras'
import { registerGitRebaseIpc } from './git-rebase'
import { registerGitConflictsIpc } from './git-conflicts'
import { registerWorktreeIpc } from './worktree'
import { registerWorktreeLifecycleIpc } from './worktree-lifecycle'
import { registerBenchIpc } from './bench'
import { registerSettingsIpc } from './settings'
import { registerRemoteControlIpc } from './remote-control'
import { registerModelsIpc } from './models'
import { registerOAuthIpc } from './oauth'
import { registerProvidersIpc } from './providers'
import { registerConversationBackupIpc } from './conversation-backup'
import { registerLogIpc } from './log'
import { registerAtvIpc } from './atv'
import { registerThemesIpc } from './themes'

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
  registerGitExtrasIpc()
  registerGitRebaseIpc()
  registerGitConflictsIpc()
  registerWorktreeIpc()
  registerWorktreeLifecycleIpc()
  registerBenchIpc()
  registerSettingsIpc()
  registerRemoteControlIpc()
  registerModelsIpc()
  registerOAuthIpc()
  registerProvidersIpc()
  registerConversationBackupIpc()
  registerLogIpc()
  registerAtvIpc()
  registerThemesIpc()
}
