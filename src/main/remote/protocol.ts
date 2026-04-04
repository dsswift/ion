/**
 * Remote control message protocol.
 *
 * These types define the wire format for communication between CODA and
 * the iOS companion app. The same protocol is used over both LAN (direct
 * WebSocket) and relay (encrypted WebSocket via relay server).
 */

import type { NormalizedEvent, TabStatus, PermissionRequest } from '../../shared/types'

// ─── Remote Tab State (lightweight projection for mobile clients) ───

export interface RemoteTabState {
  id: string
  title: string
  customTitle: string | null
  status: TabStatus
  workingDirectory: string
  permissionMode: 'auto' | 'plan'
  permissionQueue: PermissionRequest[]
  lastMessage: string | null
  contextTokens: number | null
  messageCount: number
  queuedPrompts: string[]
  isTerminalOnly?: boolean
  terminalInstances?: TerminalInstanceInfo[]
  activeTerminalInstanceId?: string | null
}

// ─── Terminal instance metadata ───

export interface TerminalInstanceInfo {
  id: string
  label: string
  kind: string    // 'user' | 'commit' | 'cli' | 'tool:*'
  readOnly: boolean
  cwd: string
}

// ─── Wire-friendly message types for conversation sync ───

export interface RemoteMessage {
  id: string
  role: 'user' | 'assistant' | 'tool' | 'system'
  content: string
  toolName?: string
  toolInput?: string
  toolId?: string
  toolStatus?: 'running' | 'completed' | 'error'
  attachments?: RemoteAttachment[]
  timestamp: number
  source?: 'desktop' | 'remote'
}

export interface RemoteAttachment {
  id: string
  type: 'image' | 'file' | 'plan'
  name: string
  path: string
}

// ─── iOS → CODA commands ───

export type RemoteCommand =
  | { type: 'sync' }
  | { type: 'create_tab'; workingDirectory?: string }
  | { type: 'create_terminal_tab'; workingDirectory?: string }
  | { type: 'close_tab'; tabId: string }
  | { type: 'prompt'; tabId: string; text: string; origin?: 'desktop' | 'remote' }
  | { type: 'cancel'; tabId: string }
  | { type: 'respond_permission'; tabId: string; questionId: string; optionId: string }
  | { type: 'set_permission_mode'; tabId: string; mode: 'auto' | 'plan' }
  | { type: 'load_conversation'; tabId: string; before?: string }
  | { type: 'terminal_input'; tabId: string; instanceId: string; data: string }
  | { type: 'terminal_resize'; tabId: string; instanceId: string; cols: number; rows: number }
  | { type: 'terminal_add_instance'; tabId: string }
  | { type: 'terminal_remove_instance'; tabId: string; instanceId: string }
  | { type: 'terminal_select_instance'; tabId: string; instanceId: string }
  | { type: 'request_terminal_snapshot'; tabId: string }
  | { type: 'rename_tab'; tabId: string; customTitle: string | null }
  | { type: 'rename_terminal_instance'; tabId: string; instanceId: string; label: string }
  | { type: 'rewind'; tabId: string; messageId: string }
  | { type: 'fork_from_message'; tabId: string; messageId: string }
  | { type: 'unpair' }

// ─── CODA → iOS events ───

export type RemoteEvent =
  | { type: 'snapshot'; tabs: RemoteTabState[]; recentDirectories?: string[] }
  | { type: 'tab_created'; tab: RemoteTabState }
  | { type: 'tab_closed'; tabId: string }
  | { type: 'tab_status'; tabId: string; status: TabStatus }
  | { type: 'text_chunk'; tabId: string; text: string }
  | { type: 'tool_call'; tabId: string; toolName: string; toolId: string }
  | { type: 'tool_result'; tabId: string; toolId: string; content: string; isError: boolean }
  | { type: 'task_complete'; tabId: string; result: string; costUsd: number }
  | { type: 'permission_request'; tabId: string; questionId: string; toolName: string; toolInput?: Record<string, unknown>; options: Array<{ id: string; label: string; kind?: string }> }
  | { type: 'permission_resolved'; tabId: string; questionId: string }
  | { type: 'error'; tabId: string; message: string }
  | { type: 'conversation_history'; tabId: string; messages: RemoteMessage[]; hasMore: boolean; cursor?: string }
  | { type: 'message_added'; tabId: string; message: RemoteMessage }
  | { type: 'message_updated'; tabId: string; messageId: string; content?: string; toolStatus?: 'running' | 'completed' | 'error'; toolInput?: string }
  | { type: 'queue_update'; tabId: string; prompts: string[] }
  | { type: 'terminal_output'; tabId: string; instanceId: string; data: string }
  | { type: 'terminal_exit'; tabId: string; instanceId: string; exitCode: number }
  | { type: 'terminal_instance_added'; tabId: string; instance: TerminalInstanceInfo }
  | { type: 'terminal_instance_removed'; tabId: string; instanceId: string }
  | { type: 'terminal_snapshot'; tabId: string; instances: TerminalInstanceInfo[]; activeInstanceId: string | null; buffers?: Record<string, string> }
  | { type: 'input_prefill'; tabId: string; text: string; switchTo?: boolean }
  | { type: 'heartbeat'; seq: number; ts: number; buffered: number }
  | { type: 'unpair' }
  | { type: 'relay_config'; relayUrl: string; relayApiKey: string }

// ─── Relay control frames (injected by relay, not by CODA) ───

export interface RelayControlMessage {
  type: 'relay:peer-disconnected' | 'relay:peer-reconnected' | 'relay:paired' | 'relay:ping' | 'relay:pong'
}

// ─── Wire envelope (wraps RemoteEvent for relay transport) ───

export interface WireMessage {
  seq: number
  ts: number               // Unix ms timestamp
  payload?: string         // JSON-encoded RemoteEvent or RemoteCommand (absent when encrypted)
  push?: boolean           // hint to relay: send APNs push if peer is disconnected
  nonce?: string           // base64 12-byte nonce (present when encrypted)
  ciphertext?: string      // base64 encrypted payload (replaces `payload` when encrypted)
  deviceId?: string        // identifies the sending device (set by transport)
}

// ─── Auth handshake (exchanged before any data flows) ───

export interface AuthChallenge {
  type: 'auth_challenge'
  nonce: string            // base64-encoded 32 random bytes
}

export interface AuthResponse {
  type: 'auth_response'
  deviceId: string         // paired device ID
  proof: string            // HMAC-SHA256(nonce, sharedSecret), base64
}

export interface AuthResult {
  type: 'auth_result'
  success: boolean
  reason?: string
}

export type AuthMessage = AuthChallenge | AuthResponse | AuthResult

// ─── Paired device record ───

export interface PairedDevice {
  id: string
  name: string
  pairedAt: string
  lastSeen: string | null
  channelId: string
  /** Base64-encoded shared secret (NaCl secretbox key) */
  sharedSecret: string
  /** APNs device token for push notifications */
  apnsToken?: string
}

// ─── Transport state ───

export type TransportState = 'disconnected' | 'relay_only' | 'lan_preferred'

// ─── Helper: convert NormalizedEvent to RemoteEvent ───

export function normalizedToRemote(tabId: string, event: NormalizedEvent): RemoteEvent | null {
  switch (event.type) {
    case 'text_chunk':
      return { type: 'text_chunk', tabId, text: event.text }
    case 'tool_call':
      return { type: 'tool_call', tabId, toolName: event.toolName, toolId: event.toolId }
    case 'tool_result':
      return { type: 'tool_result', tabId, toolId: event.toolId, content: event.content, isError: event.isError }
    case 'task_complete':
      return { type: 'task_complete', tabId, result: event.result, costUsd: event.costUsd }
    case 'permission_request':
      return {
        type: 'permission_request',
        tabId,
        questionId: event.questionId,
        toolName: event.toolName,
        toolInput: event.toolInput,
        options: event.options,
      }
    case 'error':
      return { type: 'error', tabId, message: event.message }
    default:
      return null
  }
}

// ─── Helper: convert NormalizedEvent to structured message events ───

export function normalizedToMessages(tabId: string, event: NormalizedEvent): RemoteEvent | null {
  switch (event.type) {
    case 'text_chunk':
      // Text chunks update the last assistant message (handled by caller that tracks message state)
      return null
    case 'tool_call':
      return {
        type: 'message_added',
        tabId,
        message: {
          id: event.toolId,
          role: 'tool',
          content: '',
          toolName: event.toolName,
          toolId: event.toolId,
          toolStatus: 'running',
          timestamp: Date.now(),
        },
      }
    case 'tool_result': {
      const content = event.content.length > 2048
        ? event.content.substring(0, 2048) + '\n... [truncated]'
        : event.content
      return {
        type: 'message_updated',
        tabId,
        messageId: event.toolId,
        content,
        toolStatus: event.isError ? 'error' : 'completed',
      }
    }
    default:
      return null
  }
}
