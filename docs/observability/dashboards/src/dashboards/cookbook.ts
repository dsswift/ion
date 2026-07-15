// Recipe: Ion Explore Cookbook (uid ion-explore-cookbook).
//
// Ready-to-run LogQL recipes for ad-hoc investigation in Explore. Every panel is
// a raw logs stream scoped by a dashboard variable. Migrated
// semantically-identical.

import type { Dashboard } from '../dashboard.ts';
import { text, row, logs, stat } from '../panels.ts';
import { stream } from '../queries.ts';
import { ingestFreshnessMinutes } from '../queries-logs.ts';

const cookbookLogs = (id: number, title: string, description: string, y: number, expr: string, sortAsc = false) =>
  logs({
    id,
    title,
    description,
    gridPos: { x: 0, y, w: 24, h: 8 },
    options: { showTime: true, wrapLogMessage: true, ...(sortAsc ? { sortOrder: 'Ascending' } : {}) },
    target: { e: stream(expr) },
  });

const INTRO =
  '## Ion Explore Cookbook\n\nThis dashboard contains ready-to-run LogQL recipes for ad-hoc investigation. **Use it as a launching pad into Explore**, not as a live monitoring dashboard.\n\n### How to use a recipe\n1. Set the dashboard variables above (Conversation ID, Session ID, Extension Name) to scope the queries.\n2. Click the **three-dot menu** (⋮) on any panel and select **Explore** to open that query in Grafana Explore.\n3. In Explore you can adjust the time range, modify the query, and use **split-view** to correlate logs with traces.\n\n### Key fields (structured metadata promoted by Alloy)\n| Field | Description |\n|---|---|\n| `context_conversation_id` | Durable conversation-file ID — join key across all event types |\n| `context_session_id` | Engine session key (tab UUID for desktop clients) |\n| `context_extension` | Hosting extension name (omit-when-absent for non-extension runs) |\n| `context_extension_version` | Extension manifest version (omit-when-absent) |\n| `trace_id` | 32-hex trace ID — click the Tempo correlation link to jump to the trace |\n| `model` | LLM model name (on llm.call, run.complete) |\n| `run_cost_usd` | Per-run cost in USD (on run.complete) |\n\n### Provisioned correlations\nThe Loki datasource has three provisioned correlations: **conversation_id → all logs**, **session_id → telemetry**, **trace_id → Tempo trace**. In any Explore result, click the link button on a log line\'s field value to follow the correlation.\n';

export function cookbookDashboard(): Dashboard {
  const panels = [
    text(1, { x: 0, y: 0, w: 24, h: 4 }, INTRO, 'How to Use This Cookbook'),
    row(2, 'Per-Conversation Recipes', 4),
    cookbookLogs(
      3,
      'All logs for a conversation',
      "Every log line across all components (engine, extensions, desktop, iOS) that carries this conversation_id. Set the 'Conversation ID' variable above. This is the primary first-look query for any reported bug.",
      5,
      '{component=~".+"} | json | context_conversation_id = "$conversation_id"',
      true,
    ),
    cookbookLogs(
      4,
      'Telemetry events for a conversation',
      'Only telemetry events (run.complete, llm.call, dispatch.agent, cache.savings) for the given conversation_id. Use this to audit cost and timing for a single conversation without log noise.',
      13,
      '{service_name="ion-telemetry"} | json | context_conversation_id = "$conversation_id"',
    ),
    row(5, 'Per-Session Recipes', 21),
    cookbookLogs(
      6,
      'All telemetry for a session',
      'All telemetry events (run.complete, llm.call, dispatch.agent, cache.savings) for the given session_id (the engine session key / tab UUID). Useful for session-level cost forensics when you know the tab/session but not the conversation ID.',
      22,
      '{service_name="ion-telemetry"} | json | context_session_id = "$session_id"',
    ),
    row(7, 'Extension Attribution Recipes', 30),
    cookbookLogs(
      8,
      'All runs attributed to an extension',
      "All run.complete events where context_extension matches the Extension Name variable. Useful for reviewing all runs (cost, model, turns) driven by a specific extension. Old runs without context_extension are excluded — they appear as 'unattributed' in the Extensions dashboard.",
      31,
      '{service_name="ion-telemetry", kind="run.complete"} | json | context_extension =~ "$extension"',
    ),
    cookbookLogs(
      9,
      'Agent dispatches attributed to an extension',
      'All dispatch.agent spans where context_extension matches. Shows which sub-agents the extension dispatched, at what depth, and with what model. Useful for understanding sub-agent cost within an extension.',
      39,
      '{service_name="ion-telemetry", kind="dispatch.agent"} | json | payload_extension =~ "$extension"',
    ),
    row(10, 'Trace Correlation Recipes', 47),
    cookbookLogs(
      11,
      'LLM calls with trace IDs',
      "All llm.call telemetry events that carry a trace_id. Click the 'View trace' correlation link on any result row (via the provisioned Loki→Tempo correlation) to jump directly to the Tempo trace for that call.",
      48,
      '{service_name="ion-telemetry", kind="llm.call"} | json | trace_id != ""',
    ),
    row(12, 'Error and Quality Recipes', 56),
    cookbookLogs(
      13,
      'Engine errors',
      'All ERROR-level log lines from the engine. Start here for bug triage — every engine error path logs at ERROR level with structured fields. Filter further by conversation_id or session_id after identifying the relevant event.',
      57,
      '{component="engine"} | json | level = "ERROR"',
    ),
    cookbookLogs(
      14,
      'Extension errors',
      'All ERROR-level log lines from extensions (component=extension). Cross-reference with the extension name via the \'tag\' field (e.g. tag=ion-dev). Useful for debugging extension panics and unhandled hook rejections.',
      65,
      '{component="extension"} | json | level = "ERROR"',
    ),
    row(15, 'Ingest Diagnostics Recipes', 73),
    stat({
      id: 16,
      title: 'Ingest freshness by component (min since last line)',
      description:
        'Minutes since the most recent log line per component — the tailer-wedge detector. When ' +
        "one component's tile climbs while the others stay near zero, that file's Alloy cursor is " +
        'wedged (frozen positions offset against a still-growing file — see README "Tailer wedge"). ' +
        'Diagnosis: compare the positions offset in the container against the host file size; fix ' +
        'with `docker compose -p ion-obs restart alloy`. The [24h] lookback keeps a long-wedged ' +
        'component visible as a growing red value instead of dropping it from a narrow window.',
      gridPos: { x: 0, y: 74, w: 24, h: 6 },
      fieldConfig: {
        defaults: {
          unit: 'm',
          decimals: 1,
          color: { mode: 'thresholds' },
          thresholds: {
            mode: 'absolute',
            steps: [
              { color: 'green', value: null },
              { color: 'orange', value: 5 },
              { color: 'red', value: 30 },
            ],
          },
          mappings: [],
        },
        overrides: [],
      },
      options: {
        reduceOptions: { calcs: ['lastNotNull'], fields: '', values: false },
        orientation: 'auto',
        textMode: 'auto',
        colorMode: 'background',
        graphMode: 'none',
      },
      targets: [{ e: ingestFreshnessMinutes('24h'), legend: '{{component}}' }],
    }),
  ];

  return {
    uid: 'ion-explore-cookbook',
    title: 'Ion Explore Cookbook',
    description:
      "Ready-to-use LogQL recipes for ad-hoc investigation in Explore. Each panel shows the query and its purpose. Open the panel's query in Explore to run it interactively.",
    tags: ['ion', 'explore', 'recipes'],
    schemaVersion: 36,
    version: 2,
    refresh: false,
    timeFrom: 'now-24h',
    folder: 'explore',
    file: 'ion-explore-cookbook',
    panels,
    templating: [
      { name: 'conversation_id', label: 'Conversation ID', type: 'textbox', description: 'Paste a conversation ID ({millis}-{hex12}) to filter panels to a single conversation.', current: { value: '' }, hide: 0 },
      { name: 'session_id', label: 'Session ID', type: 'textbox', description: 'Paste an engine session key (tab UUID or equivalent) to filter panels to a single session.', current: { value: '' }, hide: 0 },
      { name: 'extension', label: 'Extension Name', type: 'textbox', description: "Extension name (e.g. 'ion-dev') to scope extension-attribution panels.", current: { value: '.*' }, hide: 0 },
    ],
  };
}
