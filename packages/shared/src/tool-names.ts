/**
 * The name a tool has for a person, as opposed to the name it travelled under.
 *
 * A delegated-CLI run reaches the engine's own tools (Bash, the question and
 * plan-mode tools, an extension's registered tools) over an MCP server, and MCP
 * names every tool `mcp__<server>__<tool>`. So the engine's Bash arrives as
 * `mcp__ion-extensions__Bash` on a delegated-CLI run and as `Bash` on an API
 * run: the same tool. The model keeps seeing the prefixed name, because that is
 * the name it calls. A person reading a transcript learns nothing from the
 * prefix, and every display rule keyed on a tool's own name (the command shown
 * for Bash, the path shown for Edit) misses a name that still carries it.
 *
 * Only the engine's own bridge is stripped. A tool served by any other MCP
 * server keeps its full `mcp__<server>__<tool>` name: there the server is the
 * part that tells the reader whose tool it is, and a third party's `Bash` is not
 * the engine's `Bash`.
 *
 * The prefix is pinned to the engine's `backend.McpServerName` by the shared
 * fixture `assets/mcp-bridge-parity.json`, which the engine test writes and
 * `__tests__/tool-names.test.ts` reads, so a rename cannot leave this matching a
 * name the engine no longer sends.
 */
export const ENGINE_BRIDGE_TOOL_PREFIX = "mcp__ion-extensions__";

/**
 * Return `name` without the engine's MCP bridge prefix. Any other name — bare,
 * or prefixed by a different MCP server — is returned unchanged.
 */
export function stripEngineBridgePrefix(name: string): string {
  return name.startsWith(ENGINE_BRIDGE_TOOL_PREFIX)
    ? name.slice(ENGINE_BRIDGE_TOOL_PREFIX.length)
    : name;
}
