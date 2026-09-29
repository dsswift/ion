/**
 * Studio browser tool declarations.
 *
 * One browser tool is two halves joined by name. The DECLARATION — `name`,
 * `description`, `inputSchema`, and `planModeSafe` — lives here, in the server
 * package, because the Ion Studio server is what advertises the tool set to the
 * engine and it runs as a plain Node process with no Electron. The BODY — the
 * `execute` function that drives a Playwright-attached `BrowserView` — lives in
 * the desktop (`desktop/src/main/studio-playwright/tools-*.ts`), because only
 * the desktop has a browser to drive.
 *
 * The server executes a tool by sending a `browser.tool` studio_command to the
 * attached desktop; the desktop looks up the body by the declared name and
 * answers. The desktop re-joins the two halves into one array at module load
 * (`desktop/src/main/studio-playwright/tools.ts`) and refuses to start if a
 * declaration has no body or a body has no declaration, so the server can
 * never advertise a tool the desktop cannot run.
 *
 * Every schema is built from the helpers in `./tool-schema` and the tools
 * appear in the same order the desktop composes them — navigation,
 * interaction, inspection, diagnostics — so the advertised list reads the same
 * on both sides.
 *
 * `browser_run_code_unsafe` is intentionally absent. Upstream it evaluates
 * arbitrary JavaScript in the Playwright server process; in Ion that process is
 * the desktop main process, so it would be an RCE surface reachable from a
 * model. `browser_evaluate` covers the legitimate need inside the page sandbox.
 */
import type { ClientToolDef } from '@ion/shared/types-tool-gate'
import { BOOL, ENUM, INT, NUM, STRING, TARGET_PROPS, schema } from './tool-schema'

const MODIFIERS = ['Alt', 'Control', 'ControlOrMeta', 'Meta', 'Shift'] as const

/** Console severities, most severe first; mirrors `ConsoleLevel` in the desktop diagnostics. */
const LEVELS = ['error', 'warning', 'info', 'debug'] as const
/** Parts of one recorded request; mirrors `NetworkPart` in the desktop diagnostics. */
const PARTS = ['request-headers', 'request-body', 'response-headers', 'response-body'] as const

/**
 * Navigation, viewport, and tab-lifecycle tools.
 *
 * `browser_resize` is the interesting one. The MCP server implements it as
 * `page.setViewportSize()`, which on a CDP-attached page moves Playwright's
 * view without moving the Electron `<webview>` the operator sees. In Ion it is
 * a device-metrics override plus a renderer frame resize, so the page's media
 * queries, the agent's screenshots, and the visible tab all agree on one
 * viewport. Anything less would let an agent report a passing mobile layout
 * while the operator watches a desktop one.
 */
const navigationDeclarations: ClientToolDef[] = [
  {
    name: 'browser_navigate',
    description: 'Navigate the conversation browser tab to a URL. Opens the tab when none exists yet.',
    inputSchema: schema({ url: STRING('Absolute http(s) URL to open', 8192) }, ['url']),
  },
  {
    name: 'browser_navigate_back',
    description: 'Go back one entry in the conversation browser history.',
    inputSchema: schema({}),
  },
  {
    name: 'browser_navigate_forward',
    description: 'Go forward one entry in the conversation browser history.',
    inputSchema: schema({}),
  },
  {
    name: 'browser_reload',
    description: 'Reload the current page in the conversation browser tab.',
    inputSchema: schema({}),
  },
  {
    name: 'browser_close',
    description: 'Close the conversation browser tab. A later browser call opens a fresh one.',
    inputSchema: schema({}),
  },
  {
    name: 'browser_resize',
    description: 'Resize the conversation browser viewport to an exact CSS pixel size.',
    inputSchema: schema({
      width: INT('Viewport width in CSS pixels', 1, 8192),
      height: INT('Viewport height in CSS pixels', 1, 8192),
    }, ['width', 'height']),
  },
  {
    name: 'browser_emulate',
    description: 'Emulate a device or specific viewport, scale factor, touch, user agent, locale, timezone, media preferences, geolocation, or offline state. Pass reset to restore the responsive view.',
    inputSchema: schema({
      device: STRING('Playwright device name, for example "iPhone 15" or "Pixel 7"', 128),
      width: INT('Viewport width in CSS pixels', 1, 8192),
      height: INT('Viewport height in CSS pixels', 1, 8192),
      screenWidth: INT('Screen width in CSS pixels', 1, 8192),
      screenHeight: INT('Screen height in CSS pixels', 1, 8192),
      deviceScaleFactor: { type: 'number', description: 'Device pixel ratio', minimum: 0.1, maximum: 5 },
      isMobile: BOOL('Enable mobile mode, which applies the meta viewport'),
      hasTouch: BOOL('Enable touch events'),
      userAgent: STRING('User agent override', 512),
      locale: STRING('Locale such as en-GB', 35),
      timezoneId: STRING('IANA timezone such as Europe/London', 64),
      orientation: ENUM('Screen orientation', ['portrait', 'landscape']),
      colorScheme: ENUM('prefers-color-scheme', ['light', 'dark', 'no-preference']),
      reducedMotion: ENUM('prefers-reduced-motion', ['reduce', 'no-preference']),
      forcedColors: ENUM('forced-colors', ['active', 'none']),
      geolocation: schema({
        latitude: { type: 'number', minimum: -90, maximum: 90 },
        longitude: { type: 'number', minimum: -180, maximum: 180 },
        accuracy: { type: 'number', minimum: 0 },
      }, ['latitude', 'longitude']),
      offline: BOOL('Emulate an offline network'),
      javaScriptEnabled: BOOL('Set false to disable page JavaScript'),
      reset: BOOL('Clear every override and restore the responsive view'),
    }),
  },
]

/**
 * Element interaction tools.
 *
 * Every targeted tool takes the shared `TARGET_PROPS` pair; the body resolves
 * the target uniquely and refuses an ambiguous selector rather than acting on
 * it.
 */
const interactionDeclarations: ClientToolDef[] = [
  {
    name: 'browser_click',
    description: 'Click an element in the conversation browser tab.',
    inputSchema: schema({
      ...TARGET_PROPS,
      doubleClick: BOOL('Perform a double click'),
      button: ENUM('Mouse button', ['left', 'right', 'middle']),
      modifiers: { type: 'array', description: 'Modifier keys held during the click', items: { type: 'string', enum: [...MODIFIERS] }, maxItems: 4 },
    }, ['target']),
  },
  {
    name: 'browser_hover',
    description: 'Hover an element in the conversation browser tab.',
    inputSchema: schema({ ...TARGET_PROPS }, ['target']),
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
  },
  {
    name: 'browser_select_option',
    description: 'Select one or more options in a dropdown.',
    inputSchema: schema({
      ...TARGET_PROPS,
      values: { type: 'array', description: 'Option values or labels to select', items: { type: 'string' }, maxItems: 64 },
    }, ['target', 'values']),
  },
  {
    name: 'browser_check',
    description: 'Check a checkbox or radio input.',
    inputSchema: schema({ ...TARGET_PROPS }, ['target']),
  },
  {
    name: 'browser_uncheck',
    description: 'Uncheck a checkbox input.',
    inputSchema: schema({ ...TARGET_PROPS }, ['target']),
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
  },
  {
    name: 'browser_press_key',
    description: 'Press a key, for example Enter, Escape, or Control+A.',
    inputSchema: schema({ key: STRING('Key or chord to press', 128) }, ['key']),
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
  },
  {
    name: 'browser_file_upload',
    description: 'Provide files to the page file chooser. Omit paths to cancel the chooser.',
    inputSchema: schema({
      paths: { type: 'array', description: 'Conversation-relative file paths to upload', items: { type: 'string' }, maxItems: 32 },
    }),
  },
  {
    name: 'browser_handle_dialog',
    description: 'Decide how the next JavaScript dialog is answered, then trigger it. A dialog blocks the page, so this is armed before the click that opens it, never after.',
    inputSchema: schema({
      accept: BOOL('Accept the dialog'),
      promptText: STRING('Text to enter when the dialog is a prompt', 1024),
    }, ['accept']),
  },
  {
    name: 'browser_wait_for',
    description: 'Wait for a duration, for text to appear, or for text to disappear.',
    inputSchema: schema({
      time: { type: 'number', description: 'Seconds to wait', minimum: 0, maximum: 60 },
      text: STRING('Wait until this text is visible', 1024),
      textGone: STRING('Wait until this text is no longer visible', 1024),
    }),
  },
]

/**
 * Snapshot, find, screenshot, scroll, and evaluate.
 *
 * These are the tools the observed autonomous-development loop leans on hardest:
 * snapshot to learn the page, evaluate to measure it, screenshot to prove it,
 * scroll to reach the part that is off screen. They are read-heavy, so each one
 * is capped and every cap says how to get the rest. The read-only ones are
 * `planModeSafe` so a planning agent can look without acting.
 */
const inspectionDeclarations: ClientToolDef[] = [
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
  },
  {
    name: 'browser_find',
    description: 'Search the accessibility snapshot for text or a regular expression and return the matching nodes with their refs.',
    inputSchema: schema({
      text: STRING('Case-insensitive substring to find', 512),
      regex: STRING('Regular expression to find. Wrap in slashes to add flags, for example /error/i', 512),
    }),
    planModeSafe: true,
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
  },
  {
    name: 'browser_mouse_wheel',
    description: 'Scroll the page by a wheel delta.',
    inputSchema: schema({
      deltaX: NUM('Horizontal wheel delta in CSS pixels'),
      deltaY: NUM('Vertical wheel delta in CSS pixels'),
    }, ['deltaX', 'deltaY']),
  },
  {
    name: 'browser_evaluate',
    description: 'Run JavaScript in the page and return its JSON-compatible result. Use this for layout measurements such as scrollWidth or getBoundingClientRect.',
    inputSchema: schema({
      ...TARGET_PROPS,
      function: STRING('Function or expression to evaluate, for example () => document.body.scrollWidth', 8192),
      filename: STRING('Write the result to this conversation-relative file instead of returning it inline', 1024),
    }, ['function']),
  },
]

/**
 * Diagnostics and tab-status tools.
 *
 * `browser_network_request` inspects a RECORDED request and never issues a new
 * one: a fresh `fetch()` for the URL would be a different request, with
 * different headers and timing, and could re-trigger a side effect the page
 * had already caused. Reading the ledger is the only honest answer to "what
 * did that request do".
 */
const diagnosticDeclarations: ClientToolDef[] = [
  {
    name: 'browser_console_messages',
    description: 'Return console messages and uncaught page errors from the conversation browser tab.',
    inputSchema: schema({
      level: ENUM('Minimum severity to return. Each level includes the more severe ones.', LEVELS),
      all: BOOL('Return the whole session history instead of only the current navigation'),
      filename: STRING('Write the output to this conversation-relative file', 1024),
    }),
    planModeSafe: true,
  },
  {
    name: 'browser_network_requests',
    description: 'List network requests recorded for the conversation browser tab.',
    inputSchema: schema({
      static: BOOL('Include successful static resources such as images, fonts, and scripts. Defaults to false.'),
      filter: STRING('Only include requests whose URL matches this regular expression', 512),
      all: BOOL('Return the whole session history instead of only the current navigation'),
      filename: STRING('Write the output to this conversation-relative file', 1024),
    }),
    planModeSafe: true,
  },
  {
    name: 'browser_network_request',
    description: 'Show one recorded network request in full, or just one part of it. Never issues a new request.',
    inputSchema: schema({
      index: INT('1-based index from browser_network_requests', 1),
      part: ENUM('Return only this part', PARTS),
      filename: STRING('Write the output to this conversation-relative file', 1024),
    }, ['index']),
    planModeSafe: true,
  },
  {
    name: 'browser_network_state_set',
    description: 'Take the conversation browser tab offline or back online.',
    inputSchema: schema({ state: ENUM('Network state', ['online', 'offline']) }, ['state']),
  },
  {
    name: 'browser_tabs',
    description: 'Inspect or act on the one browser tab linked to this conversation.',
    inputSchema: schema({
      action: ENUM('Operation to perform', ['list', 'new', 'select', 'close', 'set_session_mode']),
      url: STRING('URL to open when action is new', 8192),
      sessionMode: ENUM('Browser session for set_session_mode', ['shared', 'isolated']),
    }, ['action']),
  },
]

/**
 * Every browser tool the server advertises, in the order the desktop composes
 * the bodies. This is the list the tool-gate responder sends to the engine.
 */
export const STUDIO_BROWSER_TOOL_DECLARATIONS: ClientToolDef[] = [
  ...navigationDeclarations,
  ...interactionDeclarations,
  ...inspectionDeclarations,
  ...diagnosticDeclarations,
]

/** Declaration lookup by name. */
export function studioBrowserToolDeclaration(name: string): ClientToolDef | undefined {
  return STUDIO_BROWSER_TOOL_DECLARATIONS.find((tool) => tool.name === name)
}
