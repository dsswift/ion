/**
 * Device settings the shared store code needs while it runs ON A CLIENT.
 *
 * Some store actions are per-window UI and execute in the Studio renderer
 * (opening a file in the editor, toggling word wrap), and the notification
 * sound plays there too. They need a few Device settings: whether markdown
 * opens in preview, the editor's default word wrap, whether sound is on.
 *
 * A Device setting lives on the client and the server holds no copy, so this
 * module does not read one from anywhere. The client registers a reader over
 * its own preference store at boot. Code running on the server never
 * registers one and sees the shipped defaults, which is correct: the server
 * has no editor and no speaker.
 *
 * These reads used to go through the server's preferences facade, which in
 * the renderer bundle is a stub that returns defaults. The client's actual
 * choice was never consulted.
 */
export interface ClientPreferences {
  soundEnabled: boolean
  editorWordWrap: boolean
  openMarkdownInPreview: boolean
}

const SHIPPED: ClientPreferences = { soundEnabled: true, editorWordWrap: true, openMarkdownInPreview: true }

let read: () => ClientPreferences = () => SHIPPED

/** Called once by a client at boot, with a reader over its own store. */
export function registerClientPreferences(reader: () => ClientPreferences): void {
  read = reader
}

export function clientPreferences(): ClientPreferences {
  return read()
}
