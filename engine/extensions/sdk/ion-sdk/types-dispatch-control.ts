/** Options for the retained name-addressed dispatch recall API. */
export interface RecallAgentOpts {
  /** Human-readable reason recorded by the engine. */
  reason?: string
}

/** Options for collision-safe exact-ID dispatch recall. */
export interface RecallDispatchOpts {
  /** Human-readable reason recorded by the engine. */
  reason?: string
}

/** Dispatch recall controls mixed into the public IonContext interface. */
export interface DispatchControlContext {
  /**
   * Retained compatibility API. Recalls one live dispatch resolved by name.
   * When names collide, use recallDispatch with the exact dispatch ID instead.
   */
  recallAgent(name: string, opts?: RecallAgentOpts): Promise<boolean>

  /**
   * Preferred API. Recalls the exact background dispatch and its descendants.
   */
  recallDispatch(dispatchId: string, opts?: RecallDispatchOpts): Promise<boolean>
}
