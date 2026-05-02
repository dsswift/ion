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
} from './handlers/tabs'
import {
  handleEnginePrompt,
  handleEngineAbort,
  handleEngineDialogResponse,
  handleEngineAddInstance,
  handleEngineRemoveInstance,
  handleEngineSelectInstance,
  handleLoadEngineConversation,
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
import type { RemoteCommand } from './protocol'

function log(msg: string): void {
  _log('main', msg)
}

export async function handleRemoteCommand(cmd: RemoteCommand, deviceId: string): Promise<void> {
  log(`remote command: ${cmd.type}`)
  switch (cmd.type) {
    case 'sync': await handleSync(); break
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
    case 'load_conversation': await handleLoadConversation(cmd); break
    case 'engine_prompt': await handleEnginePrompt(cmd); break
    case 'engine_abort': handleEngineAbort(cmd); break
    case 'engine_dialog_response': handleEngineDialogResponse(cmd); break
    case 'engine_add_instance': await handleEngineAddInstance(cmd); break
    case 'engine_remove_instance': await handleEngineRemoveInstance(cmd); break
    case 'engine_select_instance': await handleEngineSelectInstance(cmd); break
    case 'load_engine_conversation': await handleLoadEngineConversation(cmd); break
    case 'terminal_input': handleTerminalInput(cmd); break
    case 'terminal_resize': handleTerminalResize(cmd); break
    case 'terminal_add_instance': await handleTerminalAddInstance(cmd); break
    case 'terminal_remove_instance': await handleTerminalRemoveInstance(cmd); break
    case 'request_terminal_snapshot': await handleRequestTerminalSnapshot(cmd); break
    case 'terminal_select_instance': await handleTerminalSelectInstance(cmd); break
    case 'rename_tab': handleRenameTab(cmd); break
    case 'rename_terminal_instance': handleRenameTerminalInstance(cmd); break
    case 'rewind': await handleRewind(cmd); break
    case 'fork_from_message': await handleForkFromMessage(cmd); break
    case 'set_tab_group_mode': await handleSetTabGroupMode(cmd); break
    case 'unpair': handleUnpair(deviceId); break
  }
}
