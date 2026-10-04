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

import { GATES, legsVerdict, makeSweeper } from './publish-tested-releases.mjs';

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
  release(w, 'relay-v1.0.0', B);
  built(w, B, 'relay', 'relay-v1.0.0');
  quality(w, B, 1, allPass('relay'));
  sweeper(w)();
  assert.deepEqual(edits(w), [`release edit relay-v1.0.0 --draft=false --latest=false -R ${REPO}`]);
});

test('holds a release when a gating job failed', () => {
  const w = world();
  release(w, 'relay-v1.0.0', B);
  built(w, B, 'relay', 'relay-v1.0.0');
  quality(w, B, 1, { ...allPass('relay'), 'relay-test': 'failure' });
  sweeper(w)();
  assert.deepEqual(edits(w), []);
  assert.match(w.logs.join('\n'), /held relay-v1\.0\.0: relay-test failed/);
});

test('holds while tests are still running or not started', () => {
  const w = world();
  release(w, 'relay-v1.0.0', B);
  built(w, B, 'relay', 'relay-v1.0.0');
  sweeper(w)();
  assert.match(w.logs.join('\n'), /no Quality run for this commit yet/);
  quality(w, B, 1, { ...allPass('relay'), 'relay-test': 'running' }, { status: 'in_progress' });
  sweeper(w)();
  assert.deepEqual(edits(w), []);
  assert.match(w.logs.join('\n'), /relay-test pending/);
});

test('holds until the build has attached every asset', () => {
  const w = world();
  release(w, 'relay-v1.0.0', B);
  quality(w, B, 1, allPass('relay'));
  built(w, B, 'relay', 'relay-v0.9.0');
  sweeper(w)();
  assert.deepEqual(edits(w), []);
  assert.match(w.logs.join('\n'), /build not finished/);
});

test('a job skipped on the commit takes the nearest ancestor verdict', () => {
  const w = world();
  release(w, 'relay-v1.0.0', B);
  built(w, B, 'relay', 'relay-v1.0.0');
  quality(w, A, 1, { ...allPass('relay'), 'relay-test': 'failure' });
  quality(w, B, 2, { 'engine-lint': 'success' }); // relay-test skipped on B
  sweeper(w)();
  assert.deepEqual(edits(w), [], 'an untouched failing test must not pass by being skipped');

  const ok = world();
  release(ok, 'relay-v1.0.0', B);
  built(ok, B, 'relay', 'relay-v1.0.0');
  quality(ok, A, 1, allPass('relay'));
  quality(ok, B, 2, { 'engine-lint': 'success' });
  sweeper(ok)();
  assert.equal(edits(ok).length, 1);
});

test('a server release waits for the engine it bundles, and both go out in one sweep', () => {
  const w = world();
  release(w, 'server-v2.0.0', B);
  release(w, 'engine-v1.5.0', B);
  built(w, B, 'server', 'server-v2.0.0 with engine-v1.5.0');
  built(w, B, 'engine', 'engine-v1.5.0');
  quality(w, B, 1, { ...allPass('server'), ...allPass('engine') });
  sweeper(w)();
  assert.deepEqual(edits(w), [
    `release edit engine-v1.5.0 --draft=false --latest -R ${REPO}`,
    `release edit server-v2.0.0 --draft=false --latest=false -R ${REPO}`,
  ]);

  const held = world();
  release(held, 'server-v2.0.0', B);
  release(held, 'engine-v1.5.0', B);
  built(held, B, 'server', 'server-v2.0.0 with engine-v1.5.0');
  built(held, B, 'engine', 'engine-v1.5.0');
  quality(held, B, 1, { ...allPass('server'), ...allPass('engine'), 'engine-test': 'failure' });
  sweeper(held)();
  assert.deepEqual(edits(held), []);
  assert.match(held.logs.join('\n'), /held server-v2\.0\.0: it bundles engine-v1\.5\.0, which is not public/);
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
  w.releases['server-v1.0.0'] = { tag_name: 'server-v1.0.0', target_commitish: A, draft: false };
  release(w, 'server-v1.1.0', B);
  built(w, B, 'server', 'server-v1.1.0');
  quality(w, B, 1, allPass('server'));
  sweeper(w)();
  assert.deepEqual(w.calls.filter((c) => c.startsWith('docker')), [
    'docker buildx imagetools create -t ghcr.io/owner/ion/studio-server:latest ghcr.io/owner/ion/studio-server:1.1.0',
  ]);
});

test('the summary goes out once every release of the push is public', () => {
  const w = world();
  release(w, 'relay-v1.0.0', B);
  release(w, 'desktop-v3.0.0', B);
  built(w, B, 'relay', 'relay-v1.0.0');
  quality(w, B, 1, allPass('relay'));
  w.releaseRuns[B] = 77;
  w.reports[77] = { releases: [{ tag_name: 'relay-v1.0.0' }, { tag_name: 'desktop-v3.0.0' }] };
  sweeper(w)();
  assert.ok(!w.calls.some((c) => c.startsWith('workflow run')), 'desktop is still held');

  built(w, B, 'desktop', 'desktop-v3.0.0');
  quality(w, B, 2, { ...allPass('relay'), ...allPass('desktop') });
  sweeper(w)();
  assert.deepEqual(w.calls.filter((c) => c.startsWith('workflow run')), [
    `workflow run release-summary.yml --ref main -f release_run_id=77 -R ${REPO}`,
  ]);
});

test('a run whose changes job failed gives no pass by skipping', () => {
  const w = world();
  release(w, 'relay-v1.0.0', B);
  built(w, B, 'relay', 'relay-v1.0.0');
  quality(w, A, 1, allPass('relay'));
  quality(w, B, 2, { changes: 'failure' });
  sweeper(w)();
  assert.deepEqual(edits(w), []);
  assert.match(w.logs.join('\n'), /changes failure in Quality run 2/);
});

test('a cancelled gating job holds until it is rerun', () => {
  const w = world();
  release(w, 'relay-v1.0.0', B);
  built(w, B, 'relay', 'relay-v1.0.0');
  quality(w, A, 1, allPass('relay'));
  quality(w, B, 2, { ...allPass('relay'), 'relay-test': 'cancelled' });
  sweeper(w)();
  assert.deepEqual(edits(w), []);
  assert.match(w.logs.join('\n'), /relay-test cancelled; rerun it/);
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
