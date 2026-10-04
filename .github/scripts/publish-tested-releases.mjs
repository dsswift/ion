#!/usr/bin/env node
// publish-tested-releases.mjs — Publish every held release whose build is
// done and whose tests passed. Leave every other draft where it is, and say why.
//
// A built component's release is cut as a draft (hold-built-releases.sh). It
// goes public only when two things are true for the commit it was cut from:
//
//   built   build.yml's ready-<component> job set the commit status
//           `release/<component>` to success, its description starting with the
//           tag. Every asset is attached.
//   tested  every Quality job in GATES[component] passed for that commit.
//
// Either can finish last, so both ends run this sweep: build.yml's `publish`
// job and the Publish workflow on every Quality completion. Both share one
// concurrency group, so two sweeps never interleave. The sweep is idempotent:
// it reads every draft and acts only on what is ready.
//
// A Quality job that did not run for the commit (its paths were untouched)
// takes its verdict from the nearest ancestor commit whose Quality run did
// run it. Path scoping means the job's inputs have not changed since then, so
// that verdict still describes this commit's code.
//
// Publishing a component's newest version also moves its `:latest` image tag
// (build.yml pushes only version tags), and for the engine marks the GitHub
// release latest. An older version passing its tests after a newer one goes
// public without taking `latest` back.
//
// When every release a push cut is public, the sweep dispatches the release
// summary for that push.
//
// Usage: publish-tested-releases.mjs   (GH_TOKEN and GITHUB_REPOSITORY set,
// logged in to ghcr.io, run from a full-history checkout of the repository)

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The Quality jobs whose pass a component's release waits for: the tests,
// lints, and builds of the code that ships inside it. A component that bundles
// another one's source (desktop builds the engine and the server from the
// same commit) waits for that code's jobs too.
export const GATES = {
  engine: ['engine-test', 'engine-lint', 'engine-crossbuild', 'sdk-test', 'docker-build'],
  relay: ['relay-test', 'engine-lint'],
  server: [
    'server-test', 'server-typecheck', 'server-lint', 'shared-test', 'studio-wire',
    'status-writers', 'desktop-build', 'server-compose-smoke',
  ],
  desktop: [
    'desktop-test', 'desktop-test-windows', 'desktop-lint', 'desktop-build', 'server-parity',
    'studio-wire', 'status-writers', 'shared-test', 'server-test', 'server-typecheck',
    'server-lint', 'engine-test', 'engine-lint', 'engine-crossbuild', 'sdk-test',
  ],
};

// Publish order. The server bundle downloads a released engine binary, so a
// server release also waits for that engine release to be public; sweeping the
// engine first lets both go out in one sweep.
const ORDER = ['engine', 'relay', 'server', 'desktop'];

// The ghcr.io image each component pushes under ghcr.io/<repo>/<image>.
export const IMAGES = { engine: 'engine', relay: 'relay', server: 'studio-server' };

const QUALITY_EVENTS = new Set(['push', 'schedule', 'workflow_dispatch']);
const FAILED = new Set(['failure', 'timed_out', 'action_required', 'startup_failure', 'stale']);
const LOOKBACK_COMMITS = 2000;
const QUALITY_RUN_PAGES = 3;

const TAG_RE = /^(engine|server|desktop|relay)-v(\d+\.\d+\.\d+)$/;

export function parseTag(tag) {
  const m = TAG_RE.exec(tag);
  return m ? { component: m[1], version: m[2] } : null;
}

export function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

// The verdict of one Quality job across its matrix legs, in one run.
// `skipped` means the job did not run there; the caller looks further back.
// `cancelled` means it was due to run and never finished: no verdict for code
// that changed, so it holds until the job is rerun.
export function legsVerdict(legs, runCompleted) {
  if (legs.length === 0) return runCompleted ? 'skipped' : 'pending';
  if (legs.some((j) => j.status !== 'completed')) return 'pending';
  if (legs.some((j) => FAILED.has(j.conclusion))) return 'failure';
  if (legs.some((j) => j.conclusion === 'cancelled')) return 'cancelled';
  if (legs.every((j) => j.conclusion === 'skipped')) return 'skipped';
  return 'success';
}

export function makeSweeper({ api, apiLines, gh, git, docker, log, repo }) {
  const jobsCache = new Map();
  let runsCache = null;
  const ancestryCache = new Map();

  function qualityRuns() {
    if (runsCache) return runsCache;
    runsCache = [];
    for (let page = 1; page <= QUALITY_RUN_PAGES; page++) {
      const body = api(`repos/${repo}/actions/workflows/quality.yml/runs?branch=main&per_page=100&page=${page}`);
      const runs = body.workflow_runs ?? [];
      runsCache.push(...runs.filter((r) => QUALITY_EVENTS.has(r.event)));
      if (runs.length < 100) break;
    }
    return runsCache;
  }

  function jobsOf(runId) {
    if (!jobsCache.has(runId)) {
      jobsCache.set(runId, apiLines(`repos/${repo}/actions/runs/${runId}/jobs?filter=latest&per_page=100`, '.jobs[]'));
    }
    return jobsCache.get(runId);
  }

  // sha -> distance from `sha` along its history (0 for itself).
  function ancestry(sha) {
    if (!ancestryCache.has(sha)) {
      const list = git(['rev-list', `--max-count=${LOOKBACK_COMMITS}`, sha]).split('\n').filter(Boolean);
      ancestryCache.set(sha, new Map(list.map((s, i) => [s, i])));
    }
    return ancestryCache.get(sha);
  }

  function jobVerdict(job, sha) {
    const dist = ancestry(sha);
    const candidates = qualityRuns()
      .filter((r) => dist.has(r.head_sha))
      .sort((a, b) => dist.get(a.head_sha) - dist.get(b.head_sha) || b.created_at.localeCompare(a.created_at));
    if (!candidates.some((r) => r.head_sha === sha)) return { state: 'pending', why: 'no Quality run for this commit yet' };
    for (const run of candidates) {
      const jobs = jobsOf(run.id);
      const legs = jobs.filter((j) => j.name === job || j.name.startsWith(`${job} (`));
      const verdict = legsVerdict(legs, run.status === 'completed');
      if (verdict === 'skipped') {
        // Every product job is skipped when `changes` itself fails, which says
        // nothing about the code; only a scoping decision may be looked past.
        const changes = legsVerdict(jobs.filter((j) => j.name === 'changes'), run.status === 'completed');
        if (changes === 'success') continue;
        return { state: changes === 'pending' ? 'pending' : 'failure', run: run.id, sha: run.head_sha, why: `changes ${changes} in Quality run ${run.id}` };
      }
      return { state: verdict, run: run.id, sha: run.head_sha };
    }
    return { state: 'unknown', why: `no Quality run in the last ${LOOKBACK_COMMITS} commits ran it` };
  }

  function testVerdict(component, sha) {
    const verdicts = GATES[component].map((job) => ({ job, ...jobVerdict(job, sha) }));
    const bad = verdicts.find((v) => v.state === 'failure' || v.state === 'cancelled');
    if (bad) return { ok: false, why: `${bad.job} ${bad.state === 'cancelled' ? 'cancelled; rerun it' : 'failed'} (Quality run ${bad.run} on ${bad.sha.slice(0, 9)})${bad.why ? `: ${bad.why}` : ''}` };
    const open = verdicts.find((v) => v.state !== 'success');
    if (open) return { ok: false, why: `${open.job} ${open.state}${open.why ? `: ${open.why}` : ''}` };
    return { ok: true };
  }

  // The `release/<component>` status the build left on the commit, if its
  // description names this tag.
  function builtStatus(component, sha, tag) {
    const statuses = api(`repos/${repo}/commits/${sha}/statuses?per_page=100`);
    const latest = statuses.find((s) => s.context === `release/${component}`);
    if (!latest || latest.state !== 'success') return null;
    const words = (latest.description ?? '').split(' ');
    return words[0] === tag ? { bundles: /(?:^| )with (\S+)/.exec(latest.description)?.[1] ?? null } : null;
  }

  function isPublic(tag) {
    try {
      return api(`repos/${repo}/releases/tags/${tag}`).draft === false;
    } catch {
      // silent-ok: the tags endpoint answers 404 for a draft or a missing release; neither is public.
      return false;
    }
  }

  // component -> newest public version, or undefined when none is public.
  function newestPublic(publicTags) {
    const newest = {};
    for (const tag of publicTags) {
      const t = parseTag(tag);
      if (t && (!newest[t.component] || compareVersions(t.version, newest[t.component]) > 0)) newest[t.component] = t.version;
    }
    return newest;
  }

  function publish(rel, newest) {
    const isNewest = !newest[rel.component] || compareVersions(rel.version, newest[rel.component]) > 0;
    // /releases/latest is what the README install command resolves, and only
    // the engine release is ever marked latest.
    const latest = rel.component === 'engine' && isNewest;
    gh(['release', 'edit', rel.tag, '--draft=false', latest ? '--latest' : '--latest=false', '-R', repo]);
    if (isNewest) {
      newest[rel.component] = rel.version;
      const image = IMAGES[rel.component];
      if (image) {
        const base = `ghcr.io/${repo.toLowerCase()}/${image}`;
        docker(['buildx', 'imagetools', 'create', '-t', `${base}:latest`, `${base}:${rel.version}`]);
        log(`moved ${base}:latest to ${rel.version}`);
      }
    } else {
      log(`${rel.tag} is older than public ${rel.component} v${newest[rel.component]}; latest stays there`);
    }
  }

  function dispatchSummaries(shas) {
    for (const sha of shas) {
      const runs = api(`repos/${repo}/actions/workflows/release.yml/runs?head_sha=${sha}&event=push&per_page=10`).workflow_runs ?? [];
      const run = runs[0];
      if (!run) {
        log(`summary skipped for ${sha.slice(0, 9)}: no Release run for the commit`);
        continue;
      }
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-report-'));
      try {
        gh(['run', 'download', String(run.id), '-n', 'release-report', '-D', dir, '-R', repo]);
      } catch (err) {
        log(`summary skipped for ${sha.slice(0, 9)}: Release run ${run.id} has no release-report artifact (${err.message.split('\n')[0]})`);
        continue;
      }
      const report = JSON.parse(fs.readFileSync(path.join(dir, 'release-report.json'), 'utf8'));
      const waiting = report.releases.map((r) => r.tag_name).filter((tag) => !isPublic(tag));
      if (waiting.length > 0) {
        log(`summary waits for ${sha.slice(0, 9)}: still held ${waiting.join(', ')}`);
        continue;
      }
      gh(['workflow', 'run', 'release-summary.yml', '--ref', 'main', '-f', `release_run_id=${run.id}`, '-R', repo]);
      log(`summary dispatched for ${sha.slice(0, 9)} (Release run ${run.id})`);
    }
  }

  return function sweep() {
    const all = apiLines(`repos/${repo}/releases?per_page=100`, '.[] | {tag_name, target_commitish, draft}');
    const newest = newestPublic(all.filter((r) => !r.draft).map((r) => r.tag_name));
    const drafts = all.filter((r) => r.draft)
      .map((r) => ({ tag: r.tag_name, sha: r.target_commitish, ...parseTag(r.tag_name) }))
      .filter((r) => r.component)
      .sort((a, b) => ORDER.indexOf(a.component) - ORDER.indexOf(b.component));
    log(`sweep: ${drafts.length} held release(s)`);
    const publishedShas = new Set();
    for (const rel of drafts) {
      if (!/^[0-9a-f]{40}$/.test(rel.sha)) {
        log(`held ${rel.tag}: its target ${rel.sha} is not a commit, so it has no test verdict`);
        continue;
      }
      const built = builtStatus(rel.component, rel.sha, rel.tag);
      if (!built) {
        log(`held ${rel.tag}: build not finished for ${rel.sha.slice(0, 9)}`);
        continue;
      }
      if (built.bundles && !isPublic(built.bundles)) {
        log(`held ${rel.tag}: it bundles ${built.bundles}, which is not public`);
        continue;
      }
      const tests = testVerdict(rel.component, rel.sha);
      if (!tests.ok) {
        log(`held ${rel.tag}: ${tests.why}`);
        continue;
      }
      publish(rel, newest);
      publishedShas.add(rel.sha);
      log(`published ${rel.tag}: built and tested at ${rel.sha.slice(0, 9)}`);
    }
    dispatchSummaries(publishedShas);
  };
}

function main() {
  const repo = process.env.GITHUB_REPOSITORY;
  if (!repo) throw new Error('GITHUB_REPOSITORY is required');
  const run = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const sweep = makeSweeper({
    repo,
    api: (p) => JSON.parse(run('gh', ['api', p])),
    apiLines: (p, jq) => run('gh', ['api', '--paginate', p, '--jq', `${jq} | tojson`]).split('\n').filter(Boolean).map((l) => JSON.parse(l)),
    gh: (args) => run('gh', args),
    git: (args) => run('git', args),
    docker: (args) => run('docker', args),
    log: (msg) => console.log(msg),
  });
  sweep();
}

if (import.meta.url === `file://${process.argv[1]}`) main();
