/**
 * A rejected `studio_action`: preserves the refusal/error `code` alongside
 * the message. Both `studio_action` callers (the desktop main process's
 * `Broker.sendAction` and the renderer's `host.action`) reject with this
 * rather than a plain `Error`, so anything downstream that needs to render
 * the exact code text (spec 15's transfer flow: "each refusal rendered with
 * its code text") doesn't have to pattern-match the message string.
 */
export class StudioActionFailure extends Error {
  readonly code?: string
  constructor(message: string, code?: string) {
    super(message)
    this.name = 'StudioActionFailure'
    this.code = code
  }
}
