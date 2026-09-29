// EngineEvent extension lifecycle and event-drop variants.
//
// Extracted from types-engine-event.ts to keep the main wire-event union under
// the 600-line cap. EngineEvent includes this union unchanged, so consumers
// retain the same discriminated event surface.

export type EngineEventLifecycle =
  | {
      type: "engine_extension_died";
      extensionName: string;
      exitCode: number | null;
      signal: string | null;
      stderrTail?: string[];
    }
  | {
      type: "engine_extension_respawned";
      extensionName: string;
      attemptNumber: number;
    }
  | { type: "engine_events_dropped"; count: number }
  | {
      type: "engine_extension_dead_permanent";
      extensionName: string;
      attemptNumber: number;
      stderrTail?: string[];
    };
