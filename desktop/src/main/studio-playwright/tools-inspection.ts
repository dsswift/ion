/**
 * Snapshot, find, screenshot, scroll, and evaluate.
 *
 * These are the tools the observed autonomous-development loop leans on hardest:
 * snapshot to learn the page, evaluate to measure it, screenshot to prove it,
 * scroll to reach the part that is off screen. They are read-heavy, so each one
 * is capped and every cap says how to get the rest.
 */
import { log as _log } from '../logger'
import type { BrowserToolContext, BrowserToolResult, StudioBrowserTool } from './tool-contracts'
import { BOOL, ENUM, INT, NUM, STRING, TARGET_PROPS, fail, filenameArg, intArg, numArg, ok, schema, stringArg, targetOf } from './tool-contracts'
import { fileLink, formatError, formatResponse } from './responses'
import { resolveBrowser, runExclusive } from './runtime'
import { resolveUnique } from './targets'
import { pageSummary } from './tools-shared'
import { isArtifactError, resolveArtifactPath } from './artifacts'
import { writeFile } from 'node:fs/promises'

const TAG = 'studio-playwright'
const ACTION_TIMEOUT_MS = 15_000
const SNAPSHOT_TIMEOUT_MS = 20_000
/** Roughly the largest image worth sending inline to a model. */
const MAX_IMAGE_BYTES = 4 * 1024 * 1024

export const inspectionTools: StudioBrowserTool[] = [
  {
    name: 'browser_snapshot',
    description: 'Capture an accessibility snapshot of the page, including element refs such as e12 that other browser tools accept as a target.',
    inputSchema: schema({
      target: STRING('Optional selector to scope the snapshot, for example body or main', 1024),
      filename: STRING('Write the snapshot to this conversation-relative file instead of returning it inline', 1024),
      depth: INT('Limit the snapshot depth', 1, 100),
      boxes: BOOL('Append each element bounding box as [box=x,y,width,height]'),
    }),
    planModeSafe: true,
    execute: async (input, ctx) => {
      const resolved = await resolveBrowser(ctx.sessionKey, { create: true })
      if ('error' in resolved) return fail(resolved.error)
      const target = typeof input.target === 'string' && input.target.trim() ? input.target.trim() : 'body'
      const depth = intArg(input, 'depth')
      const boxes = input.boxes === true
      return runExclusive(resolved.instanceId, 'snapshot', async () => {
        try {
          const snapshot = await resolved.page.locator(target).ariaSnapshot({
            mode: 'ai',
            ...(depth === null ? {} : { depth }),
            ...(boxes ? { boxes } : {}),
            timeout: SNAPSHOT_TIMEOUT_MS,
          })
          const filename = filenameArg(input)
          if (filename) {
            const path = await resolveArtifactPath(ctx.cwd, filename, { kind: 'snapshot', extension: 'txt' })
            if (isArtifactError(path)) return fail(path.error)
            await writeFile(path.absolute, snapshot, 'utf8')
            return ok(formatResponse({ page: await pageSummary(resolved.page), result: fileLink(path.relative) }))
          }
          return ok(formatResponse({ page: await pageSummary(resolved.page), snapshot }))
        } catch (err) {
          return fail(formatError('browser_snapshot', err))
        }
      })
    },
  },
  {
    name: 'browser_find',
    description: 'Search the accessibility snapshot for text or a regular expression and return the matching nodes with their refs.',
    inputSchema: schema({
      text: STRING('Case-insensitive substring to find', 512),
      regex: STRING('Regular expression to find. Wrap in slashes to add flags, for example /error/i', 512),
    }),
    planModeSafe: true,
    execute: async (input, ctx) => {
      const text = stringArg(input, 'text', 512)
      const regexRaw = stringArg(input, 'regex', 512)
      if ((text && regexRaw) || (!text && !regexRaw)) return fail('provide exactly one of text or regex')
      let pattern: RegExp
      if (regexRaw) {
        const match = /^\/(.*)\/([gimsuy]*)$/.exec(regexRaw)
        try {
          pattern = match ? new RegExp(match[1]!, match[2]) : new RegExp(regexRaw)
        } catch (err) {
          return fail(`regex is not valid: ${String(err)}`)
        }
      } else {
        pattern = new RegExp(text!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
      }
      const resolved = await resolveBrowser(ctx.sessionKey, { create: true })
      if ('error' in resolved) return fail(resolved.error)
      return runExclusive(resolved.instanceId, 'find', async () => {
        try {
          const snapshot = await resolved.page.locator('body').ariaSnapshot({ mode: 'ai', timeout: SNAPSHOT_TIMEOUT_MS })
          const lines = snapshot.split('\n')
          const hits: string[] = []
          for (const [index, line] of lines.entries()) {
            if (!pattern.test(line)) continue
            // Neighbours are included because an accessibility line alone
            // ("button") is rarely enough to act on; its parent names it.
            const from = Math.max(0, index - 2)
            const to = Math.min(lines.length, index + 3)
            hits.push(lines.slice(from, to).join('\n'))
            if (hits.length >= 20) break
          }
          const result = hits.length === 0
            ? `No snapshot node matched ${regexRaw ?? text}.`
            : hits.join('\n---\n')
          return ok(formatResponse({ page: await pageSummary(resolved.page), result }))
        } catch (err) {
          return fail(formatError('browser_find', err))
        }
      })
    },
  },
  {
    name: 'browser_take_screenshot',
    description: 'Screenshot the viewport, the full page, one element, or an explicit clip region.',
    inputSchema: schema({
      ...TARGET_PROPS,
      type: ENUM('Image format', ['png', 'jpeg']),
      filename: STRING('Write the image to this conversation-relative file instead of returning it inline', 1024),
      fullPage: BOOL('Capture the entire scrollable page instead of the viewport'),
      scale: ENUM('css keeps CSS pixel dimensions; device uses the device pixel ratio', ['css', 'device']),
      clip: schema({
        x: NUM('Left edge in CSS pixels'),
        y: NUM('Top edge in CSS pixels'),
        width: NUM('Width in CSS pixels'),
        height: NUM('Height in CSS pixels'),
      }, ['x', 'y', 'width', 'height']),
    }),
    planModeSafe: true,
    execute: async (input, ctx) => {
      const target = targetOf(input)
      const fullPage = input.fullPage === true
      const clipRaw = input.clip
      const hasClip = clipRaw !== undefined && clipRaw !== null
      // Chromium cannot satisfy these together, and silently dropping one
      // would return an image that is not what was asked for.
      if (fullPage && (target || hasClip)) return fail('fullPage cannot be combined with an element target or a clip region')
      if (target && hasClip) return fail('provide either an element target or a clip region, not both')

      const filename = filenameArg(input)
      const explicitType = typeof input.type === 'string' ? input.type : undefined
      const inferred = filename?.toLowerCase().endsWith('.jpeg') || filename?.toLowerCase().endsWith('.jpg') ? 'jpeg' : undefined
      const type = explicitType === 'jpeg' || (!explicitType && inferred === 'jpeg') ? 'jpeg' : 'png'
      const scale = input.scale === 'device' ? 'device' : 'css'

      const resolved = await resolveBrowser(ctx.sessionKey, { create: true })
      if ('error' in resolved) return fail(resolved.error)

      return runExclusive(resolved.instanceId, 'screenshot', async () => {
        try {
          let buffer: Buffer
          let code: string
          if (target) {
            const located = await resolveUnique(resolved.page, target, ACTION_TIMEOUT_MS)
            if (typeof located === 'string') return fail(located)
            buffer = await located.locator.screenshot({ type, scale, timeout: ACTION_TIMEOUT_MS })
            code = `await ${located.expression}.screenshot({ type: '${type}' });`
          } else {
            const clip = hasClip ? parseClip(clipRaw) : null
            if (hasClip && !clip) return fail('clip requires numeric x, y, width, and height with positive dimensions')
            buffer = await resolved.page.screenshot({
              type,
              scale,
              fullPage,
              ...(clip ? { clip } : {}),
              timeout: SNAPSHOT_TIMEOUT_MS,
            })
            code = `await page.screenshot({ type: '${type}'${fullPage ? ', fullPage: true' : ''}${clip ? `, clip: ${JSON.stringify(clip)}` : ''} });`
          }

          const summary = await pageSummary(resolved.page)
          if (filename) {
            const path = await resolveArtifactPath(ctx.cwd, filename, { kind: 'screenshot', extension: type })
            if (isArtifactError(path)) return fail(path.error)
            await writeFile(path.absolute, buffer)
            _log(TAG, 'browser screenshot saved', { conversation_id: resolved.conversationId, instance_id: resolved.instanceId, bytes: buffer.byteLength })
            return ok(formatResponse({ code, page: summary, result: `${fileLink(path.relative)} (${buffer.byteLength} bytes)` }))
          }
          if (buffer.byteLength > MAX_IMAGE_BYTES) {
            return fail(`the screenshot is ${buffer.byteLength} bytes, larger than the ${MAX_IMAGE_BYTES} byte inline limit. Pass a filename to save it, or narrow the capture with an element target or clip.`)
          }
          _log(TAG, 'browser screenshot captured', { conversation_id: resolved.conversationId, instance_id: resolved.instanceId, bytes: buffer.byteLength })
          return ok(
            formatResponse({ code, page: summary, result: `Captured ${buffer.byteLength} bytes as ${type}.` }),
            [{ media_type: type === 'jpeg' ? 'image/jpeg' : 'image/png', data: buffer.toString('base64') }],
          )
        } catch (err) {
          return fail(formatError('browser_take_screenshot', err))
        }
      })
    },
  },
  {
    name: 'browser_scroll',
    description: 'Scroll by a delta, to an absolute position, or until an element is in view. Choose exactly one mode per call.',
    inputSchema: schema({
      ...TARGET_PROPS,
      deltaX: NUM('Relative horizontal scroll in CSS pixels'),
      deltaY: NUM('Relative vertical scroll in CSS pixels'),
      x: NUM('Absolute horizontal scroll position'),
      y: NUM('Absolute vertical scroll position'),
      block: ENUM('Vertical alignment when scrolling to an element', ['start', 'center', 'end', 'nearest']),
      inline: ENUM('Horizontal alignment when scrolling to an element', ['start', 'center', 'end', 'nearest']),
      behavior: ENUM('Scrolling behavior', ['instant', 'smooth']),
    }),
    execute: (input, ctx) => scroll(input, ctx),
  },
  {
    name: 'browser_mouse_wheel',
    description: 'Scroll the page by a wheel delta.',
    inputSchema: schema({
      deltaX: NUM('Horizontal wheel delta in CSS pixels'),
      deltaY: NUM('Vertical wheel delta in CSS pixels'),
    }, ['deltaX', 'deltaY']),
    execute: (input, ctx) => scroll({ deltaX: input.deltaX, deltaY: input.deltaY }, ctx),
  },
  {
    name: 'browser_evaluate',
    description: 'Run JavaScript in the page and return its JSON-compatible result. Use this for layout measurements such as scrollWidth or getBoundingClientRect.',
    inputSchema: schema({
      ...TARGET_PROPS,
      function: STRING('Function or expression to evaluate, for example () => document.body.scrollWidth', 8192),
      filename: STRING('Write the result to this conversation-relative file instead of returning it inline', 1024),
    }, ['function']),
    execute: async (input, ctx) => {
      const source = stringArg(input, 'function', 8192)
      if (!source) return fail('function is required')
      const resolved = await resolveBrowser(ctx.sessionKey, { create: true })
      if ('error' in resolved) return fail(resolved.error)
      const target = targetOf(input)
      return runExclusive(resolved.instanceId, 'evaluate', async () => {
        try {
          // Wrapped so both a function body and a bare expression work: agents
          // send both, and rejecting one form is a pointless failure.
          //
          // The wrapper takes an explicit `__arg` rather than reading
          // `arguments`: Playwright evaluates this inside an arrow function,
          // where `arguments` is not defined, so the old form threw
          // "arguments is not defined" for EVERY call that passed a function.
          const wrapped = `((__arg) => { const __fn = (${source}); return typeof __fn === 'function' ? __fn(__arg) : __fn; })`
          let value: unknown
          if (target) {
            const located = await resolveUnique(resolved.page, target, ACTION_TIMEOUT_MS)
            if (typeof located === 'string') return fail(located)
            value = await located.locator.evaluate(new Function(`return ${wrapped}`)() as (el: unknown) => unknown)
          } else {
            value = await resolved.page.evaluate(new Function(`return ${wrapped}`)() as () => unknown)
          }
          const rendered = value === undefined ? 'undefined' : JSON.stringify(value, null, 2) ?? String(value)
          const filename = filenameArg(input)
          if (filename) {
            const path = await resolveArtifactPath(ctx.cwd, filename, { kind: 'evaluate', extension: 'json' })
            if (isArtifactError(path)) return fail(path.error)
            await writeFile(path.absolute, rendered, 'utf8')
            return ok(formatResponse({ code: `await page.evaluate(${JSON.stringify(source)});`, page: await pageSummary(resolved.page), result: fileLink(path.relative) }))
          }
          return ok(formatResponse({ code: `await page.evaluate(${JSON.stringify(source)});`, page: await pageSummary(resolved.page), result: rendered }))
        } catch (err) {
          return fail(formatError('browser_evaluate', err))
        }
      })
    },
  },
]

function parseClip(raw: unknown): { x: number; y: number; width: number; height: number } | null {
  if (!raw || typeof raw !== 'object') return null
  const v = raw as Record<string, unknown>
  const nums = ['x', 'y', 'width', 'height'].map((key) => (typeof v[key] === 'number' && Number.isFinite(v[key]) ? (v[key] as number) : null))
  if (nums.some((value) => value === null)) return null
  const [x, y, width, height] = nums as number[]
  if (width! <= 0 || height! <= 0) return null
  return { x: x!, y: y!, width: width!, height: height! }
}

async function scroll(input: Record<string, unknown>, ctx: BrowserToolContext): Promise<BrowserToolResult> {
  const target = targetOf(input)
  const deltaX = numArg(input, 'deltaX')
  const deltaY = numArg(input, 'deltaY')
  const absX = numArg(input, 'x')
  const absY = numArg(input, 'y')
  const modes = [target !== null, deltaX !== null || deltaY !== null, absX !== null || absY !== null].filter(Boolean).length
  if (modes === 0) return fail('provide a target, a deltaX/deltaY, or an x/y position')
  if (modes > 1) return fail('choose exactly one scroll mode: element target, relative delta, or absolute position')

  const resolved = await resolveBrowser(ctx.sessionKey, { create: true })
  if ('error' in resolved) return fail(resolved.error)

  return runExclusive(resolved.instanceId, 'scroll', async () => {
    try {
      let code: string
      let box: { x: number; y: number; width: number; height: number } | null = null
      if (target) {
        const located = await resolveUnique(resolved.page, target, ACTION_TIMEOUT_MS)
        if (typeof located === 'string') return fail(located)
        const block = typeof input.block === 'string' ? input.block : 'center'
        const inline = typeof input.inline === 'string' ? input.inline : 'nearest'
        const behavior = input.behavior === 'smooth' ? 'smooth' : 'instant'
        await located.locator.scrollIntoViewIfNeeded({ timeout: ACTION_TIMEOUT_MS })
        // scrollIntoViewIfNeeded lands the element in view but does not honor
        // an alignment request, so the explicit alignment is applied after.
        await located.locator.evaluate((el, options) => {
          (el as Element).scrollIntoView(options as ScrollIntoViewOptions)
        }, { block, inline, behavior })
        box = await located.locator.boundingBox({ timeout: ACTION_TIMEOUT_MS })
        code = `await ${located.expression}.scrollIntoViewIfNeeded();`
      } else if (deltaX !== null || deltaY !== null) {
        await resolved.page.mouse.wheel(deltaX ?? 0, deltaY ?? 0)
        code = `await page.mouse.wheel(${deltaX ?? 0}, ${deltaY ?? 0});`
      } else {
        await resolved.page.evaluate(({ x, y }) => window.scrollTo({ left: x ?? window.scrollX, top: y ?? window.scrollY, behavior: 'instant' }), { x: absX, y: absY })
        code = `await page.evaluate(() => window.scrollTo(${absX ?? 0}, ${absY ?? 0}));`
      }

      const position = await resolved.page.evaluate(() => ({
        scrollX: Math.round(window.scrollX),
        scrollY: Math.round(window.scrollY),
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
      }))
      const lines = [`Scroll position: ${position.scrollX}, ${position.scrollY}`, `Viewport: ${position.innerWidth}x${position.innerHeight}`]
      if (box) lines.push(`Target box: x=${Math.round(box.x)} y=${Math.round(box.y)} width=${Math.round(box.width)} height=${Math.round(box.height)}`)
      return ok(formatResponse({ code, page: await pageSummary(resolved.page), result: lines.join('\n') }))
    } catch (err) {
      return fail(formatError('browser_scroll', err))
    }
  })
}
