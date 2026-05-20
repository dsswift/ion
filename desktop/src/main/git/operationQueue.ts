/**
 * Operation queue for git commands.
 *
 * - Mutations (stage, unstage, commit, checkout, etc.) are serialized
 *   to prevent .git/index lock races.
 * - Reads (diff, show, blame, log) run concurrently, capped at maxConcurrentReads.
 * - Every operation carries an AbortSignal for cancellation.
 */

import { log as _log } from '../logger'

function log(msg: string): void {
  _log('main', msg)
}

export type OperationKind = 'mutation' | 'read'

interface QueuedOperation<T> {
  id: string
  kind: OperationKind
  run: (signal: AbortSignal) => Promise<T>
  resolve: (value: T) => void
  reject: (error: Error) => void
  abortController: AbortController
}

export class OperationQueue {
  private readonly maxConcurrentReads: number
  private readonly mutationQueue: QueuedOperation<unknown>[] = []
  private activeReads = 0
  private activeMutation: QueuedOperation<unknown> | null = null
  private opCounter = 0
  private readonly pendingReads: QueuedOperation<unknown>[] = []

  /** Event callbacks — consumers can wire these up for UI spinners. */
  onOperationStart?: (id: string, kind: OperationKind) => void
  onOperationComplete?: (id: string, kind: OperationKind) => void

  constructor(maxConcurrentReads = 4) {
    this.maxConcurrentReads = maxConcurrentReads
  }

  /** Enqueue a mutation (serialized). */
  enqueueMutation<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    return this.enqueue('mutation', fn)
  }

  /** Enqueue a read (concurrent, capped). */
  enqueueRead<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    return this.enqueue('read', fn)
  }

  /** Cancel all pending operations. */
  cancelAll(): void {
    for (const op of this.mutationQueue) {
      op.abortController.abort()
      op.reject(new Error('Operation cancelled'))
    }
    this.mutationQueue.length = 0

    for (const op of this.pendingReads) {
      op.abortController.abort()
      op.reject(new Error('Operation cancelled'))
    }
    this.pendingReads.length = 0

    if (this.activeMutation) {
      this.activeMutation.abortController.abort()
    }
  }

  /** Number of in-flight + pending operations. */
  get pending(): number {
    return this.mutationQueue.length + this.pendingReads.length +
      this.activeReads + (this.activeMutation ? 1 : 0)
  }

  private enqueue<T>(kind: OperationKind, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const id = `op-${++this.opCounter}`
    const abortController = new AbortController()

    return new Promise<T>((resolve, reject) => {
      const op: QueuedOperation<T> = {
        id,
        kind,
        run: fn,
        resolve,
        reject,
        abortController,
      }

      if (kind === 'mutation') {
        this.mutationQueue.push(op as QueuedOperation<unknown>)
        this.drainMutations()
      } else {
        this.pendingReads.push(op as QueuedOperation<unknown>)
        this.drainReads()
      }
    })
  }

  private async drainMutations(): Promise<void> {
    if (this.activeMutation) return
    const op = this.mutationQueue.shift()
    if (!op) return

    this.activeMutation = op
    this.onOperationStart?.(op.id, 'mutation')

    try {
      const result = await op.run(op.abortController.signal)
      op.resolve(result)
    } catch (err) {
      op.reject(err as Error)
    } finally {
      this.activeMutation = null
      this.onOperationComplete?.(op.id, 'mutation')
      this.drainMutations()
    }
  }

  private async drainReads(): Promise<void> {
    while (this.pendingReads.length > 0 && this.activeReads < this.maxConcurrentReads) {
      const op = this.pendingReads.shift()
      if (!op) break

      this.activeReads++
      this.onOperationStart?.(op.id, 'read')

      // eslint-disable-next-line no-loop-func
      op.run(op.abortController.signal)
        .then((result) => op.resolve(result))
        .catch((err) => op.reject(err as Error))
        .finally(() => {
          this.activeReads--
          this.onOperationComplete?.(op.id, 'read')
          this.drainReads()
        })
    }
  }
}
