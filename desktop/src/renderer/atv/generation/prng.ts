/**
 * Seeded PRNG for all ATV randomness (generation, casting, ambient behavior).
 *
 * Determinism contract: same seed string always yields the same stream, on
 * every platform. Nothing in ATV generation may use Math.random or Date-based
 * entropy — every random choice flows through an AtvRng created here.
 */

/** 32-bit string hash (FNV-1a). Stable across platforms. */
export function hashString(input: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    // FNV prime multiply, kept in uint32 with Math.imul.
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

export interface AtvRng {
  /** Uniform float in [0, 1). */
  next(): number
  /** Uniform integer in [0, maxExclusive). */
  nextInt(maxExclusive: number): number
  /** Pick one element (undefined for an empty array). */
  pick<T>(items: readonly T[]): T | undefined
  /** Weighted pick by a weight accessor; undefined when total weight is 0. */
  pickWeighted<T>(items: readonly T[], weightOf: (item: T) => number): T | undefined
  /** Fisher-Yates shuffle into a new array. */
  shuffle<T>(items: readonly T[]): T[]
}

/** Create a deterministic RNG (mulberry32 core) from any seed string. */
export function createRng(seed: string): AtvRng {
  let a = hashString(seed) || 0x9e3779b9

  function next(): number {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  function nextInt(maxExclusive: number): number {
    if (maxExclusive <= 0) return 0
    return Math.floor(next() * maxExclusive)
  }

  return {
    next,
    nextInt,
    pick: (items) => (items.length === 0 ? undefined : items[nextInt(items.length)]),
    pickWeighted: (items, weightOf) => {
      let total = 0
      for (const item of items) total += Math.max(0, weightOf(item))
      if (total <= 0) return undefined
      let roll = next() * total
      for (const item of items) {
        roll -= Math.max(0, weightOf(item))
        if (roll < 0) return item
      }
      return items[items.length - 1]
    },
    shuffle: (items) => {
      const out = [...items]
      for (let i = out.length - 1; i > 0; i--) {
        const j = nextInt(i + 1)
        const tmp = out[i]
        out[i] = out[j]
        out[j] = tmp
      }
      return out
    },
  }
}

/**
 * Derive a child seed for an independent random stream. Keeps subsystem
 * streams (layout vs dressing vs ambient) decoupled: consuming extra numbers
 * in one never shifts another.
 */
export function deriveSeed(seed: string, label: string): string {
  return `${seed}::${label}::${hashString(seed + label).toString(16)}`
}
