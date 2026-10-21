// The collector has to read every log file the schema documents.
//
// A log file the schema documents and Alloy's target list does not tail is
// invisible in Loki, with nothing failing to say so. A dashboard querying a
// component nothing ingests looks exactly like a quiet system.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const OBSERVABILITY = join(HERE, '..', '..');

/**
 * Files the schema documents that this stack deliberately does NOT tail.
 *
 * - telemetry.jsonl is pushed by the telemetry-forwarder to Alloy's Loki API
 *   rather than tailed: one frame can carry several events, so tailing it
 *   would ingest frames instead of events.
 */
const NOT_TAILED = new Set(['telemetry.jsonl']);

/** Every `- File: ...jsonl` the log schema names, by basename. */
function schemaLogFiles(): Set<string> {
  const schema = readFileSync(join(OBSERVABILITY, 'log-schema.md'), 'utf8');
  const files = new Set<string>();
  for (const line of schema.split('\n')) {
    if (!line.trimStart().startsWith('- File:')) continue;
    for (const match of line.matchAll(/`([^`]*?([A-Za-z0-9._-]+\.jsonl))`/g)) {
      files.add(match[2]);
    }
  }
  return files;
}

/** Every path Alloy's structured-log pipeline tails, by basename. */
function alloyTailedFiles(): Set<string> {
  const config = readFileSync(join(OBSERVABILITY, 'alloy-config.alloy'), 'utf8');
  const block = config.slice(config.indexOf('local.file_match "ion_logs"'));
  // To the end of the path_targets ARRAY -- each entry is itself a `{...}`,
  // so stopping at the first brace would see only the first file.
  const end = block.indexOf(']');
  const files = new Set<string>();
  for (const match of block.slice(0, end).matchAll(/"__path__"\s*=\s*"([^"]+)"/g)) {
    files.add(match[1].split('/').pop()!);
  }
  return files;
}

test('Alloy tails every log file the schema documents', () => {
  const documented = schemaLogFiles();
  assert.ok(documented.size > 0, 'parsed no "- File:" entries out of log-schema.md');

  const tailed = alloyTailedFiles();
  const missing = [...documented].filter((f) => !NOT_TAILED.has(f) && !tailed.has(f));

  assert.deepEqual(
    missing,
    [],
    `log-schema.md documents ${missing.join(', ')}, which alloy-config.alloy does not tail. ` +
      'Add it to local.file_match "ion_logs", or to NOT_TAILED with the reason it is collected another way.',
  );
});

test('the compose mount can be pointed at a custom data directory', () => {
  // An engine run with its own ION_DATA_DIR writes somewhere other than
  // ~/.ion, and was invisible to this stack with the mount hardcoded.
  const compose = readFileSync(join(OBSERVABILITY, 'docker-compose.yml'), 'utf8');
  assert.match(compose, /\$\{ION_LOGS_DIR:-\$\{HOME\}\/\.ion\}:\/ion-logs:ro/);
});
