/**
 * Requests a client sends to administer one MCP server (Studio actions
 * `mcp.add` and `mcp.update`). The server forwards them to the engine's
 * mcp_add and mcp_update commands.
 */

/**
 * The operator-configured OAuth client. Every field is optional; whatever is
 * left out, the engine fills from the server's discovery metadata at sign-in.
 * On an update, `clientSecret` undefined keeps the stored secret and '' removes
 * it: the engine never sends a stored secret back, so "keep" is the absence of
 * a value.
 */
export interface McpOAuthSettings {
  clientId?: string
  clientSecret?: string
  authUrl?: string
  tokenUrl?: string
  scope?: string
  resource?: string
}

export interface McpAddRequest {
  name: string
  /** Omitted lets the engine infer it: a url means http, a command means stdio. */
  transport?: string
  url?: string
  command?: string
  args?: string[]
  headers?: Record<string, string>
  env?: Record<string, string>
  oauth?: McpOAuthSettings
}

/**
 * A change to one existing server. Absent fields are kept. `oauth` replaces the
 * whole configured client: an empty field in it removes that setting.
 */
export interface McpUpdateRequest {
  name: string
  url?: string
  command?: string
  args?: string[]
  oauth?: McpOAuthSettings
}

/** What `mcp.update` reports back. */
export interface McpUpdateOutcome {
  /** False when the request matched what was already stored. */
  changed: boolean
  /** The url or OAuth client changed and the stored sign-in was dropped. */
  credentialsCleared: boolean
}
