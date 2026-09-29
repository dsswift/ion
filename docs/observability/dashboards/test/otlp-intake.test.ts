// A log shipper pointed at the local stack (logging.egressOtel.endpoint =
// http://localhost:4318) posts each batch's logs before its spans, and sends
// the spans only once the logs are accepted. 4318 used to be published by
// Tempo, which has no logs route: every batch stopped at the logs and no span
// ever arrived. The port belongs to Alloy, whose OTLP receiver must take logs
// as well as traces.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const OBSERVABILITY = join(HERE, '..', '..');
const REPO = join(OBSERVABILITY, '..', '..');

/** The text of one service block: from `  <name>:` to the next line at that indent. */
function serviceBlock(yaml: string, name: string, indent: string): string {
  const lines = yaml.split('\n');
  const start = lines.findIndex((l) => l === `${indent}${name}:`);
  assert.ok(start >= 0, `no service "${name}"`);
  const rest = lines.slice(start + 1);
  const next = rest.findIndex((l) => l.startsWith(indent) && !l.startsWith(`${indent} `) && /^\s*[a-z-]+:\s*$/.test(l));
  return (next < 0 ? rest : rest.slice(0, next)).join('\n');
}

const publishes = (block: string, port: number): boolean =>
  block.split('\n').some((l) => /^\s*-\s*"/.test(l) && l.includes(`"${port}:${port}"`));

for (const [file, indent] of [
  [join(OBSERVABILITY, 'docker-compose.yml'), '  '],
  [join(REPO, 'dev.yaml'), '  '],
] as const) {
  test(`${file.split('/').pop()}: Alloy, not Tempo, publishes OTLP 4317/4318`, () => {
    const yaml = readFileSync(file, 'utf8');
    const alloy = serviceBlock(yaml, 'alloy', indent);
    const tempo = serviceBlock(yaml, 'tempo', indent);
    for (const port of [4317, 4318]) {
      assert.ok(publishes(alloy, port), `alloy does not publish ${port}`);
      assert.ok(!publishes(tempo, port), `tempo publishes ${port}`);
    }
  });
}

test("Alloy's OTLP receiver accepts logs as well as traces", () => {
  const config = readFileSync(join(OBSERVABILITY, 'alloy-config.alloy'), 'utf8');
  const start = config.indexOf('otelcol.receiver.otlp "default"');
  assert.ok(start >= 0, 'no otelcol.receiver.otlp "default"');
  const output = config.slice(config.indexOf('output {', start), config.indexOf('}', config.indexOf('output {', start)));
  assert.match(output, /\blogs\s*=/, 'the OTLP receiver has no logs output');
  assert.match(output, /\btraces\s*=/, 'the OTLP receiver has no traces output');
});
