/**
 * Role-based character casting. Pure and deterministic: the same agent name,
 * seed, and pool always cast the same character, independent of roster order
 * or pool iteration order. Tint application happens at draw time; casting
 * only assigns the character id and accent color.
 */
import type { AtvRole } from '../../../shared/types-atv'
import { createRng, deriveSeed } from '../generation/prng'

export interface CastableCharacter {
  id: string
  roles: AtvRole[]
  tintable: boolean
}

export interface CastResult {
  characterId: string
  /** Accent tint (department color) to apply to the tint layer; null = untinted. */
  tint: string | null
}

/**
 * Cast one agent. Eligible pool = characters declaring the role, sorted by id
 * for order independence. Seeded stable choice keyed by agent name + seed —
 * regenerations and roster permutations never re-cast an existing agent.
 * When the pool is smaller than the roster, casting naturally wraps (several
 * agents share a sheet) and the accent tint differentiates them.
 */
export function castCharacter(
  pool: readonly CastableCharacter[],
  role: AtvRole,
  agentName: string,
  seed: string,
  accentColor: string | null,
): CastResult | null {
  const eligible = pool
    .filter((c) => c.roles.includes(role))
    .sort((a, b) => a.id.localeCompare(b.id))
  if (eligible.length === 0) return null
  const rng = createRng(deriveSeed(seed, `cast:${role}:${agentName}`))
  const chosen = eligible[rng.nextInt(eligible.length)]
  return {
    characterId: chosen.id,
    tint: chosen.tintable ? accentColor : null,
  }
}
