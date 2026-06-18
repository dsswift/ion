import { log as _log } from '../logger'
import { sessionPlane, deviceFocusMap } from '../state'
import {
  handleSync,
  handleCreateTab,
  handleCreateTerminalTab,
  handleCreateEngineTab,
  handleCloseTab,
  handlePrompt,
  handleCancel,
  handleSetPermissionMode,
  handleSetThinkingEffort,
  handleLoadConversation,
  handleDiscoverCommands,
  handleSetTabModel,
  handleSetPreferredModel,
  handleSetEngineDefaultModel,
} from './handlers/tabs'
import {
  handleSetTabGroupMode,
  handleMoveTabToGroup,
  handleToggleTabGroupPin,
  handleReorderTabGroups,
} from './handlers/tab-groups'
import {
  handleEnginePrompt,
  handleEngineAbort,
  handleResetEngineSession,
  handleEngineDialogResponse,
  handleEngineAddInstance,
  handleEngineRemoveInstance,
  handleEngineMoveInstance,
  handleEngineSelectInstance,
  handleLoadEngineConversation,
  handleLoadAgentConversation,
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
  handleSetPillColor,
  handleSetPillIcon,
} from './handlers/terminal'
import {
  handleRewind,
  handleForkFromMessage,
  handleEngineRewind,
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
  handleFsRename,
  handleUploadAttachment,
} from './handlers/files'
import {
  handleDiagnosticLogsResponse,
} from './handlers/diagnostics'
import { handleLoadAttachments } from './handlers/attachments'
import { handleSetRemoteDisplay } from './handlers/display'
import { handleSetDesktopSetting } from './handlers/desktop-settings'
import { handleRequestResourceContent, handleMarkResourceRead, handleDeleteResource } from './handlers/resources'
import { handleRequestPlanContent } from './handlers/plan-content'
import { handleImplementPlan } from './handlers/implement-plan'
import type { RemoteCommand } from './protocol'

function log(msg: string): void {
  _log('main', msg)
}

export async function handleRemoteCommand(cmd: RemoteCommand, deviceId: string): Promise<void> {
  log(`remote command: ${cmd.type}`)
  switch (cmd.type) {
    case 'desktop_sync': await handleSync(deviceId); break
    case 'desktop_create_tab': await handleCreateTab(cmd); break
    case 'desktop_create_terminal_tab': await handleCreateTerminalTab(cmd); break
    case 'desktop_create_engine_tab': await handleCreateEngineTab(cmd); break
    case 'desktop_close_tab': handleCloseTab(cmd); break
    case 'desktop_prompt': await handlePrompt(cmd); break
    case 'desktop_cancel': handleCancel(cmd); break
    case 'desktop_respond_permission':
      sessionPlane.respondToPermission(cmd.tabId, cmd.questionId, cmd.optionId)
      break
    case 'desktop_set_permission_mode': await handleSetPermissionMode(cmd); break
    case 'desktop_set_thinking_effort': await handleSetThinkingEffort(cmd); break
    case 'desktop_reset_tab_session': sessionPlane.resetTabSession(cmd.tabId); break
    case 'desktop_reset_engine_session': await handleResetEngineSession(cmd); break
    case 'desktop_load_conversation': await handleLoadConversation(cmd, deviceId); break
    case 'desktop_engine_prompt': await handleEnginePrompt(cmd, deviceId); break
    case 'desktop_engine_abort': handleEngineAbort(cmd); break
    case 'desktop_engine_dialog_response': handleEngineDialogResponse(cmd); break
    case 'desktop_engine_add_instance': await handleEngineAddInstance(cmd); break
    case 'desktop_engine_remove_instance': await handleEngineRemoveInstance(cmd); break
    case 'desktop_engine_move_instance': await handleEngineMoveInstance(cmd); break
    case 'desktop_engine_select_instance': await handleEngineSelectInstance(cmd); break
    case 'desktop_engine_set_model': await handleEngineSetModel(cmd); break
    case 'desktop_load_engine_conversation': await handleLoadEngineConversation(cmd, deviceId); break
    case 'desktop_load_agent_conversation': await handleLoadAgentConversation(cmd, deviceId); break
    case 'desktop_terminal_input': handleTerminalInput(cmd); break
    case 'desktop_terminal_resize': handleTerminalResize(cmd); break
    case 'desktop_terminal_add_instance': await handleTerminalAddInstance(cmd); break
    case 'desktop_terminal_remove_instance': await handleTerminalRemoveInstance(cmd); break
    case 'desktop_request_terminal_snapshot': await handleRequestTerminalSnapshot(cmd, deviceId); break
    case 'desktop_terminal_select_instance': await handleTerminalSelectInstance(cmd); break
    case 'desktop_rename_tab': handleRenameTab(cmd); break
    case 'desktop_rename_terminal_instance': handleRenameTerminalInstance(cmd); break
    case 'desktop_set_pill_color': handleSetPillColor(cmd); break
    case 'desktop_set_pill_icon': handleSetPillIcon(cmd); break
    case 'desktop_rewind': await handleRewind(cmd); break
    case 'desktop_fork_from_message': await handleForkFromMessage(cmd); break
    case 'desktop_engine_rewind': await handleEngineRewind(cmd); break
    case 'desktop_set_tab_group_mode': await handleSetTabGroupMode(cmd); break
    case 'desktop_move_tab_to_group': await handleMoveTabToGroup(cmd); break
    case 'desktop_toggle_tab_group_pin': await handleToggleTabGroupPin(cmd); break
    case 'desktop_reorder_tab_groups': await handleReorderTabGroups(cmd); break
    case 'desktop_git_changes': await handleGitChanges(cmd, deviceId); break
    case 'desktop_git_graph': await handleGitGraph(cmd, deviceId); break
    case 'desktop_git_diff': await handleGitDiff(cmd, deviceId); break
    case 'desktop_git_stage': await handleGitStage(cmd); break
    case 'desktop_git_unstage': await handleGitUnstage(cmd); break
    case 'desktop_git_commit': await handleGitCommit(cmd); break
    case 'desktop_git_discard': await handleGitDiscard(cmd); break
    case 'desktop_git_fetch': await handleGitFetch(cmd); break
    case 'desktop_git_pull': await handleGitPull(cmd); break
    case 'desktop_git_push': await handleGitPush(cmd); break
    case 'desktop_git_commit_files': await handleGitCommitFiles(cmd, deviceId); break
    case 'desktop_git_commit_file_diff': await handleGitCommitFileDiff(cmd, deviceId); break
    case 'desktop_fs_list_dir': await handleFsListDir(cmd, deviceId); break
    case 'desktop_fs_read_file': await handleFsReadFile(cmd, deviceId); break
    case 'desktop_fs_read_image': await handleFsReadImage(cmd); break
    case 'desktop_fs_write_file': await handleFsWriteFile(cmd); break
    case 'desktop_fs_rename': await handleFsRename(cmd); break
    case 'desktop_discover_commands': await handleDiscoverCommands(cmd, deviceId); break
    case 'desktop_upload_attachment': await handleUploadAttachment(cmd, deviceId); break
    case 'desktop_set_tab_model': await handleSetTabModel(cmd); break
    case 'desktop_set_preferred_model': await handleSetPreferredModel(cmd); break
    case 'desktop_set_engine_default_model': await handleSetEngineDefaultModel(cmd); break
    case 'desktop_voice_config': handleVoiceConfig(cmd, deviceId); break
    case 'desktop_unpair': handleUnpair(deviceId); break
    case 'desktop_diagnostic_logs_response': handleDiagnosticLogsResponse(cmd, deviceId); break
    case 'desktop_load_attachments': await handleLoadAttachments(cmd, deviceId); break
    case 'desktop_set_remote_display': await handleSetRemoteDisplay(cmd, deviceId); break
    case 'desktop_set_desktop_setting': await handleSetDesktopSetting(cmd, deviceId); break
    case 'desktop_request_resource_content': await handleRequestResourceContent(cmd, deviceId); break
    case 'desktop_mark_resource_read': await handleMarkResourceRead(cmd); break
    case 'desktop_delete_resource': await handleDeleteResource(cmd); break
    case 'desktop_implement_plan': await handleImplementPlan(cmd); break
    case 'desktop_request_plan_content': await handleRequestPlanContent(cmd, deviceId); break
    case 'desktop_report_focus': {
      const { tabId, interceptEnabled } = cmd
      deviceFocusMap.set(deviceId, { tabId, interceptEnabled })
      log(`desktop_report_focus: device=${deviceId} tabId=${tabId} interceptEnabled=${interceptEnabled}`)
      break
    }
  }
}
