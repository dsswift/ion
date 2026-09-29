/**
 * GPU time per process on macOS.
 *
 * macOS keeps a running total of GPU time for every GPU client in the I/O
 * Registry: each accelerator user client carries `AppUsage` entries with
 * `accumulatedGPUTime` (nanoseconds) and names its creator in
 * `IOUserClientCreator` ("pid 123, Name"). Reading it needs no privileges.
 * `ioreg -r -c IOAccelerator -l` prints every accelerator's clients, on Apple
 * Silicon and Intel alike, in about 15 ms.
 *
 * GPU % is the change in a pid's total divided by the wall time between two
 * reads. Only the pids asked for are kept: other apps' GPU use is never
 * stored.
 */
import { execFile } from 'child_process'

const IOREG_ARGS = ['-r', '-c', 'IOAccelerator', '-w', '0', '-l']
const IOREG_TIMEOUT_MS = 2_000

/** Sum of `accumulatedGPUTime` (ns) per creator pid in `ioreg` output. */
export function parseIoregGpuTime(output: string, pids: ReadonlySet<number>): Map<number, number> {
  const totals = new Map<number, number>()
  for (const section of output.split('+-o ')) {
    const creator = /"IOUserClientCreator" = "pid (\d+),/.exec(section)
    if (!creator) continue
    const pid = Number(creator[1])
    if (!pids.has(pid)) continue
    let sum = 0
    for (const m of section.matchAll(/"accumulatedGPUTime"=(\d+)/g)) sum += Number(m[1])
    totals.set(pid, (totals.get(pid) ?? 0) + sum)
  }
  return totals
}

/**
 * GPU % from two totals taken `elapsedMs` apart. Null when there is no
 * previous total, no time elapsed, or the total went backwards (the GPU
 * process restarted): an honest "not measured" rather than a negative number.
 */
export function gpuPercentFromTotals(prevNs: number | undefined, curNs: number, elapsedMs: number): number | null {
  if (prevNs === undefined || elapsedMs <= 0 || curNs < prevNs) return null
  return ((curNs - prevNs) / (elapsedMs * 1e6)) * 100
}

/** Runs `ioreg` and returns its output. */
export function readIoreg(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('/usr/sbin/ioreg', IOREG_ARGS, { timeout: IOREG_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err)
      else resolve(stdout)
    })
  })
}

/** Keeps the previous totals so each read reports GPU % since the last one. */
export class DarwinGpuReader {
  private prev = new Map<number, number>()
  private prevAt = 0

  constructor(private readonly read: () => Promise<string> = readIoreg) {}

  async sample(pids: ReadonlySet<number>, now: number): Promise<Map<number, number | null>> {
    const totals = parseIoregGpuTime(await this.read(), pids)
    const elapsed = now - this.prevAt
    const out = new Map<number, number | null>()
    for (const pid of pids) {
      const cur = totals.get(pid)
      out.set(pid, cur === undefined ? null : gpuPercentFromTotals(this.prev.get(pid), cur, elapsed))
    }
    this.prev = totals
    this.prevAt = now
    return out
  }
}
