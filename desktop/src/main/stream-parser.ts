import { Readable } from 'stream'
import { EventEmitter } from 'events'
import type { ClaudeEvent } from '../shared/types'

/**
 * Parses NDJSON output from `claude -p --output-format stream-json`.
 * Each line is a JSON object. Unknown event types are emitted but never crash.
 */
export class StreamParser extends EventEmitter {
  private buffer = ''

  /**
   * Feed a chunk of data (from stdout) into the parser.
   * Emits 'event' for each parsed JSON line.
   */
  feed(chunk: string): void {
    this.buffer += chunk
    const lines = this.buffer.split('\n')
    // Keep the last (possibly incomplete) line in the buffer
    this.buffer = lines.pop() || ''

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const parsed = JSON.parse(trimmed) as ClaudeEvent
        this.emit('event', parsed)
      } catch {
        // Non-JSON line (e.g. stderr mixed in) — log but don't crash
        this.emit('parse-error', trimmed)
      }
    }
  }

  /**
   * Flush any remaining data in the buffer (call when stream ends).
   */
  flush(): void {
    const trimmed = this.buffer.trim()
    if (trimmed) {
      try {
        const parsed = JSON.parse(trimmed) as ClaudeEvent
        this.emit('event', parsed)
      } catch {
        this.emit('parse-error', trimmed)
      }
    }
    this.buffer = ''
  }

  /**
   * Convenience: pipe a readable stream through the parser.
   */
  static fromStream(stream: Readable): StreamParser {
    const parser = new StreamParser()
    stream.setEncoding('utf-8')
    stream.on('data', (chunk: string) => parser.feed(chunk))
    stream.on('end', () => parser.flush())
    return parser
  }
}
