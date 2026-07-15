// Canonical cost & extension-attribution expressions.
//
// These are the reconciliation-critical, genuinely-repeated expressions seeded
// from the audited ion-cost / ion-extensions panels (commit 013be86d). They are
// defined exactly once here and registered for queries.md. The extension-spend
// builder is parameterised by grouping and window so the ranked bar, the pie,
// the model-mix, and the version breakdown all share one definition — the
// three-way reconciliation (bar total == pie total == headline) holds by
// construction because there is one expression, not three hand-copied ones.

import type { Expr, Window } from './types.ts';
import {
  accumulation,
  instant,
  registerQuery,
  telemetry,
  coalesceUnattributed,
  versionSuffix,
} from './queries.ts';

const RUN = telemetry('run.complete');

// Extension spend, summed and grouped. `by` is the grouping label set; when
// `coalesce` is true the empty-extension bucket is relabelled "unattributed".
// On an instant target pass $__range (the picker's window); on a range target
// pass $__interval — the class is `accumulation`, so the panel builder
// enforces it.
export function extensionSpend(opts: {
  by: readonly string[];
  window: Window;
  filterExtension?: boolean;
  filterVersion?: boolean;
  coalesce?: boolean;
}): Expr {
  const filters: string[] = [];
  if (opts.filterExtension) filters.push(' | context_extension =~ "$extension"');
  if (opts.filterVersion) filters.push(' | context_extension_version =~ "$version"');
  const grouping = opts.by.join(', ');
  const inner =
    `sum by (${grouping}) (sum_over_time(${RUN} | json` +
    `${filters.join('')} | unwrap run_cost_usd [${opts.window}]))`;
  const expr = opts.coalesce ? coalesceUnattributed(inner) : inner;
  return accumulation(expr, opts.window);
}

// The ranked-bar / pie spend expression: grouped by extension, coalesced,
// instant over the dashboard range. Bar and pie share this exactly.
export const spendByExtension = (): Expr =>
  registerQuery(
    'Spend by extension (ranked/pie)',
    'Total run.complete cost per extension over the dashboard time range, evaluated ' +
      'instant. Empty-extension runs coalesce to the "unattributed" bucket. The ranked ' +
      'bargauge and the pie share this one expression, so their totals reconcile to the ' +
      'headline spend by construction.',
    extensionSpend({ by: ['context_extension'], window: '$__range', filterExtension: true, coalesce: true }),
  );

// Per-extension model mix (spend), instant over the dashboard range.
export const spendByExtensionModel = (): Expr =>
  registerQuery(
    'Per-extension model mix (spend)',
    'Cost grouped by extension AND model over the dashboard time range, instant. Shows ' +
      'which models each extension drives and how much each costs within that extension.',
    extensionSpend({
      by: ['context_extension', 'model'],
      window: '$__range',
      filterExtension: true,
      coalesce: true,
    }),
  );

// Cost over time by extension+version, per-interval, with the conditional
// version-suffix legend. This is the panel that carried the original overcount
// bug ([30m] fixed window); here it is class `accumulation` on $__interval, so a
// fixed window is a compile/runtime error, not a silent defect.
export const spendOverTimeByExtensionVersion = (): Expr =>
  registerQuery(
    'Cost over time by extension (version legend, per interval)',
    'Run cost summed per $__interval, grouped by extension and version, with the empty ' +
      'extension coalesced to "unattributed" and a conditional " v<version>" suffix. Because ' +
      'the window is $__interval the area integrates to the same range total as the ranked bar.',
    accumulation(
      versionSuffix(
        coalesceUnattributed(
          `sum by (context_extension, context_extension_version) (sum_over_time(${RUN} | json` +
            ` | context_extension =~ "$extension" | context_extension_version =~ "$version"` +
            ` | unwrap run_cost_usd [$__interval]))`,
        ),
      ),
      '$__interval',
    ),
  );

// Cost per version, instant over the dashboard range (bargauge, version comparison).
export const spendByVersion = (): Expr =>
  registerQuery(
    'Cost per version',
    'Total run.complete cost grouped by extension and version over the dashboard time ' +
      'range, instant. Compare spend before and after a version bump.',
    accumulation(
      `sum by (context_extension, context_extension_version) (sum_over_time(${RUN} | json` +
        ` | context_extension =~ "$extension" | context_extension_version =~ "$version"` +
        ` | unwrap run_cost_usd [$__range]))`,
      '$__range',
    ),
  );

// Runs per version, instant over the dashboard range (stat).
export const runsByVersion = (): Expr =>
  accumulation(
    `sum by (context_extension, context_extension_version) (count_over_time(${RUN} | json` +
      ` | context_extension =~ "$extension" | context_extension_version =~ "$version" [$__range]))`,
    '$__range',
  );

// Agent dispatches attributed to an extension, instant over the dashboard range (table).
// dispatch.agent is a telemetry SPAN, so its attributes (agent, extension,
// extension_version) are promoted by Alloy under the `payload_` prefix — unlike
// run.complete, whose context block lands under `context_`. Grouping/filtering
// on `context_extension` / `agent` here silently matched nothing; the correct
// span-attribute fields are `payload_extension` / `payload_extension_version` /
// `payload_agent`.
export const dispatchesByExtension = (): Expr =>
  accumulation(
    `sum by (payload_extension, payload_extension_version, payload_agent) (count_over_time(` +
      `${telemetry('dispatch.agent')} | json | payload_extension =~ "$extension" [$__range]))`,
    '$__range',
  );

// Token usage over time by extension, per interval (input/output).
export const tokensOverTimeByExtension = (field: 'input_tokens' | 'output_tokens'): Expr =>
  accumulation(
    `sum by (context_extension) (sum_over_time(${RUN} | json` +
      ` | context_extension =~ "$extension" | unwrap ${field} [$__interval]))`,
    '$__interval',
  );

// ---------------------------------------------------------------------------
// Cost-pack headline expressions (bare run_cost_usd and payload_ variants)
// ---------------------------------------------------------------------------

// NOTE: the cost pack's headline uses the bare `run_cost_usd` field; the
// overview pack uses `payload_run_cost_usd`. These are preserved as distinct
// builders (not unified) so each pack stays semantically identical to its
// audited original.

export const totalSpendBare = (): Expr =>
  registerQuery(
    'Total spend (bare run_cost_usd)',
    'Sum of run_cost_usd across all run.complete events in the dashboard time range, ' +
      'instant. The cost pack headline and the extension coalesced sum reconcile to this value.',
    accumulation(`sum(sum_over_time(${RUN} | json | unwrap run_cost_usd [$__range]))`, '$__range'),
  );

export const totalSpendPayload = (): Expr =>
  registerQuery(
    'Total spend (payload_run_cost_usd)',
    'Sum of payload_run_cost_usd across all run.complete events in the dashboard time ' +
      'range, instant. Used by the overview verdict tile and the model pie.',
    accumulation(`sum(sum_over_time(${RUN} | json | unwrap payload_run_cost_usd [$__range]))`, '$__range'),
  );

export const runCount = (): Expr =>
  accumulation(`sum(count_over_time(${RUN}[$__range]))`, '$__range');

// Instant snapshot pie: cost by model over the dashboard range.
export const costByModel = (): Expr =>
  instant(`sum by (payload_model) (sum_over_time(${RUN} | json | unwrap payload_run_cost_usd [$__range]))`, '$__range');
