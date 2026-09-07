import type { EngineConfig, ThinkingConfig } from '../shared/types-engine'
import { resolveSessionThinkingConfig } from './settings-store'
import { resolveClaudeCompat, resolveRunRecoveryConfig } from './engine-control-plane-config'
import { toolGateSessionConfig } from './tool-gate-responder'
import { benchClientWorkspaceContext } from './integration/bench-prompt-context'

/**
 * Assembly of the EngineConfig a tab starts its engine session with.
 *
 * Split out of engine-control-plane.ts, which crossed the 600-line cap. The
 * seam is real rather than arbitrary: this is declarative policy resolution
 * (which thinking default, which recovery policy, which workspace context,
 * which surface identity), whereas its caller owns session lifecycle
 * orchestration. The two change for different reasons.
 */
export interface SessionConfigInputs {
  workingDirectory: string
  sessionId?: string
  extensions?: string[]
  model?: string
  maxTokens?: number
  thinking?: ThinkingConfig
}

export function buildSessionConfig(tabId: string, opts: SessionConfigInputs): EngineConfig {
  return {
    profileId: 'default',
    extensions: opts.extensions || [],
    workingDirectory: opts.workingDirectory,
    sessionId: opts.sessionId,
    model: opts.model,
    maxTokens: opts.maxTokens,
    // Session thinking default. Resolved HERE rather than threaded from the
    // caller so every start site gets it — the relocate, cwd-reconcile, and
    // eager-restore paths all call ensureSession without a thinking opinion,
    // and a caller-threaded value would silently omit it on those three. An
    // explicit opts.thinking still wins for a caller that has one.
    thinking: opts.thinking ?? resolveSessionThinkingConfig(),
    claudeCompat: resolveClaudeCompat(),
    // Desktop preference owns plain desktop conversations. Extension-backed
    // sessions keep the engine default until their harness selects policy.
    ...(opts.extensions?.length ? {} : { runRecovery: resolveRunRecoveryConfig() }),
    // Client tool gate: bench containment policy + bench client tools. Declared
    // on every session because bench involvement can begin mid-session; policy
    // resolves the workspace fresh per call. The working directory selects the
    // ConversationTelemetry variant, which is a per-session declaration.
    toolGate: toolGateSessionConfig(opts.workingDirectory),
    clientWorkspaceContext: benchClientWorkspaceContext(opts.workingDirectory) ?? undefined,
    // Application-surface identity stamped on this session's conversation.*
    // telemetry events (engine: EngineConfig.AppContext → the event's
    // "app_context" context key). An enterprise consumer running several tabs
    // with parallel conversations needs each one distinguishable in the audit
    // stream; tabId is the identity the rest of the desktop already addresses
    // a surface by.
    //
    // Deliberately not the tab's display title: the title is mutable display
    // text (auto-titling rewrites it mid-conversation) and lives in the
    // renderer, not here. Identity belongs in the stream; a consumer that
    // wants the human-facing name joins to it by conversation_id rather than
    // reading a value that was true only at session start.
    appContext: { client: 'desktop', tab_id: tabId },
  }
}
