/**
 * Structural equality for store read-model caches.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * A refresh action that writes `new Map(...)` unconditionally notifies every
 * subscriber even when the fetched payload is byte-identical to the cached one.
 * That is harmless when the refresh is user-triggered and catastrophic when a
 * component effect triggers the refresh: the write re-renders the component,
 * the re-render re-runs the effect, and the loop never converges because the
 * store "changed" on every pass. `refreshWorktreeInventory` and `refreshBench`
 * both did exactly that, and the Studio Inbox drove them at ~800 passes/sec.
 *
 * Comparing before writing is what makes those actions safe to call from a
 * render-driven effect: a refresh that finds nothing new is a no-op, so the
 * cycle terminates on its first quiescent pass.
 *
 * Deliberately NOT `JSON.stringify` equality: stringify compares key ORDER as
 * well as content, so two structurally identical objects built by different
 * code paths (an IPC decode vs. a locally-constructed fallback) would compare
 * unequal and reintroduce the write. It also throws on cycles and silently
 * elides `undefined` values, both of which would turn a cheap guard into a
 * source of its own bugs.
 *
 * Scope: plain JSON-shaped values — the shape every IPC read model has. Maps,
 * Sets, Dates, and class instances are compared by reference, which is correct
 * for this use (an IPC payload never contains them) and honest about the limit.
 */

export function deepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (
    typeof left !== "object" ||
    typeof right !== "object" ||
    left === null ||
    right === null
  ) {
    return false;
  }

  const leftIsArray = Array.isArray(left);
  if (leftIsArray !== Array.isArray(right)) return false;

  if (leftIsArray) {
    const a = left as unknown[];
    const b = right as unknown[];
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }

  // Anything that is not a plain object (Map, Set, Date, class instance) is
  // compared by reference above; treating it structurally here would report
  // two distinct Maps with the same entries as equal, which is a lie for a
  // cache guard.
  if (!isPlainObject(left) || !isPlainObject(right)) return false;

  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  for (const key of leftKeys) {
    if (!Object.prototype.hasOwnProperty.call(right, key)) return false;
    if (
      !deepEqual(
        (left as Record<string, unknown>)[key],
        (right as Record<string, unknown>)[key],
      )
    ) {
      return false;
    }
  }
  return true;
}

function isPlainObject(value: object): value is Record<string, unknown> {
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}
