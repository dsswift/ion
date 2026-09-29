/**
 * JSON-Schema helpers for browser tool declarations.
 *
 * A leaf module on purpose: `tool-declarations.ts` builds every schema from
 * these, and `tool-contracts.ts` re-exports both the helpers and the
 * declarations. If the helpers lived in `tool-contracts.ts` the two files
 * would import each other, and under ESM the declarations module would be
 * evaluated before the helpers existed — `STRING is not a function` at load,
 * seen the first time the desktop imported `tool-contracts` as its entry.
 */
type JsonSchema = Record<string, unknown>

/** Build an object schema with the given properties and required list. */
export function schema(properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema {
  return {
    type: 'object',
    properties,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: false,
  }
}

export const STRING = (description: string, maxLength = 4096): JsonSchema => ({ type: 'string', description, maxLength })
export const BOOL = (description: string): JsonSchema => ({ type: 'boolean', description })
export const INT = (description: string, minimum?: number, maximum?: number): JsonSchema => ({
  type: 'integer',
  description,
  ...(minimum === undefined ? {} : { minimum }),
  ...(maximum === undefined ? {} : { maximum }),
})
export const NUM = (description: string): JsonSchema => ({ type: 'number', description })
export const ENUM = (description: string, values: readonly string[]): JsonSchema => ({ type: 'string', description, enum: [...values] })

/**
 * The element-targeting pair every interaction tool shares.
 *
 * `element` is a human-readable description and `target` is the selector or
 * snapshot ref. Both come straight from the MCP contract: the description is
 * what makes a permission prompt or a log line readable, while the target is
 * what actually resolves.
 */
export const TARGET_PROPS: Record<string, JsonSchema> = {
  element: STRING('Human-readable description of the element, used for logs and confirmation', 512),
  target: STRING('Snapshot ref (for example e12), CSS selector, or Playwright selector such as text=Sign in', 1024),
}
