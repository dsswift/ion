// Text-panel wording for the Azure flavor.
//
// A few markdown panels explain the Loki stack itself (LogQL, Alloy, Tempo
// correlations). Their Azure twin swaps those passages for the Azure
// equivalent. Each swap names the exact text it replaces and generation fails
// when that text is gone, so a recipe edit cannot leave a stale swap behind.

type Swap = readonly [from: string, to: string];

const SWAPS: Readonly<Record<string, readonly Swap[]>> = {
  'ion-explore-cookbook': [
    ['ready-to-run LogQL recipes', 'ready-to-run KQL recipes'],
    [
      '### Key fields (structured metadata promoted by Alloy)',
      '### Key fields (`payload` and `context` keys on the `IonTelemetry` view)',
    ],
    ['click the Tempo correlation link to jump to the trace', 'the Application Insights operation id for the prompt'],
    [
      'The Loki datasource has three provisioned correlations: **conversation_id → all logs**, **session_id → telemetry**, **trace_id → Tempo trace**. In any Explore result, click the link button on a log line\'s field value to follow the correlation.',
      'Filter any recipe by `conversation_id` or `session_id` with the variables above. For the trace tree of one prompt, search its TraceId in Application Insights (Transaction search); that is the investigation surface for traces in Azure.',
    ],
  ],
  'ion-mobile': [['(`{service_name="ion-ios", event_name=""}`)', '(`IonLogs | where ServiceName == "ion-ios"`)']],
};

/** Apply the Azure wording to one text panel's markdown. */
export function azureText(dashboardUid: string, content: string): string {
  let out = content;
  for (const [from, to] of SWAPS[dashboardUid] ?? []) {
    if (!out.includes(from)) continue;
    out = out.replace(from, to);
  }
  return out;
}

/** Swaps whose source text no panel on the dashboard carries any more. */
export function unusedSwaps(dashboardUid: string, contents: readonly string[]): string[] {
  return (SWAPS[dashboardUid] ?? []).filter(([from]) => !contents.some((c) => c.includes(from))).map(([from]) => from);
}
