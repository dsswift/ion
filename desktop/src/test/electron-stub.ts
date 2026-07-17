/**
 * electron-stub — vitest module alias target for 'electron'.
 *
 * Unit tests run under plain Node (vitest environment: node), where the real
 * electron package is unusable: its index.js resolves the path to the
 * Electron BINARY and throws "Electron failed to install correctly" when the
 * binary is absent — which is always the case in CI and the Linux parity
 * gate (npm ci --ignore-scripts skips electron's postinstall download).
 * Any module with a top-level `import ... from 'electron'` then becomes
 * unloadable, taking every test file that transitively imports it down at
 * collection time.
 *
 * The vitest config aliases 'electron' to this stub so module loading always
 * succeeds. Tests that need specific electron behavior keep using
 * vi.mock('electron', ...) — vi.mock takes precedence over the alias — or a
 * module's dedicated injection seam (e.g. _setNativeImageForTest,
 * _setElectronForTest).
 *
 * Every export is intentionally minimal: enough shape for module-load-time
 * access patterns (property reads, method calls guarded behind runtime
 * checks) without simulating real behavior. Behavior belongs in per-test
 * mocks, not here.
 */

const noop = (): undefined => undefined

/** Minimal EventEmitter-ish surface for `app`. */
export const app = {
  isPackaged: false,
  getPath: (_name: string): string => '/tmp/electron-stub',
  getName: (): string => 'electron-stub',
  getVersion: (): string => '0.0.0',
  on: noop,
  once: noop,
  off: noop,
  whenReady: (): Promise<void> => Promise.resolve(),
  quit: noop,
  requestSingleInstanceLock: (): boolean => true,
  setAppUserModelId: noop,
  dock: { bounce: noop, setBadge: noop },
}

export const safeStorage = {
  isEncryptionAvailable: (): boolean => false,
  encryptString: (_s: string): Buffer => {
    throw new Error('electron-stub: safeStorage unavailable in unit tests (use vi.mock or the module seam)')
  },
  decryptString: (_b: Buffer): string => {
    throw new Error('electron-stub: safeStorage unavailable in unit tests (use vi.mock or the module seam)')
  },
}

export const nativeImage = {
  createFromBuffer: (_b: Buffer): never => {
    throw new Error('electron-stub: nativeImage unavailable in unit tests (use _setNativeImageForTest)')
  },
  createFromPath: (_p: string): never => {
    throw new Error('electron-stub: nativeImage unavailable in unit tests (use _setNativeImageForTest)')
  },
}

export const ipcMain = {
  handle: noop,
  on: noop,
  once: noop,
  removeHandler: noop,
  removeAllListeners: noop,
}

export const ipcRenderer = {
  invoke: (): Promise<undefined> => Promise.resolve(undefined),
  send: noop,
  on: noop,
  once: noop,
  removeAllListeners: noop,
}

export const shell = {
  openExternal: (): Promise<void> => Promise.resolve(),
  openPath: (): Promise<string> => Promise.resolve(''),
  showItemInFolder: noop,
}

export const dialog = {
  showOpenDialog: (): Promise<{ canceled: boolean; filePaths: string[] }> =>
    Promise.resolve({ canceled: true, filePaths: [] }),
  showSaveDialog: (): Promise<{ canceled: boolean; filePath?: string }> =>
    Promise.resolve({ canceled: true }),
  showMessageBox: (): Promise<{ response: number }> => Promise.resolve({ response: 0 }),
}

export const clipboard = {
  writeText: noop,
  readText: (): string => '',
}

export const screen = {
  getPrimaryDisplay: (): { workAreaSize: { width: number; height: number } } => ({
    workAreaSize: { width: 1920, height: 1080 },
  }),
  getCursorScreenPoint: (): { x: number; y: number } => ({ x: 0, y: 0 }),
  getDisplayNearestPoint: (): { workArea: { x: number; y: number; width: number; height: number } } => ({
    workArea: { x: 0, y: 0, width: 1920, height: 1080 },
  }),
}

export const systemPreferences = {
  askForMediaAccess: (): Promise<boolean> => Promise.resolve(false),
  getMediaAccessStatus: (): string => 'not-determined',
}

export const Notification = class {
  static isSupported(): boolean {
    return false
  }
  show = noop
  on = noop
}

export class BrowserWindow {
  static getAllWindows(): BrowserWindow[] {
    return []
  }
  static fromWebContents(): BrowserWindow | null {
    return null
  }
  webContents = { send: noop, on: noop, executeJavaScript: (): Promise<undefined> => Promise.resolve(undefined) }
  on = noop
  once = noop
  show = noop
  hide = noop
  focus = noop
  close = noop
  destroy = noop
  isDestroyed = (): boolean => false
  isFocused = (): boolean => false
  isVisible = (): boolean => false
  setTitle = noop
  getTitle = (): string => ''
  loadURL = (): Promise<void> => Promise.resolve()
  loadFile = (): Promise<void> => Promise.resolve()
}

export class Tray {
  on = noop
  setToolTip = noop
  setContextMenu = noop
  destroy = noop
}

export class Menu {
  static buildFromTemplate(): Menu {
    return new Menu()
  }
  static setApplicationMenu = noop
  popup = noop
}

export const powerMonitor = {
  on: noop,
}

export const nativeTheme = {
  shouldUseDarkColors: false,
  on: noop,
}

export default {
  app,
  safeStorage,
  nativeImage,
  ipcMain,
  ipcRenderer,
  shell,
  dialog,
  clipboard,
  screen,
  systemPreferences,
  Notification,
  BrowserWindow,
  Tray,
  Menu,
  powerMonitor,
  nativeTheme,
}
