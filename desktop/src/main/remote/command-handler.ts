import { log as _log } from '../logger'
import { sessionPlane } from '../state'
import {
  handleSync,
  handleCreateTab,
  handleCreateTerminalTab,
  handleCreateEngineTab,
  handleCloseTab,
  handlePrompt,
  handleCancel,
  handleSetPermissionMode,
  handleLoadConversation,
  handleSetTabGroupMode,
  handleMoveTabToGroup,
  handleToggleTabGroupPin,
  handleReorderTabGroups,
  handleDiscoverCommands,
  handleSetTabModel,
  handleSetPreferredModel,
  handleSetEngineDefaultModel,
} from './handlers/tabs'
import {
  handleEnginePrompt,
  handleEngineAbort,
  handleEngineDialogResponse,
  handleEngineAddInstance,
  handleEngineRemoveInstance,
  handleEngineMoveInstance,
  handleEngineSelectInstance,
  handleLoadEngineConversation,
  handleEngineSetModel,
  handleVoiceConfig,
} from './handlers/engine'
import {
  handleTerminalInput,
  handleTerminalResize,
  handleTerminalAddInstance,
  handleTerminalRemoveInstance,
  handleRequestTerminalSnapshot,
  handleTerminalSelectInstance,
  handleRenameTab,
  handleRenameTerminalInstance,
} from './handlers/terminal'
import {
  handleRewind,
  handleForkFromMessage,
  handleUnpair,
} from './handlers/history'
import {
  handleGitChanges,
  handleGitGraph,
  handleGitDiff,
  handleGitStage,
  handleGitUnstage,
  handleGitCommit,
  handleGitDiscard,
  handleGitFetch,
  handleGitPull,
  handleGitPush,
  handleGitCommitFiles,
  handleGitCommitFileDiff,
} from './handlers/git'
import {
  handleFsListDir,
  handleFsReadFile,
  handleFsReadImage,
  handleFsWriteFile,
  handleUploadAttachment,
} from './handlers/files'
import {
  handleDiagnosticLogsResponse,
} from './handlers/diagnostics'
import { handleLoadAttachments } from './handlers/attachments'
import { handleSetRemoteDisplay } from './handlers/display'
import type { RemoteCommand } from './protocol'

function log(msg: string): void {
  _log('main', msg)
}

export async function handleRemoteCommand(cmd: RemoteCommand, deviceId: string): Promise<void> {
  log(`remote command: ${cmd.type}`)
  switch (cmd.type) {
    case 'sync': await handleSync(deviceId); break
    case 'create_tab': await handleCreateTab(cmd); break
    case 'create_terminal_tab': await handleCreateTerminalTab(cmd); break
    case 'create_engine_tab': await handleCreateEngineTab(cmd); break
    case 'close_tab': handleCloseTab(cmd); break
    case 'prompt': handlePrompt(cmd); break
    case 'cancel': handleCancel(cmd); break
    case 'respond_permission':
      sessionPlane.respondToPermission(cmd.tabId, cmd.questionId, cmd.optionId)
      break
    case 'set_permission_mode': handleSetPermissionMode(cmd); break
    case 'load_conversation': await handleLoadConversation(cmd, deviceId); break
    case 'engine_prompt': await handleEnginePrompt(cmd, deviceId); break
    case 'engine_abort': handleEngineAbort(cmd); break
    case 'engine_dialog_response': handleEngineDialogResponse(cmd); break
    case 'engine_add_instance': await handleEngineAddInstance(cmd); break
    case 'engine_remove_instance': await handleEngineRemoveInstance(cmd); break
    case 'engine_move_instance': await handleEngineMoveInstance(cmd); break
    case 'engine_select_instance': await handleEngineSelectInstance(cmd); break
    case 'engine_set_model': await handleEngineSetModel(cmd); break
    case 'load_engine_conversation': await handleLoadEngineConversation(cmd, deviceId); break
    case 'terminal_input': handleTerminalInput(cmd); break
    case 'terminal_resize': handleTerminalResize(cmd); break
    case 'terminal_add_instance': await handleTerminalAddInstance(cmd); break
    case 'terminal_remove_instance': await handleTerminalRemoveInstance(cmd); break
    case 'request_terminal_snapshot': await handleRequestTerminalSnapshot(cmd, deviceId); break
    case 'terminal_select_instance': await handleTerminalSelectInstance(cmd); break
    case 'rename_tab': handleRenameTab(cmd); break
    case 'rename_terminal_instance': handleRenameTerminalInstance(cmd); break
    case 'rewind': await handleRewind(cmd); break
    case 'fork_from_message': await handleForkFromMessage(cmd); break
    case 'set_tab_group_mode': await handleSetTabGroupMode(cmd); break
    case 'move_tab_to_group': await handleMoveTabToGroup(cmd); break
    case 'toggle_tab_group_pin': await handleToggleTabGroupPin(cmd); break
    case 'reorder_tab_groups': await handleReorderTabGroups(cmd); break
    case 'git_changes': await handleGitChanges(cmd, deviceId); break
    case 'git_graph': await handleGitGraph(cmd, deviceId); break
    case 'git_diff': await handleGitDiff(cmd, deviceId); break
    case 'git_stage': await handleGitStage(cmd); break
    case 'git_unstage': await handleGitUnstage(cmd); break
    case 'git_commit': await handleGitCommit(cmd); break
    case 'git_discard': await handleGitDiscard(cmd); break
    case 'git_fetch': await handleGitFetch(cmd); break
    case 'git_pull': await handleGitPull(cmd); break
    case 'git_push': await handleGitPush(cmd); break
    case 'git_commit_files': await handleGitCommitFiles(cmd, deviceId); break
    case 'git_commit_file_diff': await handleGitCommitFileDiff(cmd, deviceId); break
    case 'fs_list_dir': await handleFsListDir(cmd, deviceId); break
    case 'fs_read_file': await handleFsReadFile(cmd, deviceId); break
    case 'fs_read_image': await handleFsReadImage(cmd); break
    case 'fs_write_file': await handleFsWriteFile(cmd); break
    case 'discover_commands': await handleDiscoverCommands(cmd, deviceId); break
    case 'upload_attachment': await handleUploadAttachment(cmd, deviceId); break
    case 'set_tab_model': await handleSetTabModel(cmd); break
    case 'set_preferred_model': await handleSetPreferredModel(cmd); break
    case 'set_engine_default_model': await handleSetEngineDefaultModel(cmd); break
    case 'voice_config': handleVoiceConfig(cmd, deviceId); break
    case 'unpair': handleUnpair(deviceId); break
    case 'diagnostic_logs_response': handleDiagnosticLogsResponse(cmd, deviceId); break
    case 'load_attachments': await handleLoadAttachments(cmd, deviceId); break
    case 'set_remote_display': await handleSetRemoteDisplay(cmd, deviceId); break
  }
}
