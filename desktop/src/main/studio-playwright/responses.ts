/**
 * Tool response formatting.
 *
 * The output shape is part of the contract, not decoration. Agents were
 * trained against the Playwright MCP server's Markdown sections — `### Ran
 * Playwright code`, `### Page`, `### Snapshot` — and they use them to decide
 * what to do next: the page section is how they confirm a navigation landed,
 * the code line is how they check their own intent, and the snapshot is where
 * they read the refs for the next action. Returning raw JSON instead would be
 * technically complete and practically worse.
 *
 * Everything is capped, and a cap always says what was cut and how to get the
 * rest. Silent truncation is the failure mode that makes an agent conclude a
 * page has three buttons when it has thirty.
 */

export const MAX_SECTION_CHARS = 24 * 1024

export interface ResponseSections {
  /** The equivalent Playwright call, so intent is visible and reviewable. */
  code?: string
  page?: { url: string; title: string }
  result?: string
  snapshot?: string
  console?: string
  network?: string
  notice?: string
}

function truncate(body: string, hint: string): string {
  if (body.length <= MAX_SECTION_CHARS) return body
  return `${body.slice(0, MAX_SECTION_CHARS)}\n\n... output truncated at ${MAX_SECTION_CHARS} characters. ${hint}`
}

/** Compose the familiar sectioned Markdown response. */
export function formatResponse(sections: ResponseSections): string {
  const parts: string[] = []
  if (sections.code) parts.push(['### Ran Playwright code', '```js', sections.code, '```'].join('\n'))
  if (sections.notice) parts.push(['### Note', sections.notice].join('\n'))
  if (sections.page) parts.push(['### Page', `- URL: ${sections.page.url}`, `- Title: ${sections.page.title}`].join('\n'))
  if (sections.result) parts.push(['### Result', truncate(sections.result, 'Narrow the request or pass a filename.')].join('\n'))
  if (sections.console) parts.push(['### Console', truncate(sections.console, 'Raise the level or pass a filename.')].join('\n'))
  if (sections.network) parts.push(['### Network', truncate(sections.network, 'Use filter to narrow, or browser_network_request for one entry.')].join('\n'))
  if (sections.snapshot) parts.push(['### Snapshot', truncate(sections.snapshot, 'Pass a narrower target, a smaller depth, or a filename.')].join('\n'))
  return parts.join('\n\n')
}

/**
 * Format a failure.
 *
 * Playwright's error text carries its call log, which names the selector it
 * waited on and what it saw instead. That is usually the whole diagnosis, so it
 * is preserved rather than replaced with a generic message.
 */
export function formatError(operation: string, err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  return ['### Error', `${operation} failed.`, '', truncate(message, 'See the browser tools reference for argument details.')].join('\n')
}

/** A relative Markdown link, matching what agents already expect for files. */
export function fileLink(relativePath: string): string {
  return `Saved to [${relativePath}](${relativePath.split('/').map(encodeURIComponent).join('/')})`
}
