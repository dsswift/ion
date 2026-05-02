// ─── Engine Types (native Ion extension runtime) ───

export interface EngineProfile {
  id: string
  name: string
  extensions: string[]
}

export interface EngineConfig {
  profileId: string
  extensions: string[]
  workingDirectory: string
  sessionId?: string
  model?: string
  maxTokens?: number
  thinking?: { enabled: boolean; budgetTokens?: number }
}

export interface EngineInstance {
  id: string        // crypto.randomUUID().slice(0,8)
  label: string     // "cos 1", "cos 2"
}

export interface EnginePaneState {
  instances: EngineInstance[]
  activeInstanceId: string | null
}

export interface AgentStateUpdate {
  name: string
  status: 'idle' | 'running' | 'done' | 'error'
  metadata?: Record<string, any>
}

/** Process registration handle for per-agent abort/steer */
export interface AgentHandle {
  pid?: number
  stdinWrite?: (message: string) => boolean
  parentAgent?: string
}

export interface StatusFields {
  label: string
  state: string
  sessionId?: string
  team?: string
  model: string
  contextPercent: number
  contextWindow: number
  totalCostUsd?: number
  /** Backend mode: 'api' (direct) or 'cli' (CC CLI proxy) */
  backend?: 'api' | 'cli'
  permissionDenials?: Array<{ toolName: string; toolUseId: string; toolInput?: Record<string, unknown> }>
  /** Friendly display name broadcast by the extension (e.g. "Chief of Staff"). */
  extensionName?: string
}

export type EngineEvent =
  | { type: 'engine_agent_state'; agents: AgentStateUpdate[] }
  | { type: 'engine_status'; fields: StatusFields }
  | { type: 'engine_working_message'; message: string }
  | { type: 'engine_notify'; message: string; level: 'info' | 'warning' | 'error' }
  | { type: 'engine_dialog'; dialogId: string; method: 'select' | 'confirm' | 'input'; title: string; message?: string; options?: string[]; defaultValue?: string }
  | { type: 'engine_harness_message'; message: string; source?: string }
  | { type: 'engine_text_delta'; text: string }
  | { type: 'engine_message_end'; usage: { inputTokens: number; outputTokens: number; contextPercent: number; cost: number } }
  | { type: 'engine_tool_start'; toolName: string; toolId: string }
  | { type: 'engine_tool_end'; toolId: string; result?: string; isError?: boolean }
  | { type: 'engine_dead'; exitCode: number | null; signal: string | null; stderrTail: string[] }
  | { type: 'engine_error'; message: string; errorCode?: string; errorCategory?: string; retryable?: boolean; retryAfterMs?: number; httpStatus?: number }
  | { type: 'engine_permission_request'; questionId: string; permToolName: string; permToolDescription?: string; permToolInput?: Record<string, unknown>; permOptions: Array<{ id: string; label: string; kind?: string }> }
  | { type: 'engine_plan_mode_changed'; planModeEnabled: boolean; planFilePath?: string }
  | { type: 'engine_stream_reset' }
  | { type: 'engine_compacting'; active: boolean }
  | { type: 'engine_extension_died'; extensionName: string; exitCode: number | null; signal: string | null }
  | { type: 'engine_extension_respawned'; extensionName: string; attemptNumber: number }
  | { type: 'engine_extension_dead_permanent'; extensionName: string; attemptNumber: number }
