// Recipe: Ion Explore Cookbook (uid ion-explore-cookbook).
//
// Ready-to-run LogQL recipes for ad-hoc investigation in Explore. Every panel is
// a raw logs stream scoped by a dashboard variable. Migrated
// semantically-identical.

import type { Dashboard } from '../dashboard.ts';
import { row, logs, stat } from '../panels.ts';
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

export function cookbookDashboard(): Dashboard {
  const panels = [
    row(2, 'Per-Conversation Recipes', 0),
    cookbookLogs(
      3,
      'All logs for a conversation',
      "Every log line across all components (engine, extensions, desktop, iOS) that carries this conversation_id. Set the 'Conversation ID' variable above. This is the primary first-look query for any reported bug.",
      1,
      '{service_name=~".+", event_name=""} | json | conversation_id = "$conversation_id"',
      true,
    ),
    cookbookLogs(
      4,
      'Telemetry events for a conversation',
      'Only telemetry events (run.complete, llm.call, dispatch.agent, cache.savings) for the given conversation_id. Use this to audit cost and timing for a single conversation without log noise.',
      9,
      '{event_name=~".+"} | json | context_conversation_id = "$conversation_id"',
    ),
    row(5, 'Per-Session Recipes', 17),
    cookbookLogs(
      6,
      'All telemetry for a session',
      'All telemetry events (run.complete, llm.call, dispatch.agent, cache.savings) for the given session_id (the engine session key / tab UUID). Useful for session-level cost forensics when you know the tab/session but not the conversation ID.',
      18,
      '{event_name=~".+"} | json | context_session_id = "$session_id"',
    ),
    row(7, 'Extension Attribution Recipes', 26),
    cookbookLogs(
      8,
      'All runs attributed to an extension',
      "All run.complete events where context_extension matches the Extension Name variable. Useful for reviewing all runs (cost, model, turns) driven by a specific extension. Old runs without context_extension are excluded — they appear as 'unattributed' in the Extensions dashboard.",
      27,
      '{event_name="run.complete"} | json | context_extension =~ "$extension"',
    ),
    cookbookLogs(
      9,
      'Agent dispatches attributed to an extension',
      'All dispatch.agent spans where context_extension matches. Shows which sub-agents the extension dispatched, at what depth, and with what model. Useful for understanding sub-agent cost within an extension.',
      35,
      '{event_name="dispatch.agent"} | json | payload_extension =~ "$extension"',
    ),
    row(10, 'Trace Correlation Recipes', 43),
    cookbookLogs(
      11,
      'LLM calls with trace IDs',
      "All llm.call telemetry events that carry a trace_id. Click the 'View trace' correlation link on any result row (via the provisioned Loki→Tempo correlation) to jump directly to the Tempo trace for that call.",
      44,
      '{event_name="llm.call"} | json | trace_id != ""',
    ),
    row(12, 'Error and Quality Recipes', 52),
    cookbookLogs(
      13,
      'Engine errors',
      'All ERROR-level log lines from the engine. Start here for bug triage — every engine error path logs at ERROR level with structured fields. Filter further by conversation_id or session_id after identifying the relevant event.',
      53,
      '{service_name="ion-engine", event_name=""} | json | level = "ERROR"',
    ),
    cookbookLogs(
      14,
      'Extension errors',
      'All ERROR-level log lines from extensions (service_name=ion-extension). Cross-reference with the extension name via the \'tag\' field (e.g. tag=ion-dev). Useful for debugging extension panics and unhandled hook rejections.',
      61,
      '{service_name="ion-extension", event_name=""} | json | level = "ERROR"',
    ),
    row(15, 'Ingest Diagnostics Recipes', 69),
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
      gridPos: { x: 0, y: 70, w: 24, h: 6 },
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
      targets: [{ e: ingestFreshnessMinutes('24h'), legend: '{{service_name}}' }],
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
