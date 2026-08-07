import { rInfo, rWarn } from '../rendererLogger'
import { CONFLICT_ASSIST_TIER, WORKBENCH_SYNC_TIER } from '../../shared/types-model-tiers'

export interface WorkbenchTierContext {
  workflow: string
  directory?: string
  repoPath?: string
  sourceBranch?: string
}

export type WorkbenchTierResult =
  | { ok: true; tier: string; model: string }
  | { ok: false; error: string }

/** Resolve client workbench policy without adding model opinions to engine. */
export async function resolveWorkbenchTier(context: WorkbenchTierContext): Promise<WorkbenchTierResult> {
  const preferred = await window.ion.resolveModelTier(WORKBENCH_SYNC_TIER)
  if (preferred.configured) {
    rInfo('workbench.tier', 'workbench model tier resolved', {
      ...context,
      tier: WORKBENCH_SYNC_TIER,
      model: preferred.model,
    })
    return { ok: true, tier: WORKBENCH_SYNC_TIER, model: preferred.model }
  }

  rWarn('workbench.tier', 'workbench model tier not configured; falling back to standard', {
    ...context,
    missing_tier: WORKBENCH_SYNC_TIER,
    fallback_tier: CONFLICT_ASSIST_TIER,
  })
  const fallback = await window.ion.resolveModelTier(CONFLICT_ASSIST_TIER)
  if (fallback.configured) {
    rInfo('workbench.tier', 'workbench fallback model tier resolved', {
      ...context,
      tier: CONFLICT_ASSIST_TIER,
      model: fallback.model,
    })
    return { ok: true, tier: CONFLICT_ASSIST_TIER, model: fallback.model }
  }

  const error = `AI-assisted workflows need either the "${WORKBENCH_SYNC_TIER}" or "${CONFLICT_ASSIST_TIER}" model tier. Configure one in Settings → AI & Models → Model Tiers.`
  rWarn('workbench.tier', 'workbench model tier resolution refused', {
    ...context,
    missing_tiers: `${WORKBENCH_SYNC_TIER},${CONFLICT_ASSIST_TIER}`,
  })
  return { ok: false, error }
}
