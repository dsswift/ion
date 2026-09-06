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
 * Both figures the picker shows are costs for the NEXT turn, and the honest
 * comparison is between them. That makes the cache's lifetime part of the
 * arithmetic, not a detail: a prompt cache entry is only readable for a
 * bounded window after the write that created it. Once it expires, staying on
 * the current model re-writes the whole prompt at the cache-creation rate,
 * exactly like switching does. A stay-put figure quoted at the cache-read rate
 * when the cache is already gone understates the true cost by the full
 * creation-to-read ratio — up to 50x — and can invert the comparison
 * completely, telling the operator to stay put when switching is cheaper.
 *
 * So the estimator takes the age of the conversation's last activity and the
 * cache lifetime the engine publishes for the model (`cacheTtlSeconds`), and
 * prices the stay-put side against a cache it has established is still alive.
 * When the age or the lifetime is unknown it does not guess: it reports the
 * warm figure and marks it unconfirmed, so the caller can say so rather than
 * assert a number it cannot stand behind.
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
  /**
   * Whether this model caches prompts at all. A model that does not cache has
   * no cheap path: every turn bills the whole prompt at the base input rate,
   * so there is no "stay put and read the cache" saving to compare against.
   */
  supportsCaching?: boolean;
  /**
   * Prompt-cache lifetime in seconds, as published by the engine. Undefined or
   * zero means the engine declared none, and this module will not invent one.
   */
  cacheTtlSeconds?: number;
}

/** Why the stay-put figure is priced the way it is. */
export type CacheState =
  /** The cache is provably still readable: activity is inside the lifetime. */
  | "warm"
  /** The cache has provably expired: activity is older than the lifetime. */
  | "expired"
  /** The current model does not cache prompts at all. */
  | "unsupported"
  /**
   * Either the last-activity time or the cache lifetime is unavailable, so
   * whether the cache survives cannot be determined. Priced as warm, which is
   * the lower bound, and flagged so the caller never states it as fact.
   */
  | "unknown";

export interface ModelSwitchCostEstimate {
  /** Tokens that would be re-sent as cache-creation input. */
  tokens: number;
  /** USD cost of re-sending those tokens to the target model. */
  costUsd: number;
  /**
   * USD cost of the next turn's same tokens if the operator stays on the model
   * the conversation is already using. Priced at that model's cache-read rate
   * only when its cache is still readable; at its cache-creation rate once the
   * cache has expired, because that is what the next turn would actually bill.
   * Null when that model has no usable price.
   */
  cachedCostUsd: number | null;
  /** Which of those two rates `cachedCostUsd` used, and why. */
  cacheState: CacheState;
  /**
   * Seconds since the conversation's last activity, when known. Null when the
   * caller supplied no activity timestamp.
   */
  idleSeconds: number | null;
  /** The cache lifetime used to judge `cacheState`. Null when undeclared. */
  cacheTtlSeconds: number | null;
  /**
   * True when the estimate is a real computation. False when the target
   * model publishes no usable input price, in which case the token count is
   * still meaningful, the switch cost is zero, and the stay-put comparison is
   * unavailable. Consumers must not show either value as if it were priced.
   */
  priced: boolean;
}

/** Inputs describing how long the conversation has been sitting idle. */
export interface CacheAgeInput {
  /**
   * Wall-clock ms of the conversation's last activity — the last turn that
   * would have written the prompt cache. Null or undefined when unknown.
   */
  lastActivityAt?: number | null;
  /** Wall-clock ms to measure the age against. Defaults to Date.now(). */
  now?: number;
}

/**
 * Resolve the cache-read rate for a model, or null when it has no usable price.
 */
function cacheReadRate(model: SwitchCostModel): number | null {
  const inputRate = model.costPer1kInput;
  if (!Number.isFinite(inputRate) || inputRate <= 0) return null;
  const explicit = model.costPer1kCacheRead;
  if (Number.isFinite(explicit) && explicit! > 0) return explicit!;
  return inputRate * CACHE_READ_FALLBACK_MULTIPLIER;
}

/**
 * Resolve the cache-creation rate for a model, or null when it has no usable
 * price.
 */
function cacheCreationRate(model: SwitchCostModel): number | null {
  const inputRate = model.costPer1kInput;
  if (!Number.isFinite(inputRate) || inputRate <= 0) return null;
  const explicit = model.costPer1kCacheCreation;
  if (Number.isFinite(explicit) && explicit! > 0) return explicit!;
  return inputRate * CACHE_CREATION_FALLBACK_MULTIPLIER;
}

/**
 * Decide whether the current model's prompt cache is still readable.
 *
 * Returns "unknown" rather than assuming warm or expired whenever either input
 * is missing. Guessing here is what produces a confidently wrong dollar figure.
 */
export function resolveCacheState(
  currentModel: SwitchCostModel,
  age?: CacheAgeInput,
): { state: CacheState; idleSeconds: number | null; ttlSeconds: number | null } {
  // A model that never writes a cache has no warm path to compare against,
  // regardless of how recently the conversation ran.
  if (currentModel.supportsCaching === false) {
    return { state: "unsupported", idleSeconds: null, ttlSeconds: null };
  }

  const ttl = currentModel.cacheTtlSeconds;
  const ttlSeconds = Number.isFinite(ttl) && ttl! > 0 ? ttl! : null;

  const lastActivityAt = age?.lastActivityAt;
  const hasActivity = Number.isFinite(lastActivityAt) && lastActivityAt! > 0;
  if (!hasActivity || ttlSeconds === null) {
    return { state: "unknown", idleSeconds: null, ttlSeconds };
  }

  const now = age?.now ?? Date.now();
  // A negative age means the clock the timestamps came from disagrees with the
  // clock measuring now. Clamp to zero: the conversation cannot have run in the
  // future, and treating skew as a huge age would falsely report an expiry.
  const idleSeconds = Math.max(0, (now - lastActivityAt!) / 1000);
  return {
    state: idleSeconds > ttlSeconds ? "expired" : "warm",
    idleSeconds,
    ttlSeconds,
  };
}

/**
 * Estimate what the first turn after a model switch will cost.
 *
 * `contextTokens` is the conversation's current model-visible size, which the
 * engine already reports through `StatusFields.contextTokens`. A null or
 * non-positive value means there is nothing to re-send.
 *
 * `age` carries the conversation's last-activity time so the stay-put side can
 * be priced against a cache that is actually still alive. Omitting it yields a
 * "unknown" cache state and an explicitly unconfirmed comparison — never a
 * silent assumption that the cache is warm.
 *
 * Returns null when no switch cost applies at all — no history, or no target
 * model. A null result is the signal that the switch is free and needs no
 * warning, which is exactly the fresh-conversation case.
 */
export function estimateModelSwitchCost(
  contextTokens: number | null | undefined,
  targetModel: SwitchCostModel | null | undefined,
  currentModel?: SwitchCostModel | null,
  age?: CacheAgeInput,
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
      cacheState: "unknown",
      idleSeconds: null,
      cacheTtlSeconds: null,
      priced: false,
    };
  }

  const current = currentModel ?? targetModel;
  const { state, idleSeconds, ttlSeconds } = resolveCacheState(current, age);

  // The stay-put side is the cost of the NEXT turn on the current model, which
  // is the cache-read rate only while that cache survives. Once it has expired
  // — or when the model never cached — the next turn re-writes the prompt, so
  // the honest comparison uses the write rate on both sides.
  const stayRate =
    state === "warm" || state === "unknown"
      ? cacheReadRate(current)
      : state === "unsupported"
        ? (Number.isFinite(current.costPer1kInput) && current.costPer1kInput > 0
          ? current.costPer1kInput
          : null)
        : cacheCreationRate(current);

  const perThousand = contextTokens / 1000;
  return {
    tokens: contextTokens,
    costUsd: perThousand * (cacheCreationRate(targetModel) ?? 0),
    cachedCostUsd: stayRate === null ? null : perThousand * stayRate,
    cacheState: state,
    idleSeconds,
    cacheTtlSeconds: ttlSeconds,
    priced: true,
  };
}

/**
 * Format an estimate as short operator-facing text.
 *
 * Leads with the verdict, because that is the only thing the operator has to
 * decide. The cache state is not a caveat to pass along for them to interpret —
 * it is an input the estimator already resolved, so the text states which
 * option is cheaper and by how much, then gives the two figures behind it.
 *
 * "Staying is cheaper if the cache is still live" is a non-answer: it hands
 * back the question the estimator exists to settle. The only case that
 * legitimately hedges is `unknown`, and the fix for that is to supply the
 * missing input, not to soften the sentence.
 */
export function formatModelSwitchCost(
  estimate: ModelSwitchCostEstimate,
): string {
  const tokens = formatTokenCount(estimate.tokens);
  if (!estimate.priced) {
    return `${tokens} tokens will be re-sent to the new model. This model publishes no price, so the cost is unknown.`;
  }
  const switchCost = formatUsd(estimate.costUsd);
  if (estimate.cachedCostUsd === null) {
    return `Switching re-sends ${tokens} tokens and costs about ${switchCost}.`;
  }
  const stayCost = formatUsd(estimate.cachedCostUsd);
  const costs = `Switching costs about ${switchCost}; staying costs about ${stayCost}.`;

  if (estimate.cacheState === "unknown") {
    // The one honest hedge: an input was missing, so no verdict is available.
    return `Switching re-sends ${tokens} tokens and costs about ${switchCost}. Staying costs about ${stayCost} if this conversation's prompt cache is still live, and more if it has expired — its age could not be determined.`;
  }

  const delta = estimate.cachedCostUsd - estimate.costUsd;
  const saving = formatUsd(Math.abs(delta));

  switch (estimate.cacheState) {
    case "warm":
      // The cache is alive, so staying really does buy the cheap read rate.
      return `Staying on the current model is cheaper — its prompt cache is still live (idle ${formatDuration(estimate.idleSeconds)}), so its next turn reads ${tokens} cached tokens instead of re-sending them. ${costs} Staying saves about ${saving}.`;
    case "expired":
      // The saving the operator thinks they are protecting is already gone:
      // both options re-write the whole prompt, so this is a straight
      // price-per-token comparison between the two models.
      if (delta > 0) {
        return `Switching is cheaper. This conversation has been idle ${formatDuration(estimate.idleSeconds)}, so its prompt cache has already expired and all ${tokens} tokens are re-sent either way — the only difference is each model's rate. ${costs} Switching saves about ${saving}.`;
      }
      return `Staying on the current model is cheaper, but not because of its cache — that expired ${formatDuration(estimate.idleSeconds)} into idle, so all ${tokens} tokens are re-sent either way. The difference is each model's rate. ${costs} Staying saves about ${saving}.`;
    case "unsupported":
      // No cache is ever written, so again a straight rate comparison.
      if (delta > 0) {
        return `Switching is cheaper. The current model does not cache prompts, so all ${tokens} tokens are re-sent on every turn either way. ${costs} Switching saves about ${saving}.`;
      }
      return `Staying on the current model is cheaper. It does not cache prompts, so all ${tokens} tokens are re-sent either way and the difference is each model's rate. ${costs} Staying saves about ${saving}.`;
  }
}

/**
 * The reason line shown under the cost, or null when there is no honest reason
 * to give.
 *
 * The per-model-cache explanation only means something while a cache exists to
 * lose. Once it has expired — or when the model never cached — repeating "the
 * new model cannot read the cache this conversation already built" describes a
 * cache that is not there, and implies a saving the operator would be
 * protecting by staying put when there is none.
 */
export function formatModelSwitchReason(
  estimate: ModelSwitchCostEstimate,
): string | null {
  if (!estimate.priced) return null;
  switch (estimate.cacheState) {
    case "warm":
    case "unknown":
      return "A prompt cache belongs to one model, so the new model cannot read the cache this conversation already built.";
    case "expired":
    case "unsupported":
      return null;
  }
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
 * Idle time in the coarsest unit that stays truthful, for a sentence the
 * operator reads at a glance. Null renders as "a while" rather than a fake
 * number.
 */
export function formatDuration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return "a while";
  if (seconds < 90) return `${Math.round(seconds)}s`;
  const minutes = seconds / 60;
  if (minutes < 90) return `${Math.round(minutes)}m`;
  const hours = minutes / 60;
  if (hours < 36) return `${Math.round(hours)}h`;
  return `${Math.round(hours / 24)}d`;
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
