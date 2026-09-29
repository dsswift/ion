// Recipe: Ion Control Room (uid ion-control-room).
//
// Activity lamps: instant counts over the last 5 minutes across all surfaces.
// Every lamp is an instant accumulation over [5m]. Migrated
// semantically-identical. The many near-identical stat lamps are built from a
// shared lamp() helper — the hand-written JSON repeated the full stat config 14
// times; here the config is defined once.

import type { Dashboard } from '../dashboard.ts';
import { text, stat, logsTable } from '../panels.ts';
import { instant, stream } from '../queries.ts';
import { componentLamp, extensionLamps, toolLamps, kindCount } from '../queries-logs.ts';
import type { Expr } from '../types.ts';

// The green-lamp threshold set (idle dim -> green when active).
const GREEN = { mode: 'absolute', steps: [{ color: '#1f2430', value: null }, { color: 'green', value: 1 }] };
// The ERR override: some lamps carry a red override on an "ERR" series.
const ERR_OVERRIDE = [
  {
    matcher: { id: 'byName', options: 'ERR' },
    properties: [
      { id: 'thresholds', value: { mode: 'absolute', steps: [{ color: 'transparent', value: null }, { color: 'red', value: 1 }] } },
      { id: 'color', value: { mode: 'thresholds' } },
    ],
  },
];
const lampOptions = {
  reduceOptions: { calcs: ['lastNotNull'], fields: '', values: false },
  orientation: 'auto',
  textMode: 'auto',
  colorMode: 'background',
  graphMode: 'none',
  justifyMode: 'center',
};

// A lamp stat panel. One series lights one lamp; a grouped query lights one
// lamp per series, each labelled by `legend`. `err` adds the red ERR override (used by surfaces that emit
// error series). All lamps use instant=true on the target.
function lamp(
  id: number,
  title: string,
  gp: { h: number; w: number; x: number; y: number },
  e: Expr,
  err = false,
  group?: { legend: string; noValue: string },
) {
  return stat({
    id,
    title,
    gridPos: gp,
    fieldConfig: {
      defaults: { color: { mode: 'thresholds' }, thresholds: GREEN, mappings: [], unit: 'short', noValue: group?.noValue ?? '0' },
      overrides: err ? ERR_OVERRIDE : [],
    },
    options: group ? { ...lampOptions, textMode: 'value_and_name' } : lampOptions,
    targets: [{ e, legend: group?.legend ?? '' }],
  });
}

const INTRO =
  'Control room: lamps show activity in the last 5 minutes. Green = active, red = errors, dim grey = idle. Layout hand-maintained; 5s refresh.';

export function controlRoomDashboard(): Dashboard {
  const panels = [
    text(1, { h: 2, w: 24, x: 0, y: 0 }, INTRO),
    // Surface lamps, two rows.
    //
    // One row of nine does not fit: 24 columns across nine titles leaves every
    // lamp too narrow to read its own name, and a lamp elided to "w..." tells
    // an operator nothing. Adding `server` and `web` is what pushed it over,
    // so the surfaces take the first row and the extension lamps the second,
    // each wide enough for its label.
    lamp(2, 'desktop', { h: 4, w: 4, x: 0, y: 2 }, componentLamp('desktop', '5m'), true),
    // The server and the browser clients it logs for: their own components
    // since the split, and lampless until now.
    lamp(19, 'server', { h: 4, w: 4, x: 4, y: 2 }, componentLamp('server', '5m'), true),
    lamp(20, 'web', { h: 4, w: 4, x: 8, y: 2 }, componentLamp('web', '5m')),
    lamp(3, 'ios', { h: 4, w: 4, x: 12, y: 2 }, componentLamp('ios', '5m')),
    lamp(4, 'relay', { h: 4, w: 4, x: 16, y: 2 }, componentLamp('relay', '5m')),
    lamp(5, 'engine', { h: 4, w: 4, x: 20, y: 2 }, componentLamp('engine', '5m'), true),
    // Extension lamps (row y=6): one per extension that logged in the window.
    // The names come from the data, never from a fixed list, so every install
    // sees its own extensions.
    lamp(6, 'Extensions active (5m)', { h: 4, w: 24, x: 0, y: 6 }, extensionLamps('5m'), false, { legend: '{{tag}}', noValue: 'no extension activity' }),
    // Tool lamps (row y=10): the busiest tools in the window, whatever they
    // are (built-in, MCP, or extension).
    lamp(9, 'Busiest tools (5m)', { h: 4, w: 19, x: 0, y: 10 }, toolLamps(8, '5m'), false, { legend: '{{tool}}', noValue: 'no tool calls' }),
    lamp(15, 'LLM calls', { h: 4, w: 5, x: 19, y: 10 }, kindCount('llm.call', '5m')),
    // Live tail + events/min (row y=14)
    logsTable({
      id: 16,
      title: 'Live log tail',
      gridPos: { h: 8, w: 18, x: 0, y: 14 },
      target: { e: stream('{service_name=~".+", event_name=""} | json') },
    }),
    stat({
      id: 17,
      title: 'events/min all surfaces',
      gridPos: { h: 8, w: 6, x: 18, y: 14 },
      fieldConfig: { defaults: { color: { mode: 'fixed', fixedColor: 'blue' }, thresholds: { mode: 'absolute', steps: [] }, mappings: [], unit: 'short' }, overrides: [] },
      options: { ...lampOptions, colorMode: 'value' },
      targets: [{ e: instant('sum(count_over_time({service_name=~".+", event_name=""}[1m]))', '1m'), legend: '' }],
    }),
  ];

  return {
    uid: 'ion-control-room',
    title: 'Ion Control Room',
    description: 'Ion Control Room -- lamps show activity in the last 5 minutes across all surfaces.',
    tags: ['ion', 'live'],
    schemaVersion: 39,
    version: 1,
    refresh: '5s',
    timeFrom: 'now-5m',
    folder: 'live',
    file: 'ion-control-room',
    panels,
  };
}
