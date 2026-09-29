/**
 * server-secret-store-browser-stub — the Studio renderer's build-time
 * replacement for `server/src/utils/secretStore.ts`.
 *
 * The real file encrypts/decrypts on-disk secret values via Electron
 * `safeStorage` or a keyfile-backed AES-GCM fallback (`fs.readFileSync`/
 * `writeFileSync`, `os.hostname`/`userInfo`, `crypto`). It is reachable from
 * the renderer transitively through `persistence/settings-store.ts`'s
 * `readSettings`/`writeSettings` (`sessionStore.ts` → ... → settings-store),
 * which call `decryptSensitiveSettings`/`encryptSensitiveSettings` on every
 * settings load/save. Settings persistence — encrypted or not — is
 * server-owned per spec 17 ("server owns the store, Studio renders"); the
 * renderer never reads or writes `settings.json` directly.
 *
 * Decrypt is an identity passthrough (safe no-op: nothing in the renderer
 * should ever hold ciphertext to decrypt). Encrypt throws, so an accidental
 * renderer-side write attempt fails loudly instead of silently producing an
 * unencrypted "encrypted" value. Wired in via `electron.vite.config.ts`'s
 * renderer plugin, keyed on secretStore.ts's resolved absolute path so every
 * relative import of it resolves here.
 */

export function isSafeStorageReady(): boolean {
  return false;
}

export function encryptForDisk(_plaintext: string): string {
  throw new Error(
    "encryptForDisk() cannot run in the Studio renderer — secret persistence is server-owned; route through a FORWARDED store action instead.",
  );
}

export function decryptFromDisk(value: string): string {
  return value;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function encryptSensitiveSettings(settings: Record<string, any>): Record<string, any> {
  return settings;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function decryptSensitiveSettings(settings: Record<string, any>): Record<string, any> {
  return settings;
}
