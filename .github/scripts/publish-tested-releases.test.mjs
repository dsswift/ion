// Pins publish-tested-releases.mjs: a held release goes public only when its
// build is done and every gating Quality job passed for its commit, a skipped
// job inherits the nearest ancestor's verdict, and the summary goes out once
// every release of a push is public.
//
// Run: node --test .github/scripts/publish-tested-releases.test.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { GATES, isTransient, legsVerdict, makeSweeper, withRetry } from './publish-tested-releases.mjs';

const REPO = 'owner/ion';
const sha = (c) => c.repeat(40);
const A = sha('a'); // older commit
const B = sha('b'); // newer commit, child of A

function world() {
  return {
    history: [B, A],
    releases: {},
    statuses: {},
    runs: [],
    jobs: {},
    releaseRuns: {},
    reports: {},
    calls: [],
    logs: [],
  };
}

function release(w, tag, commit) {
  w.releases[tag] = { tag_name: tag, target_commitish: commit, draft: true };
}
function built(w, commit, component, description) {
  (w.statuses[commit] ??= []).unshift({ context: `release/${component}`, state: 'success', description });
}
// One Quality run on `commit` with every listed job at `conclusion`; every
// other gating job is skipped there.
function quality(w, commit, id, results, { status = 'completed', created = `2026-10-0${id}T00:00:00Z` } = {}) {
  w.runs.push({ id, head_sha: commit, event: 'push', status, created_at: created });
  const all = new Set(['changes', ...Object.values(GATES).flat()]);
  results = { changes: 'success', ...results };
  w.jobs[id] = [...all].map((name) => {
    const r = results[name];
    if (r === undefined) return { name, status: 'completed', conclusion: 'skipped' };
    if (r === 'running') return { name, status: 'in_progress', conclusion: null };
    return { name, status: 'completed', conclusion: r };
  });
}
function allPass(component) {
  return Object.fromEntries(GATES[component].map((j) => [j, 'success']));
}

function sweeper(w) {
  const api = (p) => {
    let m;
    if ((m = /releases\/tags\/(.+)$/.exec(p))) {
      const r = w.releases[m[1]];
      if (!r || r.draft) throw new Error('HTTP 404');
      return r;
    }
    if ((m = /commits\/([0-9a-f]+)\/statuses/.exec(p))) return w.statuses[m[1]] ?? [];
    if (p.includes('quality.yml/runs')) return { workflow_runs: p.endsWith('page=1') ? w.runs : [] };
    if ((m = /release\.yml\/runs\?head_sha=([0-9a-f]+)/.exec(p))) {
      const id = w.releaseRuns[m[1]];
      return { workflow_runs: id ? [{ id }] : [] };
    }
    throw new Error(`unexpected api ${p}`);
  };
  const apiLines = (p) => {
    let m;
    if (p.includes('/releases?')) return Object.values(w.releases);
    if ((m = /runs\/(\d+)\/jobs/.exec(p))) return w.jobs[m[1]] ?? [];
    throw new Error(`unexpected apiLines ${p}`);
  };
  const gh = (args) => {
    w.calls.push(args.join(' '));
    if (args[0] === 'release' && args[1] === 'edit') w.releases[args[2]].draft = false;
    if (args[0] === 'run' && args[1] === 'download') {
      const report = w.reports[args[2]];
      if (!report) throw new Error('no artifact');
      fs.writeFileSync(path.join(args[args.indexOf('-D') + 1], 'release-report.json'), JSON.stringify(report));
    }
    return '';
  };
  const git = (args) => w.history.slice(w.history.indexOf(args[args.length - 1])).join('\n');
  const docker = (args) => w.calls.push(`docker ${args.join(' ')}`);
  return makeSweeper({ api, apiLines, gh, git, docker, log: (m) => w.logs.push(m), repo: REPO });
}

const edits = (w) => w.calls.filter((c) => c.startsWith('release edit'));

test('publishes a built release whose gating jobs all passed', () => {
  const w = world();
  release(w, 'engine-v1.0.0', B);
  built(w, B, 'engine', 'engine-v1.0.0');
  quality(w, B, 1, allPass('engine'));
  sweeper(w)();
  assert.deepEqual(edits(w), [`release edit engine-v1.0.0 --draft=false --latest -R ${REPO}`]);
});

test('a release GitHub cannot answer for stays held; the sweep goes on', () => {
  const w = world();
  release(w, 'engine-v1.0.0', A);
  built(w, A, 'engine', 'engine-v1.0.0');
  quality(w, A, 1, allPass('engine'));
  release(w, 'engine-v1.1.0', B);
  built(w, B, 'engine', 'engine-v1.1.0');
  quality(w, B, 2, allPass('engine'));
  const sweep = sweeper(w);
  w.jobs[1] = new Proxy([], { get() { throw Object.assign(new Error('Command failed: gh api'), { stderr: 'gh: Server Error (HTTP 502)\n' }); } });
  sweep();
  assert.deepEqual(edits(w), [`release edit engine-v1.1.0 --draft=false --latest -R ${REPO}`]);
  assert.match(w.logs.join('\n'), /held engine-v1\.0\.0: GitHub did not answer \(gh: Server Error \(HTTP 502\)\); the next sweep retries/);
});

test('holds a release when a gating job failed', () => {
  const w = world();
  release(w, 'engine-v1.0.0', B);
  built(w, B, 'engine', 'engine-v1.0.0');
  quality(w, B, 1, { ...allPass('engine'), 'engine-test': 'failure' });
  sweeper(w)();
  assert.deepEqual(edits(w), []);
  assert.match(w.logs.join('\n'), /held engine-v1\.0\.0: engine-test failed/);
});

test('holds while tests are still running or not started', () => {
  const w = world();
  release(w, 'engine-v1.0.0', B);
  built(w, B, 'engine', 'engine-v1.0.0');
  sweeper(w)();
  assert.match(w.logs.join('\n'), /no Quality run for this commit yet/);
  quality(w, B, 1, { ...allPass('engine'), 'engine-test': 'running' }, { status: 'in_progress' });
  sweeper(w)();
  assert.deepEqual(edits(w), []);
  assert.match(w.logs.join('\n'), /engine-test pending/);
});

test('holds until the build has attached every asset', () => {
  const w = world();
  release(w, 'engine-v1.0.0', B);
  quality(w, B, 1, allPass('engine'));
  built(w, B, 'engine', 'engine-v0.9.0');
  sweeper(w)();
  assert.deepEqual(edits(w), []);
  assert.match(w.logs.join('\n'), /build not finished/);
});

test('a job skipped on the commit takes the nearest ancestor verdict', () => {
  const w = world();
  release(w, 'engine-v1.0.0', B);
  built(w, B, 'engine', 'engine-v1.0.0');
  quality(w, A, 1, { ...allPass('engine'), 'engine-test': 'failure' });
  quality(w, B, 2, { 'docker-build': 'success' }); // engine-test skipped on B
  sweeper(w)();
  assert.deepEqual(edits(w), [], 'an untouched failing test must not pass by being skipped');

  const ok = world();
  release(ok, 'engine-v1.0.0', B);
  built(ok, B, 'engine', 'engine-v1.0.0');
  quality(ok, A, 1, allPass('engine'));
  quality(ok, B, 2, { 'docker-build': 'success' });
  sweeper(ok)();
  assert.equal(edits(ok).length, 1);
});

test('an older version passing late goes public without taking latest back', () => {
  const w = world();
  w.releases['engine-v1.6.0'] = { tag_name: 'engine-v1.6.0', target_commitish: A, draft: false };
  release(w, 'engine-v1.5.0', B);
  built(w, B, 'engine', 'engine-v1.5.0');
  quality(w, B, 1, allPass('engine'));
  sweeper(w)();
  assert.deepEqual(edits(w), [`release edit engine-v1.5.0 --draft=false --latest=false -R ${REPO}`]);
  assert.ok(!w.calls.some((c) => c.startsWith('docker')), 'engine:latest must stay on v1.6.0');
});

test('publishing the newest version moves its :latest image tag', () => {
  const w = world();
  w.releases['engine-v1.0.0'] = { tag_name: 'engine-v1.0.0', target_commitish: A, draft: false };
  release(w, 'engine-v1.1.0', B);
  built(w, B, 'engine', 'engine-v1.1.0');
  quality(w, B, 1, allPass('engine'));
  sweeper(w)();
  assert.deepEqual(w.calls.filter((c) => c.startsWith('docker')), [
    'docker buildx imagetools create -t ghcr.io/owner/ion/engine:latest ghcr.io/owner/ion/engine:1.1.0',
  ]);
});

test('the summary goes out once every release of the push is public', () => {
  const w = world();
  release(w, 'engine-v1.0.0', B);
  // The Go SDK has no build job: hold-built-releases.sh published it already.
  w.releases['sdk/go/v0.1.9'] = { tag_name: 'sdk/go/v0.1.9', target_commitish: B, draft: false };
  w.releaseRuns[B] = 77;
  w.reports[77] = { releases: [{ tag_name: 'engine-v1.0.0' }, { tag_name: 'sdk/go/v0.1.9' }] };
  sweeper(w)();
  assert.ok(!w.calls.some((c) => c.startsWith('workflow run')), 'the engine is still held');

  built(w, B, 'engine', 'engine-v1.0.0');
  quality(w, B, 1, allPass('engine'));
  sweeper(w)();
  assert.deepEqual(w.calls.filter((c) => c.startsWith('workflow run')), [
    `workflow run release-summary.yml --ref main -f release_run_id=77 -R ${REPO}`,
  ]);
});

test('a run whose changes job failed gives no pass by skipping', () => {
  const w = world();
  release(w, 'engine-v1.0.0', B);
  built(w, B, 'engine', 'engine-v1.0.0');
  quality(w, A, 1, allPass('engine'));
  quality(w, B, 2, { changes: 'failure' });
  sweeper(w)();
  assert.deepEqual(edits(w), []);
  assert.match(w.logs.join('\n'), /changes failure in Quality run 2/);
});

test('a cancelled gating job holds until it is rerun', () => {
  const w = world();
  release(w, 'engine-v1.0.0', B);
  built(w, B, 'engine', 'engine-v1.0.0');
  quality(w, A, 1, allPass('engine'));
  quality(w, B, 2, { ...allPass('engine'), 'engine-test': 'cancelled' });
  sweeper(w)();
  assert.deepEqual(edits(w), []);
  assert.match(w.logs.join('\n'), /engine-test cancelled; rerun it/);
});

test('legsVerdict folds matrix legs', () => {
  const leg = (status, conclusion) => ({ status, conclusion });
  assert.equal(legsVerdict([], true), 'skipped');
  assert.equal(legsVerdict([], false), 'pending');
  assert.equal(legsVerdict([leg('completed', 'success'), leg('in_progress', null)], false), 'pending');
  assert.equal(legsVerdict([leg('completed', 'success'), leg('completed', 'cancelled')], true), 'cancelled');
  assert.equal(legsVerdict([leg('completed', 'failure'), leg('completed', 'cancelled')], true), 'failure');
  assert.equal(legsVerdict([leg('completed', 'skipped')], true), 'skipped');
  assert.equal(legsVerdict([leg('completed', 'success'), leg('completed', 'skipped')], true), 'success');
});

test('every gating job is a job in quality.yml', () => {
  const quality = fs.readFileSync(path.join(import.meta.dirname, '../workflows/quality.yml'), 'utf8');
  const jobs = new Set([...quality.matchAll(/^ {2}([a-z0-9-]+):$/gm)].map((m) => m[1]));
  for (const [component, gates] of Object.entries(GATES)) {
    for (const job of gates) assert.ok(jobs.has(job), `${component} gates on ${job}, which quality.yml does not define`);
  }
});

// A gh failure carries GitHub's answer on stderr, as execFileSync reports it.
function ghError(stderr) {
  return Object.assign(new Error(`Command failed: gh api\n${stderr}`), { stderr });
}

test('a transient GitHub error is retried with doubling backoff, then succeeds', () => {
  const sleeps = [];
  const logs = [];
  let calls = 0;
  const fn = withRetry(
    () => {
      calls++;
      if (calls < 3) throw ghError('gh: Server Error (HTTP 502)\n');
      return 'ok';
    },
    { sleep: (ms) => sleeps.push(ms), log: (m) => logs.push(m) },
  );
  assert.equal(fn(), 'ok');
  assert.equal(calls, 3);
  assert.deepEqual(sleeps, [2000, 4000]);
  assert.equal(logs.length, 2);
});

test('a transient error that never clears fails after the last attempt', () => {
  let calls = 0;
  const fn = withRetry(
    () => {
      calls++;
      throw ghError('gh: Server Error (HTTP 503)\n');
    },
    { attempts: 3, sleep: () => {}, log: () => {} },
  );
  assert.throws(fn, /HTTP 503/);
  assert.equal(calls, 3);
});

test('a permanent GitHub error is not retried', () => {
  let calls = 0;
  const fn = withRetry(
    () => {
      calls++;
      throw ghError('gh: Not Found (HTTP 404)\n');
    },
    { sleep: () => assert.fail('slept on a permanent error'), log: () => {} },
  );
  assert.throws(fn, /HTTP 404/);
  assert.equal(calls, 1);
});

test('transient covers 5xx, timeouts, dropped connections, and empty bodies only', () => {
  for (const s of ['gh: Server Error (HTTP 502)', 'HTTP 504: Gateway Timeout', 'read: connection reset by peer', 'unexpected EOF', 'i/o timeout', 'unexpected end of JSON input']) {
    assert.ok(isTransient(ghError(s)), s);
  }
  for (const s of ['gh: Not Found (HTTP 404)', 'HTTP 422: Validation Failed', 'HTTP 401: Bad credentials']) {
    assert.ok(!isTransient(ghError(s)), s);
  }
});
