import { describe, it, expect } from 'vitest'
import { isValidProjectPath } from '../ipc-validation'

// isValidProjectPath gates twelve IPC surfaces -- the file explorer, file
// read/write, git, worktrees, sessions. It tested `path.startsWith('/')`
// directly, which rejects every Windows path, so on Windows the explorer
// listed a real directory as empty and inline file creation silently did
// nothing: the handler returned its empty shape before touching the disk.
describe('isValidProjectPath', () => {
  it.each([
    ['C:\\Users\\josh', 'a Windows drive path'],
    ['C:/Users/josh', 'a Windows drive path with forward slashes'],
    ['c:\\dev\\ion', 'a lowercase drive letter'],
    ['\\\\server\\share\\dir', 'a UNC share'],
  ])('accepts %s (%s)', (path) => {
    expect(isValidProjectPath(path)).toBe(true)
  })

  it.each([
    ['/Users/josh', 'a POSIX absolute path'],
    ['/', 'the POSIX root'],
  ])('still accepts %s (%s)', (path) => {
    expect(isValidProjectPath(path)).toBe(true)
  })

  // The validator's security purpose is unchanged: it exists to reject
  // injection and relative traversal, and widening it for Windows must not
  // weaken that.
  it.each([
    ['relative/path', 'a relative path'],
    ['./here', 'an explicit relative path'],
    ['../escape', 'a traversal attempt'],
    ['', 'an empty string'],
    ['~', 'a home shorthand the callers map separately'],
    ['C:relative', 'a drive-relative path with no separator'],
  ])('rejects %s (%s)', (path) => {
    expect(isValidProjectPath(path)).toBe(false)
  })

  it.each([
    ['/tmp/a\0b', 'a null byte'],
    ['C:\\tmp\\a\nb', 'a newline'],
    ['C:\\tmp\\a\rb', 'a carriage return'],
  ])('rejects %s (%s) on every platform', (path) => {
    expect(isValidProjectPath(path)).toBe(false)
  })
})
