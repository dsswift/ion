import type {
  ClaudeEvent,
  NormalizedEvent,
  StreamEvent,
  InitEvent,
  AssistantEvent,
  ResultEvent,
  RateLimitEvent,
  PermissionEvent,
  ContentDelta,
} from '../../shared/types'

/**
 * Maps raw Claude stream-json events to canonical CODA events.
 *
 * The normalizer is stateless — it takes one raw event and returns
 * zero or more normalized events. The caller (RunManager) is responsible
 * for sequencing and routing.
 */
export function normalize(raw: ClaudeEvent): NormalizedEvent[] {
  switch (raw.type) {
    case 'system':
      return normalizeSystem(raw as InitEvent)

    case 'stream_event':
      return normalizeStreamEvent(raw as StreamEvent)

    case 'assistant':
      return normalizeAssistant(raw as AssistantEvent)

    case 'result':
      return normalizeResult(raw as ResultEvent)

    case 'rate_limit_event':
      return normalizeRateLimit(raw as RateLimitEvent)

    case 'permission_request':
      return normalizePermission(raw as PermissionEvent)

    case 'user':
      return normalizeUser(raw)

    default:
      // Unknown event type — log for diagnostics
      if (process.env.CODA_DEBUG === '1') {
        console.log(`[event-normalizer] unknown event type: ${raw.type}`, JSON.stringify(raw).substring(0, 300))
      }
      return []
  }
}

function normalizeUser(event: any): NormalizedEvent[] {
  const content = event.message?.content
  if (!Array.isArray(content)) return []

  const results: NormalizedEvent[] = []
  for (const block of content) {
    if (block.type === 'tool_result' && block.tool_use_id) {
      // Content can be a string or an array of content blocks
      let text = ''
      if (typeof block.content === 'string') {
        text = block.content
      } else if (Array.isArray(block.content)) {
        text = block.content
          .filter((c: any) => c.type === 'text' && c.text)
          .map((c: any) => c.text)
          .join('\n')
      }
      results.push({
        type: 'tool_result',
        toolId: block.tool_use_id,
        content: text,
        isError: !!block.is_error,
      })
    }
  }
  return results
}

function normalizeSystem(event: InitEvent): NormalizedEvent[] {
  if (event.subtype !== 'init') return []

  return [{
    type: 'session_init',
    sessionId: event.session_id,
    tools: event.tools || [],
    model: event.model || 'unknown',
    mcpServers: event.mcp_servers || [],
    skills: event.skills || [],
    version: event.claude_code_version || 'unknown',
  }]
}

function normalizeStreamEvent(event: StreamEvent): NormalizedEvent[] {
  const sub = event.event
  if (!sub) return []

  switch (sub.type) {
    case 'content_block_start': {
      if (sub.content_block.type === 'tool_use') {
        return [{
          type: 'tool_call',
          toolName: sub.content_block.name || 'unknown',
          toolId: sub.content_block.id || '',
          index: sub.index,
        }]
      }
      // text block start — no event needed, text comes via deltas
      return []
    }

    case 'content_block_delta': {
      const delta = sub.delta as ContentDelta
      if (delta.type === 'text_delta') {
        return [{ type: 'text_chunk', text: delta.text }]
      }
      if (delta.type === 'input_json_delta') {
        return [{
          type: 'tool_call_update',
          toolId: '', // caller can associate via index tracking
          partialInput: delta.partial_json,
        }]
      }
      return []
    }

    case 'content_block_stop': {
      return [{
        type: 'tool_call_complete',
        index: sub.index,
      }]
    }

    case 'message_start':
    case 'message_delta':
    case 'message_stop':
      // These are structural events — the assembled `assistant` event handles message completion
      return []

    default:
      return []
  }
}

function normalizeAssistant(event: AssistantEvent): NormalizedEvent[] {
  return [{
    type: 'task_update',
    message: event.message,
  }]
}

function normalizeResult(event: ResultEvent): NormalizedEvent[] {
  if (event.is_error || event.subtype === 'error') {
    return [{
      type: 'error',
      message: event.result || 'Unknown error',
      isError: true,
      sessionId: event.session_id,
    }]
  }

  const denials = Array.isArray((event as any).permission_denials)
    ? (event as any).permission_denials.map((d: any) => ({
        toolName: d.tool_name || '',
        toolUseId: d.tool_use_id || '',
      }))
    : undefined

  return [{
    type: 'task_complete',
    result: event.result || '',
    costUsd: event.total_cost_usd || 0,
    durationMs: event.duration_ms || 0,
    numTurns: event.num_turns || 0,
    usage: event.usage || {},
    sessionId: event.session_id,
    ...(denials && denials.length > 0 ? { permissionDenials: denials } : {}),
  }]
}

function normalizeRateLimit(event: RateLimitEvent): NormalizedEvent[] {
  const info = event.rate_limit_info
  if (!info) return []

  return [{
    type: 'rate_limit',
    status: info.status,
    resetsAt: info.resetsAt,
    rateLimitType: info.rateLimitType,
  }]
}

function normalizePermission(event: PermissionEvent): NormalizedEvent[] {
  return [{
    type: 'permission_request',
    questionId: event.question_id,
    toolName: event.tool?.name || 'unknown',
    toolDescription: event.tool?.description,
    toolInput: event.tool?.input,
    options: (event.options || []).map((o) => ({
      id: o.id,
      label: o.label,
      kind: o.kind,
    })),
  }]
}
