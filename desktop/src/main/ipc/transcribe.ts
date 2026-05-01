import { ipcMain } from 'electron'
import { writeFileSync, existsSync, unlinkSync, readFileSync } from 'fs'
import { execFile } from 'child_process'
import { homedir, tmpdir } from 'os'
import { join, basename } from 'path'
import { IPC } from '../../shared/types'
import { log as _log } from '../logger'

function log(msg: string): void {
  _log('main', msg)
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

async function findWhisperBin(): Promise<string> {
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

  for (const name of ['whisperkit-cli', 'whisper-cli', 'whisper']) {
    try {
      const found = await runExecFile('/bin/zsh', ['-lc', `whence -p ${name}`], 5000).then((s) => s.trim())
      if (found) return found
    } catch {}
  }

  return ''
}

export function registerTranscribeIpc(): void {
  ipcMain.handle(IPC.TRANSCRIBE_AUDIO, async (_event, audioBase64: string) => {
    const tmpWav = join(tmpdir(), `ion-voice-${Date.now()}.wav`)
    try {
      const buf = Buffer.from(audioBase64, 'base64')
      writeFileSync(tmpWav, buf)

      const whisperBin = await findWhisperBin()

      if (!whisperBin) {
        const hint = process.arch === 'arm64'
          ? 'brew install whisperkit-cli   (or: brew install whisper-cpp)'
          : 'brew install whisper-cpp'
        return {
          error: `Whisper not found. Install with:\n  ${hint}`,
          transcript: null,
        }
      }

      const isWhisperKit = whisperBin.includes('whisperkit-cli')
      const isWhisperCpp = !isWhisperKit && whisperBin.includes('whisper-cli')

      log(`Transcribing with: ${whisperBin} (backend: ${isWhisperKit ? 'WhisperKit' : isWhisperCpp ? 'whisper-cpp' : 'Python whisper'})`)

      let output: string
      if (isWhisperKit) {
        const reportDir = tmpdir()
        output = await runExecFile(whisperBin, ['transcribe', '--audio-path', tmpWav, '--model', 'tiny', '--without-timestamps', '--skip-special-tokens', '--report', '--report-path', reportDir], 60000)
        const wavBasename = basename(tmpWav, '.wav')
        const reportPath = join(reportDir, `${wavBasename}.json`)
        if (existsSync(reportPath)) {
          try {
            const report = JSON.parse(readFileSync(reportPath, 'utf-8'))
            const transcript = (report.text || '').trim()
            try { unlinkSync(reportPath) } catch {}
            const srtPath = join(reportDir, `${wavBasename}.srt`)
            try { unlinkSync(srtPath) } catch {}
            return { error: null, transcript }
          } catch (parseErr: any) {
            log(`WhisperKit JSON parse failed: ${parseErr.message}, falling back to stdout`)
            try { unlinkSync(reportPath) } catch {}
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
        output = await runExecFile(whisperBin, [tmpWav, '--model', 'tiny', '--output_format', 'txt', '--output_dir', tmpdir()], 30000)
        const txtPath = tmpWav.replace('.wav', '.txt')
        if (existsSync(txtPath)) {
          const transcript = readFileSync(txtPath, 'utf-8').trim()
          try { unlinkSync(txtPath) } catch {}
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
      log(`Transcription error: ${err.message}`)
      return {
        error: `Transcription failed: ${err.message}`,
        transcript: null,
      }
    } finally {
      try { unlinkSync(tmpWav) } catch {}
    }
  })
}
