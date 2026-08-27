/**
 * Element interaction tools.
 *
 * Every handler resolves its target through `resolveUnique`, so an ambiguous
 * selector is refused rather than acted on. Playwright's own actionability
 * waiting (visible, stable, enabled, scrolled into view) is left in place: it is
 * more reliable than any pre-check here, and it produces the call log that makes
 * a failure diagnosable.
 */
import type { Page } from 'playwright-core'
import { log as _log, warn as _warn } from '../logger'
import type { BrowserToolContext, BrowserToolResult, StudioBrowserTool } from './tool-contracts'
import { BOOL, ENUM, STRING, TARGET_PROPS, fail, ok, schema, stringArg, targetOf } from './tool-contracts'
import { formatError, formatResponse } from './responses'
import { resolveBrowser, runExclusive } from './runtime'
import { resolveUnique } from './targets'
import { briefSnapshot, pageSummary } from './tools-shared'
import { isArtifactError, resolveInputPaths } from './artifacts'

const TAG = 'studio-playwright'
const ACTION_TIMEOUT_MS = 15_000

const MODIFIERS = ['Alt', 'Control', 'ControlOrMeta', 'Meta', 'Shift'] as const

/** Run one targeted action with resolution, serialization, and reporting. */
async function withTarget(
  ctx: BrowserToolContext,
  input: Record<string, unknown>,
  label: string,
  act: (locator: Awaited<ReturnType<typeof resolveUnique>> extends string ? never : { locator: import('playwright-core').Locator; expression: string }, page: Page) => Promise<string>,
): Promise<BrowserToolResult> {
  const target = targetOf(input)
  if (!target) return fail('target is required: pass a snapshot ref such as e12, or a selector')
  const resolved = await resolveBrowser(ctx.sessionKey, { create: true })
  if ('error' in resolved) return fail(resolved.error)
  return runExclusive(resolved.instanceId, label, async () => {
    try {
      const located = await resolveUnique(resolved.page, target, ACTION_TIMEOUT_MS)
      if (typeof located === 'string') return fail(located)
      const code = await act(located, resolved.page)
      _log(TAG, 'browser interaction completed', {
        conversation_id: resolved.conversationId,
        instance_id: resolved.instanceId,
        operation: label,
        element: typeof input.element === 'string' ? input.element.slice(0, 80) : '',
      })
      return ok(formatResponse({
        code,
        page: await pageSummary(resolved.page),
        snapshot: await briefSnapshot(resolved.page),
      }))
    } catch (err) {
      return fail(formatError(label, err))
    }
  })
}

export const interactionTools: StudioBrowserTool[] = [
  {
    name: 'browser_click',
    description: 'Click an element in the conversation browser tab.',
    inputSchema: schema({
      ...TARGET_PROPS,
      doubleClick: BOOL('Perform a double click'),
      button: ENUM('Mouse button', ['left', 'right', 'middle']),
      modifiers: { type: 'array', description: 'Modifier keys held during the click', items: { type: 'string', enum: [...MODIFIERS] }, maxItems: 4 },
    }, ['target']),
    execute: (input, ctx) => withTarget(ctx, input, 'browser_click', async (located) => {
      const button = input.button === 'right' || input.button === 'middle' ? input.button : 'left'
      const modifiers = Array.isArray(input.modifiers)
        ? input.modifiers.filter((mod): mod is typeof MODIFIERS[number] => typeof mod === 'string' && (MODIFIERS as readonly string[]).includes(mod))
        : []
      const options = { button, timeout: ACTION_TIMEOUT_MS, ...(modifiers.length > 0 ? { modifiers } : {}) } as const
      if (input.doubleClick === true) await located.locator.dblclick(options)
      else await located.locator.click(options)
      return `await ${located.expression}.${input.doubleClick === true ? 'dblclick' : 'click'}();`
    }),
  },
  {
    name: 'browser_hover',
    description: 'Hover an element in the conversation browser tab.',
    inputSchema: schema({ ...TARGET_PROPS }, ['target']),
    execute: (input, ctx) => withTarget(ctx, input, 'browser_hover', async (located) => {
      await located.locator.hover({ timeout: ACTION_TIMEOUT_MS })
      return `await ${located.expression}.hover();`
    }),
  },
  {
    name: 'browser_type',
    description: 'Type text into an editable element.',
    inputSchema: schema({
      ...TARGET_PROPS,
      text: STRING('Text to type', 8192),
      submit: BOOL('Press Enter after typing'),
      slowly: BOOL('Type one character at a time to trigger key handlers'),
    }, ['target', 'text']),
    execute: (input, ctx) => {
      const text = typeof input.text === 'string' ? input.text : null
      if (text === null) return Promise.resolve(fail('text is required'))
      return withTarget(ctx, input, 'browser_type', async (located) => {
        if (input.slowly === true) {
          // pressSequentially fires per-key handlers; fill() does not. Some
          // inputs (autocompletes, masked fields) only work the slow way.
          await located.locator.pressSequentially(text, { timeout: ACTION_TIMEOUT_MS })
        } else {
          await located.locator.fill(text, { timeout: ACTION_TIMEOUT_MS })
        }
        if (input.submit === true) await located.locator.press('Enter', { timeout: ACTION_TIMEOUT_MS })
        return `await ${located.expression}.${input.slowly === true ? 'pressSequentially' : 'fill'}(${JSON.stringify(text)});`
      })
    },
  },
  {
    name: 'browser_select_option',
    description: 'Select one or more options in a dropdown.',
    inputSchema: schema({
      ...TARGET_PROPS,
      values: { type: 'array', description: 'Option values or labels to select', items: { type: 'string' }, maxItems: 64 },
    }, ['target', 'values']),
    execute: (input, ctx) => {
      const raw = Array.isArray(input.values) ? input.values : (input.value !== undefined ? [input.value] : null)
      const values = raw?.filter((value): value is string => typeof value === 'string') ?? null
      if (!values || values.length === 0) return Promise.resolve(fail('values must be a non-empty array of strings'))
      return withTarget(ctx, input, 'browser_select_option', async (located) => {
        await located.locator.selectOption(values, { timeout: ACTION_TIMEOUT_MS })
        return `await ${located.expression}.selectOption(${JSON.stringify(values)});`
      })
    },
  },
  {
    name: 'browser_check',
    description: 'Check a checkbox or radio input.',
    inputSchema: schema({ ...TARGET_PROPS }, ['target']),
    execute: (input, ctx) => withTarget(ctx, input, 'browser_check', async (located) => {
      await located.locator.check({ timeout: ACTION_TIMEOUT_MS })
      return `await ${located.expression}.check();`
    }),
  },
  {
    name: 'browser_uncheck',
    description: 'Uncheck a checkbox input.',
    inputSchema: schema({ ...TARGET_PROPS }, ['target']),
    execute: (input, ctx) => withTarget(ctx, input, 'browser_uncheck', async (located) => {
      await located.locator.uncheck({ timeout: ACTION_TIMEOUT_MS })
      return `await ${located.expression}.uncheck();`
    }),
  },
  {
    name: 'browser_drag',
    description: 'Drag one element onto another.',
    inputSchema: schema({
      startElement: STRING('Human-readable description of the drag source', 512),
      startTarget: STRING('Snapshot ref or selector for the drag source', 1024),
      endElement: STRING('Human-readable description of the drop target', 512),
      endTarget: STRING('Snapshot ref or selector for the drop target', 1024),
    }, ['startTarget', 'endTarget']),
    execute: async (input, ctx) => {
      const start = stringArg(input, 'startTarget', 1024)
      const end = stringArg(input, 'endTarget', 1024)
      if (!start || !end) return fail('startTarget and endTarget are both required')
      const resolved = await resolveBrowser(ctx.sessionKey, { create: true })
      if ('error' in resolved) return fail(resolved.error)
      return runExclusive(resolved.instanceId, 'browser_drag', async () => {
        try {
          const from = await resolveUnique(resolved.page, start, ACTION_TIMEOUT_MS)
          if (typeof from === 'string') return fail(from)
          const to = await resolveUnique(resolved.page, end, ACTION_TIMEOUT_MS)
          if (typeof to === 'string') return fail(to)
          await from.locator.dragTo(to.locator, { timeout: ACTION_TIMEOUT_MS })
          return ok(formatResponse({
            code: `await ${from.expression}.dragTo(${to.expression});`,
            page: await pageSummary(resolved.page),
            snapshot: await briefSnapshot(resolved.page),
          }))
        } catch (err) {
          return fail(formatError('browser_drag', err))
        }
      })
    },
  },
  {
    name: 'browser_press_key',
    description: 'Press a key, for example Enter, Escape, or Control+A.',
    inputSchema: schema({ key: STRING('Key or chord to press', 128) }, ['key']),
    execute: async (input, ctx) => {
      const key = stringArg(input, 'key', 128)
      if (!key) return fail('key is required')
      const resolved = await resolveBrowser(ctx.sessionKey, { create: true })
      if ('error' in resolved) return fail(resolved.error)
      return runExclusive(resolved.instanceId, 'browser_press_key', async () => {
        try {
          await resolved.page.keyboard.press(key)
          return ok(formatResponse({
            code: `await page.keyboard.press(${JSON.stringify(key)});`,
            page: await pageSummary(resolved.page),
            snapshot: await briefSnapshot(resolved.page),
          }))
        } catch (err) {
          return fail(formatError('browser_press_key', err))
        }
      })
    },
  },
  {
    name: 'browser_fill_form',
    description: 'Fill several form fields in one call.',
    inputSchema: schema({
      fields: {
        type: 'array',
        description: 'Fields to fill',
        maxItems: 64,
        items: schema({
          name: STRING('Human-readable field name', 256),
          type: ENUM('Field kind', ['textbox', 'checkbox', 'radio', 'combobox', 'slider']),
          target: STRING('Snapshot ref or selector for the field', 1024),
          value: STRING('Value to set. Use "true"/"false" for a checkbox', 4096),
        }, ['name', 'type', 'target', 'value']),
      },
    }, ['fields']),
    execute: async (input, ctx) => {
      const raw = Array.isArray(input.fields) ? input.fields : null
      if (!raw || raw.length === 0) return fail('fields must be a non-empty array')
      const resolved = await resolveBrowser(ctx.sessionKey, { create: true })
      if ('error' in resolved) return fail(resolved.error)
      return runExclusive(resolved.instanceId, 'browser_fill_form', async () => {
        const applied: string[] = []
        try {
          for (const entry of raw) {
            if (!entry || typeof entry !== 'object') return fail('each field must be an object')
            const field = entry as Record<string, unknown>
            const target = typeof field.target === 'string' ? field.target : null
            const value = typeof field.value === 'string' ? field.value : null
            const kind = typeof field.type === 'string' ? field.type : 'textbox'
            if (!target || value === null) return fail('each field needs a target and a string value')
            const located = await resolveUnique(resolved.page, target, ACTION_TIMEOUT_MS)
            if (typeof located === 'string') return fail(located)
            if (kind === 'checkbox' || kind === 'radio') {
              const shouldCheck = value !== 'false' && value !== '0'
              if (shouldCheck) await located.locator.check({ timeout: ACTION_TIMEOUT_MS })
              else await located.locator.uncheck({ timeout: ACTION_TIMEOUT_MS })
            } else if (kind === 'combobox') {
              await located.locator.selectOption(value, { timeout: ACTION_TIMEOUT_MS })
            } else {
              await located.locator.fill(value, { timeout: ACTION_TIMEOUT_MS })
            }
            applied.push(`${String(field.name ?? target)} = ${kind === 'textbox' ? '(set)' : value}`)
          }
          return ok(formatResponse({
            code: `// filled ${applied.length} field(s)`,
            result: applied.join('\n'),
            page: await pageSummary(resolved.page),
            snapshot: await briefSnapshot(resolved.page),
          }))
        } catch (err) {
          // Partial progress is reported: knowing which field broke the run is
          // the difference between a fix and a retry from scratch.
          const done = applied.length > 0 ? `\n\nFields applied before the failure:\n${applied.join('\n')}` : ''
          return fail(`${formatError('browser_fill_form', err)}${done}`)
        }
      })
    },
  },
  {
    name: 'browser_file_upload',
    description: 'Provide files to the page file chooser. Omit paths to cancel the chooser.',
    inputSchema: schema({
      paths: { type: 'array', description: 'Conversation-relative file paths to upload', items: { type: 'string' }, maxItems: 32 },
    }),
    execute: async (input, ctx) => {
      const resolved = await resolveBrowser(ctx.sessionKey, { create: false })
      if ('error' in resolved) return fail(resolved.error)
      const raw = input.paths
      if (raw !== undefined && !Array.isArray(raw)) return fail('paths must be an array of conversation-relative file paths')
      return runExclusive(resolved.instanceId, 'browser_file_upload', async () => {
        const pending = pendingChooser(resolved.page)
        if (!pending) return fail('no file chooser is open. Click the upload control first, then call browser_file_upload.')
        if (raw === undefined) {
          clearChooser(resolved.page)
          return ok(formatResponse({ code: '// file chooser cancelled', result: 'Cancelled the pending file chooser.' }))
        }
        const resolvedPaths = await resolveInputPaths(ctx.cwd, raw)
        if (isArtifactError(resolvedPaths)) return fail(resolvedPaths.error)
        try {
          await pending.setFiles(resolvedPaths.resolved)
          clearChooser(resolved.page)
          return ok(formatResponse({
            code: `await fileChooser.setFiles(${JSON.stringify(resolvedPaths.resolved.length === 1 ? resolvedPaths.resolved[0] : resolvedPaths.resolved)});`,
            result: `Provided ${resolvedPaths.resolved.length} file(s) to the page.`,
            page: await pageSummary(resolved.page),
          }))
        } catch (err) {
          return fail(formatError('browser_file_upload', err))
        }
      })
    },
  },
  {
    name: 'browser_handle_dialog',
    description: 'Decide how the next JavaScript dialog is answered, then trigger it. A dialog blocks the page, so this is armed before the click that opens it, never after.',
    inputSchema: schema({
      accept: BOOL('Accept the dialog'),
      promptText: STRING('Text to enter when the dialog is a prompt', 1024),
    }, ['accept']),
    execute: async (input, ctx) => {
      if (typeof input.accept !== 'boolean') return fail('accept is required')
      const resolved = await resolveBrowser(ctx.sessionKey, { create: false })
      if ('error' in resolved) return fail(resolved.error)
      // A dialog already on screen has blocked the page and been dismissed by
      // Playwright, so there is nothing to reach for. This arms the answer for
      // the next one instead: call it first, then click.
      const promptText = typeof input.promptText === 'string' ? input.promptText : undefined
      armDialog(resolved.page, { accept: input.accept, promptText })
      return ok(formatResponse({
        code: `page.once('dialog', d => d.${input.accept ? 'accept' : 'dismiss'}());`,
        result: `The next dialog will be ${input.accept ? 'accepted' : 'dismissed'}. Trigger it now.`,
      }))
    },
  },
  {
    name: 'browser_wait_for',
    description: 'Wait for a duration, for text to appear, or for text to disappear.',
    inputSchema: schema({
      time: { type: 'number', description: 'Seconds to wait', minimum: 0, maximum: 60 },
      text: STRING('Wait until this text is visible', 1024),
      textGone: STRING('Wait until this text is no longer visible', 1024),
    }),
    execute: async (input, ctx) => {
      const time = typeof input.time === 'number' && Number.isFinite(input.time) ? Math.min(Math.max(input.time, 0), 60) : null
      const text = stringArg(input, 'text', 1024)
      const textGone = stringArg(input, 'textGone', 1024)
      if (time === null && !text && !textGone) return fail('provide at least one of time, text, or textGone')
      const resolved = await resolveBrowser(ctx.sessionKey, { create: false })
      if ('error' in resolved) return fail(resolved.error)
      return runExclusive(resolved.instanceId, 'browser_wait_for', async () => {
        try {
          const steps: string[] = []
          if (text) {
            await resolved.page.getByText(text).first().waitFor({ state: 'visible', timeout: 30_000 })
            steps.push(`await page.getByText(${JSON.stringify(text)}).waitFor({ state: 'visible' });`)
          }
          if (textGone) {
            await resolved.page.getByText(textGone).first().waitFor({ state: 'hidden', timeout: 30_000 })
            steps.push(`await page.getByText(${JSON.stringify(textGone)}).waitFor({ state: 'hidden' });`)
          }
          if (time !== null) {
            await resolved.page.waitForTimeout(time * 1000)
            steps.push(`await page.waitForTimeout(${time * 1000});`)
          }
          return ok(formatResponse({ code: steps.join('\n'), page: await pageSummary(resolved.page) }))
        } catch (err) {
          return fail(formatError('browser_wait_for', err))
        }
      })
    },
  },
]

/**
 * Pending chooser and dialog tracking.
 *
 * Both are event-driven and single-shot in Playwright: a dialog blocks the page
 * until answered, and a chooser is only valid for the interaction that opened
 * it. They are captured on the page when they appear so a subsequent tool call
 * can answer them — the alternative would be requiring the agent to predict a
 * dialog before clicking, which it cannot do.
 */
const chooserByPage = new WeakMap<Page, import('playwright-core').FileChooser>()
const wired = new WeakSet<Page>()

/**
 * The decision to apply to the NEXT dialog this page opens.
 *
 * A JavaScript dialog blocks the page until it is answered, so it cannot be
 * handled by a later tool call: the click that triggers it does not return
 * while the dialog is up, and Playwright auto-dismisses any dialog that has no
 * handler. Verified against the live app — the listener captured a `confirm`,
 * the page had already recorded `false`, and `dialog.accept()` then failed with
 * "No dialog is showing".
 *
 * So the answer is armed in advance and applied the instant the dialog opens.
 * `browser_handle_dialog` arms it; the click that provokes the dialog comes
 * after.
 */
interface ArmedDialog {
  accept: boolean
  promptText?: string
}
const armedByPage = new WeakMap<Page, ArmedDialog>()

/** Arm the answer for the next dialog. Returns nothing; the dialog may not exist yet. */
export function armDialog(page: Page, decision: ArmedDialog): void {
  watchPageDialogs(page)
  armedByPage.set(page, decision)
}

export function watchPageDialogs(page: Page): void {
  if (wired.has(page)) return
  wired.add(page)
  page.on('filechooser', (chooser) => chooserByPage.set(page, chooser))
  page.on('dialog', (dialog) => {
    const armed = armedByPage.get(page)
    if (!armed) {
      // No decision armed: let Playwright's default dismissal stand rather
      // than leaving the page blocked forever on an unanswered dialog.
      _log(TAG, 'dialog auto-dismissed, none armed', { type: dialog.type(), message: dialog.message().slice(0, 120) })
      return
    }
    armedByPage.delete(page)
    const settle = armed.accept ? dialog.accept(armed.promptText) : dialog.dismiss()
    void settle
      .then(() => _log(TAG, 'armed dialog answered', { type: dialog.type(), accepted: armed.accept }))
      .catch((err: unknown) => _warn(TAG, 'armed dialog answer failed', { type: dialog.type(), error: String(err) }))
  })
}

function pendingChooser(page: Page): import('playwright-core').FileChooser | null {
  watchPageDialogs(page)
  return chooserByPage.get(page) ?? null
}
function clearChooser(page: Page): void { chooserByPage.delete(page) }
