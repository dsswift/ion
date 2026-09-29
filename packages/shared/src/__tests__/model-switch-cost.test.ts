import { describe, it, expect } from "vitest";
import {
  estimateModelSwitchCost,
  formatModelSwitchCost,
  formatModelSwitchReason,
  formatDuration,
  formatTokenCount,
  formatUsd,
  resolveCacheState,
  CACHE_CREATION_FALLBACK_MULTIPLIER,
  CACHE_READ_FALLBACK_MULTIPLIER,
} from "../model-switch-cost";

const OPUS = { id: "claude-opus-5", costPer1kInput: 0.015 };

/** A caching model with a 5-minute cache, the shape the engine publishes. */
const CACHING = {
  id: "claude-fable-5-1",
  costPer1kInput: 0.01,
  costPer1kCacheCreation: 0.0125,
  costPer1kCacheRead: 0.00025,
  supportsCaching: true,
  cacheTtlSeconds: 300,
};

const NOW = 1_700_000_000_000;
/** Inside the 5-minute cache window. */
const WARM = { lastActivityAt: NOW - 60_000, now: NOW };
/** Past the 5-minute cache window. */
const COLD = { lastActivityAt: NOW - 30 * 60_000, now: NOW };

describe("estimateModelSwitchCost", () => {
  it("returns null on a fresh conversation so no warning is shown", () => {
    expect(estimateModelSwitchCost(0, OPUS)).toBeNull();
    expect(estimateModelSwitchCost(null, OPUS)).toBeNull();
    expect(estimateModelSwitchCost(undefined, OPUS)).toBeNull();
  });

  it("returns null with no target model", () => {
    expect(estimateModelSwitchCost(650_000, null)).toBeNull();
  });

  it("prices the re-write at the cache-creation rate", () => {
    const est = estimateModelSwitchCost(650_000, OPUS);
    expect(est).not.toBeNull();
    // 650 thousand-token units * $0.015 * 1.25
    expect(est!.costUsd).toBeCloseTo(650 * 0.015 * CACHE_CREATION_FALLBACK_MULTIPLIER, 6);
    expect(est!.tokens).toBe(650_000);
    expect(est!.priced).toBe(true);
  });

  it("uses exact cache rates before fallbacks", () => {
    const est = estimateModelSwitchCost(650_000, {
      ...OPUS,
      costPer1kCacheCreation: 0.02,
      costPer1kCacheRead: 0.003,
    })!
    expect(est.costUsd).toBeCloseTo(650 * 0.02, 6)
    expect(est.cachedCostUsd!).toBeCloseTo(650 * 0.003, 6)
  })
  it("falls back for absent, zero, or non-finite cache rates", () => {
    for (const explicit of [undefined, 0, Number.NaN]) {
      const est = estimateModelSwitchCost(650_000, {
        ...OPUS,
        costPer1kCacheCreation: explicit,
        costPer1kCacheRead: explicit,
      })!
      expect(est.costUsd).toBeCloseTo(650 * 0.015 * CACHE_CREATION_FALLBACK_MULTIPLIER, 6)
      expect(est.cachedCostUsd!).toBeCloseTo(650 * 0.015 * CACHE_READ_FALLBACK_MULTIPLIER, 6)
    }
  })

  it("uses the current model rate for the stay-put comparison", () => {
    const target = { ...OPUS, costPer1kCacheCreation: 0.02, costPer1kCacheRead: 0.003 }
    const current = { id: "current", costPer1kInput: 0.003, costPer1kCacheRead: 0.0002 }
    const est = estimateModelSwitchCost(650_000, target, current)!
    expect(est.costUsd).toBeCloseTo(650 * 0.02, 6)
    expect(est.cachedCostUsd!).toBeCloseTo(650 * 0.0002, 6)
  })

  it("reports what the same tokens would cost as a cache read", () => {
    const est = estimateModelSwitchCost(650_000, OPUS)!;
    expect(est.cachedCostUsd!).toBeCloseTo(650 * 0.015 * CACHE_READ_FALLBACK_MULTIPLIER, 6);
    // The switch is materially more expensive than staying put. 1.25 vs 0.1
    // is the whole reason the warning exists.
    expect(est.costUsd / est.cachedCostUsd!).toBeCloseTo(12.5, 6);
  });

  it("marks an unpriced model rather than reporting $0", () => {
    const est = estimateModelSwitchCost(650_000, { id: "local", costPer1kInput: 0 })!;
    expect(est.priced).toBe(false);
    expect(est.tokens).toBe(650_000);
    expect(formatModelSwitchCost(est)).toContain("cost is unknown");
  });
});

// The cache's age is what makes the stay-put figure true or false. These are
// the arms that were wrong before: the estimator priced every stay-put side at
// the cache-read rate unconditionally, so an idle conversation was quoted a
// saving that had already expired — understating the real cost by the full
// creation-to-read ratio and inverting the recommendation.
describe("cache age decides the stay-put rate", () => {
  it("prices a live cache at the cache-read rate", () => {
    const est = estimateModelSwitchCost(169_000, OPUS, CACHING, WARM)!;
    expect(est.cacheState).toBe("warm");
    expect(est.cachedCostUsd!).toBeCloseTo(169 * 0.00025, 6);
    expect(est.idleSeconds).toBeCloseTo(60, 6);
    expect(est.cacheTtlSeconds).toBe(300);
  });

  it("prices an expired cache at the cache-creation rate, not the read rate", () => {
    const est = estimateModelSwitchCost(169_000, OPUS, CACHING, COLD)!;
    expect(est.cacheState).toBe("expired");
    // The next turn on the CURRENT model rewrites the whole prompt, exactly
    // as a switch would. That is the creation rate.
    expect(est.cachedCostUsd!).toBeCloseTo(169 * 0.0125, 6);
    // 50x the figure the read rate would have produced. This is the size of
    // the error, and why an approximation here is not acceptable.
    expect(est.cachedCostUsd! / (169 * 0.00025)).toBeCloseTo(50, 6);
  });

  it("can make switching cheaper than staying, and says so", () => {
    // The real case: a 169K conversation idle for half an hour on Fable,
    // switching to Opus. Fable's rewrite costs more than Opus's does, so the
    // "stay put and save" advice is backwards.
    const opus = {
      id: "claude-opus-5",
      costPer1kInput: 0.005,
      costPer1kCacheCreation: 0.00625,
      costPer1kCacheRead: 0.0005,
      supportsCaching: true,
      cacheTtlSeconds: 300,
    };
    const est = estimateModelSwitchCost(169_000, opus, CACHING, COLD)!;
    expect(est.costUsd).toBeLessThan(est.cachedCostUsd!);
  });

  it("treats the exact TTL boundary as still readable", () => {
    const atBoundary = { lastActivityAt: NOW - 300_000, now: NOW };
    expect(estimateModelSwitchCost(1_000, OPUS, CACHING, atBoundary)!.cacheState).toBe("warm");
    const pastBoundary = { lastActivityAt: NOW - 300_001, now: NOW };
    expect(estimateModelSwitchCost(1_000, OPUS, CACHING, pastBoundary)!.cacheState).toBe("expired");
  });

  it("prices a non-caching model at its base input rate", () => {
    const noCache = { id: "gpt-4.1", costPer1kInput: 0.002, supportsCaching: false };
    const est = estimateModelSwitchCost(169_000, OPUS, noCache, WARM)!;
    expect(est.cacheState).toBe("unsupported");
    expect(est.cachedCostUsd!).toBeCloseTo(169 * 0.002, 6);
  });

  it("reports unknown rather than guessing when the age is missing", () => {
    const est = estimateModelSwitchCost(169_000, OPUS, CACHING)!;
    expect(est.cacheState).toBe("unknown");
    expect(est.idleSeconds).toBeNull();
    // The warm rate is the lower bound, and the text must not state it as fact.
    expect(est.cachedCostUsd!).toBeCloseTo(169 * 0.00025, 6);
    expect(formatModelSwitchCost(est)).toContain("its age could not be determined");
  });

  it("reports unknown rather than guessing when the model declares no TTL", () => {
    const noTtl = { ...CACHING, cacheTtlSeconds: undefined };
    const est = estimateModelSwitchCost(169_000, OPUS, noTtl, COLD)!;
    expect(est.cacheState).toBe("unknown");
  });

  it("clamps clock skew instead of reporting a false expiry", () => {
    const future = { lastActivityAt: NOW + 60_000, now: NOW };
    const est = estimateModelSwitchCost(1_000, OPUS, CACHING, future)!;
    expect(est.cacheState).toBe("warm");
    expect(est.idleSeconds).toBe(0);
  });
});

describe("resolveCacheState", () => {
  it("does not read the clock when caching is unsupported", () => {
    const state = resolveCacheState({ id: "x", costPer1kInput: 1, supportsCaching: false }, COLD);
    expect(state.state).toBe("unsupported");
    expect(state.ttlSeconds).toBeNull();
  });
});

describe("formatModelSwitchReason", () => {
  it("explains the per-model cache only while a cache exists to lose", () => {
    const warm = estimateModelSwitchCost(169_000, OPUS, CACHING, WARM)!;
    expect(formatModelSwitchReason(warm)).toContain("cannot read the cache");
  });

  it("stays silent once the cache is gone", () => {
    // Repeating "the new model cannot read the cache this conversation built"
    // after that cache expired describes a cache that is not there, and
    // implies a saving the operator would be protecting by staying put.
    const cold = estimateModelSwitchCost(169_000, OPUS, CACHING, COLD)!;
    expect(formatModelSwitchReason(cold)).toBeNull();
    const noCache = estimateModelSwitchCost(
      169_000, OPUS, { id: "g", costPer1kInput: 0.002, supportsCaching: false }, WARM,
    )!;
    expect(formatModelSwitchReason(noCache)).toBeNull();
  });
});

describe("formatUsd", () => {
  it("never renders a real cost as $0.00", () => {
    // A third of a cent is not free. Printing "$0.00" would tell the operator
    // the switch costs nothing, which is the opposite of this feature's point.
    expect(formatUsd(0.003)).toBe("<$0.01");
  });

  it("formats ordinary amounts to cents", () => {
    expect(formatUsd(12.1875)).toBe("$12.19");
    expect(formatUsd(0)).toBe("$0.00");
  });
});

describe("formatDuration", () => {
  it("scales to the coarsest truthful unit", () => {
    expect(formatDuration(45)).toBe("45s");
    expect(formatDuration(600)).toBe("10m");
    expect(formatDuration(7_200)).toBe("2h");
    expect(formatDuration(72 * 3_600)).toBe("3d");
  });

  it("says 'a while' rather than inventing a number", () => {
    expect(formatDuration(null)).toBe("a while");
  });
});

describe("formatTokenCount", () => {
  it("scales to K and M", () => {
    expect(formatTokenCount(650)).toBe("650");
    expect(formatTokenCount(1_200)).toBe("1K");
    expect(formatTokenCount(650_000)).toBe("650K");
    expect(formatTokenCount(1_500_000)).toBe("1.5M");
  });
});

// The dialog must state which option is cheaper. The cache state is an input
// the estimator already resolved, not a caveat to hand back to the operator.
describe("formatModelSwitchCost", () => {
  it("states both the switch cost and the stay-put cost", () => {
    const text = formatModelSwitchCost(estimateModelSwitchCost(650_000, OPUS)!);
    expect(text).toContain("650K");
    expect(text).toContain("$12.19");
    expect(text).toContain("$0.98");
  });

  it("says staying is cheaper, and by how much, on a live cache", () => {
    const text = formatModelSwitchCost(estimateModelSwitchCost(169_000, OPUS, CACHING, WARM)!);
    expect(text).toContain("Staying on the current model is cheaper");
    expect(text).toContain("still live");
    expect(text).toContain("idle 60s");
    // 169 * 0.015 * 1.25 = 3.16875 switch; 169 * 0.00025 = 0.04225 stay.
    expect(text).toContain("$3.17");
    expect(text).toContain("$0.04");
    expect(text).toContain("saves about $3.13");
  });

  it("says switching is cheaper when the expired cache inverts the comparison", () => {
    // The reported case: 169K idle 30m on Fable, switching to Opus. Both sides
    // re-write the prompt, and Opus's rate is lower.
    const opus5 = {
      id: "claude-opus-5",
      costPer1kInput: 0.005,
      costPer1kCacheCreation: 0.00625,
      costPer1kCacheRead: 0.0005,
      supportsCaching: true,
      cacheTtlSeconds: 300,
    };
    const text = formatModelSwitchCost(estimateModelSwitchCost(169_000, opus5, CACHING, COLD)!);
    expect(text).toContain("Switching is cheaper");
    expect(text).toContain("already expired");
    expect(text).toContain("idle 30m");
    // 169 * 0.00625 = 1.05625 switch; 169 * 0.0125 = 2.1125 stay.
    expect(text).toContain("$1.06");
    expect(text).toContain("$2.11");
    expect(text).toContain("saves about $1.06");
    // It must never claim a cache advantage that no longer exists.
    expect(text).not.toContain("still live");
  });

  it("still names the cheaper side when an expired cache leaves staying ahead", () => {
    const text = formatModelSwitchCost(estimateModelSwitchCost(169_000, OPUS, CACHING, COLD)!);
    expect(text).toContain("Staying on the current model is cheaper");
    // and is explicit that the cache is NOT the reason.
    expect(text).toContain("not because of its cache");
  });

  it("names the cheaper side when the current model never caches", () => {
    const noCache = { id: "gpt-4.1", costPer1kInput: 0.002, supportsCaching: false };
    const text = formatModelSwitchCost(estimateModelSwitchCost(169_000, OPUS, noCache, WARM)!);
    expect(text).toContain("Staying on the current model is cheaper");
    expect(text).toContain("does not cache prompts");
  });

  it("hedges only when an input was genuinely missing, and says which", () => {
    const text = formatModelSwitchCost(estimateModelSwitchCost(169_000, OPUS, CACHING)!);
    expect(text).toContain("its age could not be determined");
    expect(text).not.toContain("is cheaper");
  });
});
