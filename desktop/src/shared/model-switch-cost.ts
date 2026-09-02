/**
 * Model-switch cost estimation.
 *
 * A provider prompt cache is keyed per exact model. Switching the model a
 * conversation runs on therefore cannot reuse the cache the previous model
 * built: the whole conversation is re-sent as cache-creation input on the
 * first turn after the switch, instead of being read back at the much cheaper
 * cache-read rate. This holds for a same-vendor switch too — the cache is
 * per-model, not per-account, so a Sonnet-to-Opus hop is no cheaper than a
 * cross-vendor one.
 *
 * The operator cannot see that from the picker, which is why switching mid
 * conversation is easy to do repeatedly by accident. This module turns the
 * conversation's current size into the concrete dollar figure the next turn
 * will cost, so the picker can state it before the switch happens.
 *
 * The model catalog publishes explicit cache rates when available. The
 * estimator uses those rates and applies the documented fallbacks only when a
 * model does not publish one.
 */

/** Applied to costPer1kInput when a model has no explicit cache-creation rate. */
export const CACHE_CREATION_FALLBACK_MULTIPLIER = 1.25;

/** Applied to costPer1kInput when a model has no explicit cache-read rate. */
export const CACHE_READ_FALLBACK_MULTIPLIER = 0.1;

/** The pricing inputs a switch estimate needs from the target model. */
export interface SwitchCostModel {
  id: string;
  costPer1kInput: number;
  costPer1kCacheCreation?: number;
  costPer1kCacheRead?: number;
}

export interface ModelSwitchCostEstimate {
  /** Tokens that would be re-sent as cache-creation input. */
  tokens: number;
  /** USD cost of re-sending those tokens to the target model. */
  costUsd: number;
  /**
   * USD cost the same tokens would have had as a cache read on the model the
   * conversation is already using. Null when that model has no usable price.
   */
  cachedCostUsd: number | null;
  /**
   * True when the estimate is a real computation. False when the target
   * model publishes no usable input price, in which case the token count is
   * still meaningful, the switch cost is zero, and the stay-put comparison is
   * unavailable. Consumers must not show either value as if it were priced.
   */
  priced: boolean;
}

/**
 * Estimate what the first turn after a model switch will cost.
 *
 * `contextTokens` is the conversation's current model-visible size, which the
 * engine already reports through `StatusFields.contextTokens`. A null or
 * non-positive value means there is nothing to re-send.
 *
 * Returns null when no switch cost applies at all — no history, or no target
 * model. A null result is the signal that the switch is free and needs no
 * warning, which is exactly the fresh-conversation case.
 */
export function estimateModelSwitchCost(
  contextTokens: number | null | undefined,
  targetModel: SwitchCostModel | null | undefined,
  currentModel?: SwitchCostModel | null,
): ModelSwitchCostEstimate | null {
  if (!contextTokens || contextTokens <= 0) return null;
  if (!targetModel) return null;

  const inputRate = targetModel.costPer1kInput;
  // A model with no published price is not free — it is unknown. Report the
  // token count and mark the estimate unpriced rather than printing $0.00,
  // which would read as "this switch costs nothing".
  if (!Number.isFinite(inputRate) || inputRate <= 0) {
    return {
      tokens: contextTokens,
      costUsd: 0,
      cachedCostUsd: null,
      priced: false,
    };
  }

  const explicitCreation = targetModel.costPer1kCacheCreation;
  const cacheCreationRate = Number.isFinite(explicitCreation) && explicitCreation! > 0
    ? explicitCreation!
    : inputRate * CACHE_CREATION_FALLBACK_MULTIPLIER;
  const current = currentModel ?? targetModel;
  const currentInputRate = current.costPer1kInput;
  const explicitRead = current.costPer1kCacheRead;
  const cacheReadRate = Number.isFinite(currentInputRate) && currentInputRate > 0
    ? (Number.isFinite(explicitRead) && explicitRead! > 0
      ? explicitRead!
      : currentInputRate * CACHE_READ_FALLBACK_MULTIPLIER)
    : null;
  const perThousand = contextTokens / 1000;
  return {
    tokens: contextTokens,
    costUsd: perThousand * cacheCreationRate,
    cachedCostUsd: cacheReadRate === null ? null : perThousand * cacheReadRate,
    priced: true,
  };
}

/**
 * Format an estimate as short operator-facing text.
 *
 * Deliberately terse: this appears in a confirmation the operator reads while
 * doing something else. It states the cost and the reason, not a lecture.
 */
export function formatModelSwitchCost(
  estimate: ModelSwitchCostEstimate,
): string {
  const tokens = formatTokenCount(estimate.tokens);
  if (!estimate.priced) {
    return `${tokens} tokens will be re-sent to the new model. This model publishes no price, so the cost is unknown.`;
  }
  const switchText = `${tokens} tokens will be re-sent to the new model, about ${formatUsd(estimate.costUsd)}.`;
  if (estimate.cachedCostUsd === null) {
    return switchText;
  }
  return `${switchText} The same tokens cost about ${formatUsd(estimate.cachedCostUsd)} on the model you are already using.`;
}

/** Compact token count: 1200 -> "1.2K", 650000 -> "650K", 1500000 -> "1.5M". */
export function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) {
    return `${(tokens / 1_000_000).toFixed(1)}M`;
  }
  if (tokens >= 1_000) {
    return `${Math.round(tokens / 1_000)}K`;
  }
  return String(tokens);
}

/**
 * USD with enough precision to stay honest at small amounts. A switch that
 * costs a third of a cent must not render as "$0.00" — that reads as free.
 */
export function formatUsd(amount: number): string {
  if (amount > 0 && amount < 0.01) return "<$0.01";
  const roundedCents = Math.round((amount + Number.EPSILON) * 100) / 100;
  return `$${roundedCents.toFixed(2)}`;
}
