// Recipe: Ion Control Room (uid ion-control-room).
//
// Activity lamps: instant counts over the last 5 minutes across all surfaces.
// Every lamp is an instant accumulation over [5m]. Migrated
// semantically-identical. The many near-identical stat lamps are built from a
// shared lamp() helper — the hand-written JSON repeated the full stat config 14
// times; here the config is defined once.

import type { Dashboard } from '../dashboard.ts';
import { text, stat, logs } from '../panels.ts';
import { instant, stream } from '../queries.ts';
import { componentLamp, toolLamp, kindCount } from '../queries-logs.ts';
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

// A lamp stat panel. `err` adds the red ERR override (used by surfaces that emit
// error series). All lamps use instant=true on the target.
function lamp(id: number, title: string, gp: { h: number; w: number; x: number; y: number }, e: Expr, err = false) {
  return stat({
    id,
    title,
    gridPos: gp,
    fieldConfig: {
      defaults: { color: { mode: 'thresholds' }, thresholds: GREEN, mappings: [], unit: 'short', noValue: '0' },
      overrides: err ? ERR_OVERRIDE : [],
    },
    options: lampOptions,
    targets: [{ e, legend: '' }],
  });
}

const INTRO =
  'Control room: lamps show activity in the last 5 minutes. Green = active, red = errors, dim grey = idle. Layout hand-maintained; 5s refresh.';

export function controlRoomDashboard(): Dashboard {
  const panels = [
    text(1, { h: 2, w: 24, x: 0, y: 0 }, INTRO),
    // Surface lamps (row y=2)
    lamp(2, 'desktop', { h: 4, w: 3, x: 0, y: 2 }, componentLamp('desktop', '5m'), true),
    lamp(3, 'ios', { h: 4, w: 3, x: 3, y: 2 }, componentLamp('ios', '5m')),
    lamp(4, 'relay', { h: 4, w: 4, x: 6, y: 2 }, componentLamp('relay', '5m')),
    lamp(5, 'engine', { h: 4, w: 4, x: 10, y: 2 }, componentLamp('engine', '5m'), true),
    lamp(6, 'ion-dev', { h: 4, w: 3, x: 14, y: 2 }, componentLamp('extension', '5m', 'ion-dev'), true),
    lamp(7, 'ion-meta', { h: 4, w: 4, x: 17, y: 2 }, componentLamp('extension', '5m', 'ion-meta'), true),
    lamp(8, 'chief-of-staff', { h: 4, w: 3, x: 21, y: 2 }, componentLamp('extension', '5m', 'chief-of-staff'), true),
    // Tool lamps (row y=6)
    lamp(9, 'Bash', { h: 4, w: 3, x: 0, y: 6 }, toolLamp('Bash', '5m')),
    lamp(10, 'Read', { h: 4, w: 3, x: 3, y: 6 }, toolLamp('Read', '5m')),
    lamp(11, 'Write', { h: 4, w: 3, x: 6, y: 6 }, toolLamp('Write', '5m')),
    lamp(12, 'Edit', { h: 4, w: 3, x: 9, y: 6 }, toolLamp('Edit', '5m')),
    lamp(13, 'Grep', { h: 4, w: 3, x: 12, y: 6 }, toolLamp('Grep', '5m')),
    lamp(14, 'WebFetch', { h: 4, w: 4, x: 15, y: 6 }, toolLamp('WebFetch', '5m')),
    lamp(15, 'LLM calls', { h: 4, w: 5, x: 19, y: 6 }, kindCount('llm.call', '5m')),
    // Live tail + events/min (row y=10)
    logs({
      id: 16,
      title: 'Live log tail',
      gridPos: { h: 8, w: 18, x: 0, y: 10 },
      options: { dedupStrategy: 'none', enableLogDetails: true, prettifyLogMessage: false, showCommonLabels: false, showLabels: false, showTime: true, sortOrder: 'Descending', wrapLogMessage: true },
      target: { e: stream('{component=~".+"}') },
    }),
    stat({
      id: 17,
      title: 'events/min all surfaces',
      gridPos: { h: 8, w: 6, x: 18, y: 10 },
      fieldConfig: { defaults: { color: { mode: 'fixed', fixedColor: 'blue' }, thresholds: { mode: 'absolute', steps: [] }, mappings: [], unit: 'short' }, overrides: [] },
      options: { ...lampOptions, colorMode: 'value' },
      targets: [{ e: instant('sum(count_over_time({component=~".+"}[1m]))', '1m'), legend: '' }],
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
