import { describe, it, expect } from "vitest";
import {
  estimateModelSwitchCost,
  formatModelSwitchCost,
  formatTokenCount,
  formatUsd,
  CACHE_CREATION_FALLBACK_MULTIPLIER,
  CACHE_READ_FALLBACK_MULTIPLIER,
} from "../model-switch-cost";

const OPUS = { id: "claude-opus-5", costPer1kInput: 0.015 };

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

describe("formatTokenCount", () => {
  it("scales to K and M", () => {
    expect(formatTokenCount(650)).toBe("650");
    expect(formatTokenCount(1_200)).toBe("1K");
    expect(formatTokenCount(650_000)).toBe("650K");
    expect(formatTokenCount(1_500_000)).toBe("1.5M");
  });
});

describe("formatModelSwitchCost", () => {
  it("states both the switch cost and the stay-put cost", () => {
    const text = formatModelSwitchCost(estimateModelSwitchCost(650_000, OPUS)!);
    expect(text).toContain("650K");
    expect(text).toContain("$12.19");
    expect(text).toContain("$0.98");
  });
});
