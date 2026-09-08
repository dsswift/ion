import { ipcMain } from 'electron'
import { writeFileSync, existsSync, readFileSync } from 'fs'
import { execFile } from 'child_process'
import { homedir } from 'os'
import { join, basename } from 'path'
import { IPC } from '../../shared/types'
import { log as _log } from '../logger'
import { createOperationDir, cleanupDir } from '../utils/temp-dir'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('main', msg, fields)
}

const HALLUCINATIONS = /^\s*(\[BLANK_AUDIO\]|you\.?|thank you\.?|thanks\.?)\s*$/i

function runExecFile(bin: string, args: string[], timeout: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { encoding: 'utf-8', timeout }, (err: any, stdout: string, stderr: string) => {
      if (err) {
        const detail = stderr?.trim() || stdout?.trim() || err.message
        reject(new Error(detail))
        return
      }
      resolve(stdout || '')
    })
  })
}

/**
 * Locate a whisper binary.
 *
 * Every well-known location here is Homebrew's, and the PATH probe ran
 * `/bin/zsh -lc`. On Windows none of those paths exist and zsh is absent, so
 * the probe threw for each candidate and the operator got a "Whisper not
 * found. Install with: brew install ..." message naming a package manager
 * that does not exist on their machine.
 *
 * The well-known list and the PATH probe are now per-platform. A Windows
 * install is still expected to be on PATH -- there is no canonical install
 * location to guess at -- so the probe is what finds it.
 */
async function findWhisperBin(): Promise<string> {
  const names = ['whisperkit-cli', 'whisper-cli', 'whisper']

  if (process.platform !== 'win32') {
    const candidates = [
      '/opt/homebrew/bin/whisperkit-cli',
      '/usr/local/bin/whisperkit-cli',
      '/opt/homebrew/bin/whisper-cli',
      '/usr/local/bin/whisper-cli',
      '/opt/homebrew/bin/whisper',
      '/usr/local/bin/whisper',
      join(homedir(), '.local/bin/whisper'),
    ]
    for (const c of candidates) {
      if (existsSync(c)) return c
    }
  }

  for (const name of names) {
    try {
      // `whence -p` is a zsh builtin; `where.exe` is the Windows equivalent
      // and returns one path per line, so only the first is taken.
      const found = process.platform === 'win32'
        ? await runExecFile('where.exe', [name], 5000).then((s) => s.split(/\r?\n/)[0]?.trim() ?? '')
        : await runExecFile('/bin/zsh', ['-lc', `whence -p ${name}`], 5000).then((s) => s.trim())
      if (found) return found
    } catch { /* silent-ok: probe next whisper candidate when this lookup fails */ }
  }

  return ''
}

export function registerTranscribeIpc(): void {
  ipcMain.handle(IPC.TRANSCRIBE_AUDIO, async (_event, audioBase64: string) => {
    const opDir = createOperationDir('transcribe')
    try {
      const tmpWav = join(opDir, 'audio.wav')
      const buf = Buffer.from(audioBase64, 'base64')
      writeFileSync(tmpWav, buf)

      const whisperBin = await findWhisperBin()

      if (!whisperBin) {
        // The instruction has to name a package manager the operator actually
        // has. Telling a Windows user to run `brew install` is a dead end
        // dressed as guidance.
        const hint = whisperInstallHint()
        return {
          error: `Whisper not found. Install with:\n  ${hint}`,
          transcript: null,
        }
      }

      const isWhisperKit = whisperBin.includes('whisperkit-cli')
      const isWhisperCpp = !isWhisperKit && whisperBin.includes('whisper-cli')

      log('transcribe: starting', { bin: whisperBin, backend: isWhisperKit ? 'WhisperKit' : isWhisperCpp ? 'whisper-cpp' : 'Python whisper' })

      let output: string
      if (isWhisperKit) {
        output = await runExecFile(whisperBin, ['transcribe', '--audio-path', tmpWav, '--model', 'tiny', '--without-timestamps', '--skip-special-tokens', '--report', '--report-path', opDir], 60000)
        const wavBasename = basename(tmpWav, '.wav')
        const reportPath = join(opDir, `${wavBasename}.json`)
        if (existsSync(reportPath)) {
          try {
            const report = JSON.parse(readFileSync(reportPath, 'utf-8'))
            const transcript = (report.text || '').trim()
            return { error: null, transcript }
          } catch (parseErr: any) {
            log('transcribe: WhisperKit JSON parse failed, falling back to stdout', { error: parseErr.message })
          }
        }
        if (!output || !output.trim()) {
          output = await runExecFile(whisperBin, ['transcribe', '--audio-path', tmpWav, '--model', 'tiny', '--without-timestamps', '--skip-special-tokens'], 60000)
        }
      } else if (isWhisperCpp) {
        const modelCandidates = [
          join(homedir(), '.local/share/whisper/ggml-base.bin'),
          join(homedir(), '.local/share/whisper/ggml-tiny.bin'),
          '/opt/homebrew/share/whisper-cpp/models/ggml-base.bin',
          '/opt/homebrew/share/whisper-cpp/models/ggml-tiny.bin',
          join(homedir(), '.local/share/whisper/ggml-base.en.bin'),
          join(homedir(), '.local/share/whisper/ggml-tiny.en.bin'),
          '/opt/homebrew/share/whisper-cpp/models/ggml-base.en.bin',
          '/opt/homebrew/share/whisper-cpp/models/ggml-tiny.en.bin',
        ]

        let modelPath = ''
        for (const m of modelCandidates) {
          if (existsSync(m)) { modelPath = m; break }
        }

        if (!modelPath) {
          return {
            error: 'Whisper model not found. Download with:\n  mkdir -p ~/.local/share/whisper && curl -L -o ~/.local/share/whisper/ggml-tiny.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin',
            transcript: null,
          }
        }

        const isEnglishOnly = modelPath.includes('.en.')
        output = await runExecFile(whisperBin, ['-m', modelPath, '-f', tmpWav, '--no-timestamps', '-l', isEnglishOnly ? 'en' : 'auto'], 30000)
      } else {
        output = await runExecFile(whisperBin, [tmpWav, '--model', 'tiny', '--output_format', 'txt', '--output_dir', opDir], 30000)
        const txtPath = join(opDir, 'audio.txt')
        if (existsSync(txtPath)) {
          const transcript = readFileSync(txtPath, 'utf-8').trim()
          return { error: null, transcript }
        }
        return {
          error: `Whisper output file not found at ${txtPath}. Check disk space and permissions.`,
          transcript: null,
        }
      }

      const transcript = output
        .replace(/\[[\d:.]+\s*-->\s*[\d:.]+\]\s*/g, '')
        .trim()

      if (HALLUCINATIONS.test(transcript)) {
        return { error: null, transcript: '' }
      }

      return { error: null, transcript: transcript || '' }
    } catch (err: any) {
      log('transcribe: error', { error: err.message })
      return {
        error: `Transcription failed: ${err.message}`,
        transcript: null,
      }
    } finally {
      cleanupDir(opDir)
    }
  })
}

/** Install guidance for the current platform. */
function whisperInstallHint(): string {
  if (process.platform === 'win32') {
    return 'winget install whisper-cpp   (or put whisper-cli on your PATH)'
  }
  if (process.platform === 'linux') {
    return 'your package manager\'s whisper-cpp   (or put whisper-cli on your PATH)'
  }
  return process.arch === 'arm64'
    ? 'brew install whisperkit-cli   (or: brew install whisper-cpp)'
    : 'brew install whisper-cpp'
}
