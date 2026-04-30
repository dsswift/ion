import { app, safeStorage } from 'electron'

const ENC_PREFIX = 'enc:v1:'

// isSafeStorageReady reports whether Electron's safeStorage backend is
// available. Returns false on Linux without a keyring or before app.isReady().
export function isSafeStorageReady(): boolean {
  if (!app.isReady()) return false
  try {
    return safeStorage.isEncryptionAvailable()
  } catch {
    return false
  }
}

// encryptForDisk returns ciphertext with the enc:v1: prefix when safeStorage
// is available; otherwise it returns the plaintext unchanged so the caller
// can choose to fall back. Callers that need a hard guarantee should check
// isSafeStorageReady() first.
export function encryptForDisk(plaintext: string): string {
  if (!plaintext) return plaintext
  if (!isSafeStorageReady()) return plaintext
  const buf = safeStorage.encryptString(plaintext)
  return ENC_PREFIX + buf.toString('base64')
}

// decryptFromDisk returns the plaintext for a value that was previously
// passed through encryptForDisk. Values without the enc:v1: prefix are
// returned unchanged so legacy plaintext settings keep working until the
// next write.
export function decryptFromDisk(value: string): string {
  if (!value || !value.startsWith(ENC_PREFIX)) return value
  if (!isSafeStorageReady()) return value
  try {
    const buf = Buffer.from(value.slice(ENC_PREFIX.length), 'base64')
    return safeStorage.decryptString(buf)
  } catch {
    return value
  }
}

// SENSITIVE_TOP_FIELDS lists settings keys whose top-level string value must
// be encrypted on disk.
const SENSITIVE_TOP_FIELDS = ['relayApiKey'] as const

// SENSITIVE_DEVICE_FIELDS lists fields on each entry of pairedDevices[] that
// must be encrypted on disk.
const SENSITIVE_DEVICE_FIELDS = ['sharedSecret'] as const

// encryptSensitiveSettings returns a copy of settings with sensitive fields
// replaced by their encrypted forms (where safeStorage is available).
export function encryptSensitiveSettings(settings: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = { ...settings }
  for (const key of SENSITIVE_TOP_FIELDS) {
    const v = out[key]
    if (typeof v === 'string' && v && !v.startsWith(ENC_PREFIX)) {
      out[key] = encryptForDisk(v)
    }
  }
  if (Array.isArray(out.pairedDevices)) {
    out.pairedDevices = out.pairedDevices.map((device: any) => {
      if (!device || typeof device !== 'object') return device
      const next = { ...device }
      for (const key of SENSITIVE_DEVICE_FIELDS) {
        const v = next[key]
        if (typeof v === 'string' && v && !v.startsWith(ENC_PREFIX)) {
          next[key] = encryptForDisk(v)
        }
      }
      return next
    })
  }
  if (!isSafeStorageReady()) {
    out.secret_unencrypted = true
  } else {
    delete out.secret_unencrypted
  }
  return out
}

// decryptSensitiveSettings returns a copy of settings with sensitive fields
// replaced by their plaintext forms.
export function decryptSensitiveSettings(settings: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = { ...settings }
  for (const key of SENSITIVE_TOP_FIELDS) {
    const v = out[key]
    if (typeof v === 'string' && v.startsWith(ENC_PREFIX)) {
      out[key] = decryptFromDisk(v)
    }
  }
  if (Array.isArray(out.pairedDevices)) {
    out.pairedDevices = out.pairedDevices.map((device: any) => {
      if (!device || typeof device !== 'object') return device
      const next = { ...device }
      for (const key of SENSITIVE_DEVICE_FIELDS) {
        const v = next[key]
        if (typeof v === 'string' && v.startsWith(ENC_PREFIX)) {
          next[key] = decryptFromDisk(v)
        }
      }
      return next
    })
  }
  return out
}
