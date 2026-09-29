// EngineEventInjection — the engine_* variants that report a message being
// INJECTED into a live run, and the engine's scheduling decisions around that
// injection.
//
// Extracted from types-engine-event.ts to keep that file under the 600-line
// cap; EngineEvent includes this union unchanged via `| EngineEventInjection`.
// Grouped by what they describe rather than by size: a steer drained into the
// conversation, a steer that arrived with no live run to drain it, a provider
// call the engine ended early so a steer could apply sooner, an agent-state
// payload the engine bounded, and a prompt an extension injected. Every one is
// "something entered this run that the model did not ask for", which is why
// they read as one family.

export type EngineEventInjection =
  // Mid-turn steer-drain confirmation. Engine emits this after the
  // runloop drainSteer helper captures a steer message (queued via the
  // steer channel) and injects it into the conversation as a user turn
  // before the next LLM call. `steerMessageLength` is the character
  // count; the body is not echoed back over the wire because it is
  // already part of the conversation. `steerClientMessageId` echoes the
  // client's steer_agent correlation id when supplied and this was a
  // genuine client-originated steer (never present for a machine-to-machine
  // injection). `steerEntryId` is the durable conversation-tree entry id
  // the steer text was persisted under, present only for a genuine
  // client-originated steer -- the exact target for a later
  // engine_rewind command. See
  // engine/internal/types/normalized_event.go (SteerInjectedEvent).
  | {
      type: "engine_steer_injected";
      steerMessageLength: number;
      steerClientMessageId?: string;
      steerEntryId?: string;
      steerKind?: string;
      steerMachineAuthored?: boolean;
    }
  // No owning run was live, so ctx.steerSelf delivered a fresh prompt instead.
  | {
      type: "engine_steer_degraded";
      steerDegradedMessageLength: number;
      steerKind?: string;
      steerMachineAuthored?: boolean;
    }
  // A steer arrived mid-stream and the engine ended that provider call early so
  // the steer applies on the next turn. Reports the scheduling decision, not the
  // injection: `engine_steer_injected` still follows. Nothing the model produced
  // is discarded -- steerInterruptBlocksKept counts the assistant blocks
  // preserved -- so a consumer should render the shortened message as an
  // intentional early stop rather than a truncation or an error.
  | {
      type: "engine_steer_interrupted_stream";
      steerInterruptBlocksKept?: number;
      steerQueuedCount?: number;
    }
  | {
      type: "engine_agent_state_clamped";
      clampedAgentName?: string;
      clampedScope?: string;
      clampedKeys?: string[];
      clampedDroppedKeys?: string[];
      clampedOriginalBytes?: number;
      clampedBytes?: number;
      clampedLimitBytes?: number;
    }
  | {
      type: "engine_prompt_injected";
      injectedPrompt: string;
      injectedPromptOrigin?: string;
      injectedPromptKind?: string;
      injectedPromptMachineAuthored?: boolean;
    }
