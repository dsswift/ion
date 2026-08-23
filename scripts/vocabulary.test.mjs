import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const repo = path.resolve(import.meta.dirname, '..');
const tool = path.join(repo, 'scripts/vocabulary.mjs');
const fixtureRoots = [];

function entry(overrides = {}) {
  return { id: 'alpha', term: 'Alpha', definition: 'A valid definition.', domain: 'engine', kind: 'product-concept', status: 'canonical', contract: 'none', implementations: [{ platform: 'engine', presentation: 'code', language: 'go', symbol: 'AlphaSymbol', path: 'source.go' }], ...overrides };
}
function fixture(terms = [entry()]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ion-vocabulary-'));
  fixtureRoots.push(root);
  fs.writeFileSync(path.join(root, 'source.go'), 'package fixture\nconst AlphaSymbol = 1\n', 'utf8');
  const registry = path.join(root, 'terms.json');
  const out = path.join(root, 'index.md');
  fs.writeFileSync(registry, JSON.stringify({ version: 1, terms }, null, 2), 'utf8');
  return { root, registry, out };
}
function run(fix, command) {
  return spawnSync(process.execPath, [tool, command, '--root', fix.root, '--registry', fix.registry, '--out', fix.out], { encoding: 'utf8' });
}
function failing(name, terms, reason) {
  test(name, () => {
    const result = run(fixture(terms), 'generate');
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}${result.stderr}`, reason);
  });
}
test.after(() => { for (const root of fixtureRoots) fs.rmSync(root, { recursive: true, force: true }); });

test('generate writes output and check round trips through the CLI', () => {
  const fix = fixture();
  const generated = run(fix, 'generate');
  assert.equal(generated.status, 0, generated.stderr);
  assert.match(fs.readFileSync(fix.out, 'utf8'), /# Ion Vocabulary/);
  const checked = run(fix, 'check');
  assert.equal(checked.status, 0, checked.stderr);
});
test('valid fixture passes check without reading repository vocabulary files', () => {
  const fix = fixture();
  assert.equal(run(fix, 'generate').status, 0);
  const result = run(fix, 'check');
  assert.equal(result.status, 0, result.stderr);
  assert.notEqual(fix.registry, path.join(repo, 'docs/vocabulary/terms.json'));
  assert.notEqual(fix.out, path.join(repo, 'docs/vocabulary/index.md'));
});

failing('rejects invalid domain', [entry({ domain: 'bad-domain' })], /invalid domain "bad-domain"/);
failing('rejects newline in scalar definition', [entry({ definition: 'Invalid\ndefinition' })], /entry alpha: definition must not contain carriage return or newline characters/);
failing('rejects carriage return in alias element', [entry({ aliases: ['Invalid\ralias'] })], /entry alpha: aliases\[0\] must not contain carriage return or newline characters/);
failing('rejects newline in nested implementation symbol', [entry({ implementations: [{ platform: 'engine', presentation: 'code', language: 'go', symbol: 'Alpha\nSymbol', path: 'source.go' }] })], /entry alpha: implementations\[0\]\.symbol must not contain carriage return or newline characters/);
failing('rejects duplicate canonical term without case distinction', [entry(), entry({ id: 'beta', term: 'ALPHA' })], /duplicate canonical term/i);
failing('rejects duplicate id', [entry(), entry({ term: 'Beta' })], /duplicate id "alpha"/);
failing('rejects alias collision', [entry({ aliases: ['Shared'] }), entry({ id: 'beta', term: 'Beta', aliases: ['shared'] })], /collides/i);
failing('rejects missing implementation path', [entry({ implementations: [{ platform: 'engine', presentation: 'code', language: 'go', symbol: 'AlphaSymbol', path: 'missing.go' }] })], /does not exist as a file/);
failing('rejects missing implementation symbol', [entry({ implementations: [{ platform: 'engine', presentation: 'code', language: 'go', symbol: 'MissingSymbol', path: 'source.go' }] })], /symbol "MissingSymbol" not found/);
failing('rejects unresolved deprecated replacement', [entry({ status: 'deprecated', replacementId: 'missing' })], /does not resolve/);
failing('rejects invalid public contract annotation', [entry({ kind: 'public-contract', contract: 'internal' })], /public-contract entries require/);
failing('rejects unsorted ids', [entry({ id: 'zeta' }), entry({ id: 'alpha', term: 'Beta' })], /not sorted by id/);
test('check rejects stale generated output', () => {
  const fix = fixture();
  assert.equal(run(fix, 'generate').status, 0);
  fs.appendFileSync(fix.out, 'stale\n');
  const result = run(fix, 'check');
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`, /run `make generate-vocabulary`/);
});

// The Desktop client has two presentations. A `desktop` implementation is a shared
// component that both presentations mount, so it must satisfy the Studio column and the
// Overlay column. A `studio` or `overlay` implementation is presentation-specific and must
// not satisfy the other presentation. iOS stays independent of every Desktop platform.
function clientImplementation(platform, symbol) {
  return { platform, presentation: 'ui', language: platform === 'ios' ? 'swift' : 'typescript', symbol, path: 'source.go' };
}
function parityRow(term, implementations) {
  const fix = fixture([entry({ domain: 'clients', implementations })]);
  const generated = run(fix, 'generate');
  assert.equal(generated.status, 0, generated.stderr);
  const row = fs.readFileSync(fix.out, 'utf8').split('\n').find((line) => line.startsWith(`| ${term} |`));
  assert.ok(row, `expected a parity row for ${term}`);
  const cells = row.split('|').slice(1, -1).map((cell) => cell.trim());
  assert.equal(cells.length, 6, `expected six parity cells, got ${row}`);
  return { desktop: cells[1], studio: cells[2], overlay: cells[3], ios: cells[4], gaps: cells[5] };
}

test('shared desktop implementation counts for both Studio and Overlay', () => {
  const cells = parityRow('Alpha', [clientImplementation('desktop', 'AlphaSymbol')]);
  assert.equal(cells.desktop, '`AlphaSymbol`');
  assert.equal(cells.studio, '`AlphaSymbol`');
  assert.equal(cells.overlay, '`AlphaSymbol`');
  assert.equal(cells.gaps, 'iOS');
});
test('studio-only implementation does not imply Overlay', () => {
  const cells = parityRow('Alpha', [clientImplementation('studio', 'AlphaSymbol')]);
  assert.equal(cells.studio, '`AlphaSymbol`');
  assert.equal(cells.overlay, 'None');
  assert.equal(cells.desktop, 'None');
  assert.equal(cells.gaps, 'Overlay, iOS');
});
test('overlay-only implementation does not imply Studio', () => {
  const cells = parityRow('Alpha', [clientImplementation('overlay', 'AlphaSymbol')]);
  assert.equal(cells.overlay, '`AlphaSymbol`');
  assert.equal(cells.studio, 'None');
  assert.equal(cells.desktop, 'None');
  assert.equal(cells.gaps, 'Studio, iOS');
});
test('iOS parity stays independent of Desktop platforms', () => {
  const desktopOnly = parityRow('Alpha', [clientImplementation('desktop', 'AlphaSymbol')]);
  assert.equal(desktopOnly.ios, 'None');
  const iosOnly = parityRow('Alpha', [clientImplementation('ios', 'AlphaSymbol')]);
  assert.equal(iosOnly.ios, '`AlphaSymbol`');
  assert.equal(iosOnly.desktop, 'None');
  assert.equal(iosOnly.studio, 'None');
  assert.equal(iosOnly.overlay, 'None');
  assert.equal(iosOnly.gaps, 'Desktop, Studio, Overlay');
  const both = parityRow('Alpha', [clientImplementation('desktop', 'AlphaSymbol'), clientImplementation('ios', 'AlphaSymbol')]);
  assert.equal(both.gaps, 'None');
});

test('CLI check detects drift when the invoked tool path contains a space', () => {
  const fix = fixture();
  const toolRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ion vocabulary tool '));
  fixtureRoots.push(toolRoot);
  const copiedTool = path.join(toolRoot, 'scripts', 'vocabulary.mjs');
  fs.mkdirSync(path.dirname(copiedTool), { recursive: true });
  fs.copyFileSync(tool, copiedTool);
  assert.equal(run(fix, 'generate').status, 0);
  fs.appendFileSync(fix.out, 'stale\n');
  const result = spawnSync(process.execPath, [fs.realpathSync(copiedTool), 'check', '--root', fix.root, '--registry', fix.registry, '--out', fix.out], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`, /generated index differs from registry output/);
});

test('accepts bounded real registry declaration snippets', () => {
  const snippets = ['func (h *Hub) HandleWebSocket', 'role != "ion" && role != "mobile"', 'struct ConversationStatusBar', 'export function ComposerControls', 'StatusDrawer', 'type Hub struct', 'role=ion', 'channelID, role string'];
  const fix = fixture(snippets.map((symbol, index) => entry({ id: `snippet-${index}`, term: `Snippet ${index}`, implementations: [{ platform: 'engine', presentation: 'code', language: 'go', symbol, path: 'source.go' }] })));
  fs.writeFileSync(path.join(fix.root, 'source.go'), `${snippets.join('\n')}\n`, 'utf8');
  const result = run(fix, 'generate');
  assert.equal(result.status, 0, result.stderr);
});

failing('rejects incidental one-character symbol', [entry({ implementations: [{ platform: 'engine', presentation: 'code', language: 'go', symbol: 'a', path: 'source.go' }] })], /symbol "a" not found/);
test('rejects implementation symlink that escapes the repository root', () => {
  const fix = fixture([entry({ implementations: [{ platform: 'engine', presentation: 'code', language: 'go', symbol: 'OutsideSymbol', path: 'outside.go' }] })]);
  const outside = path.join(os.tmpdir(), `ion-vocabulary-outside-${path.basename(fix.root)}.go`);
  fs.writeFileSync(outside, 'const OutsideSymbol = 1\n', 'utf8');
  fs.unlinkSync(path.join(fix.root, 'source.go'));
  fs.symlinkSync(outside, path.join(fix.root, 'outside.go'));
  const result = run(fix, 'generate');
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`, /must stay within the repository root/);
  fs.rmSync(outside, { force: true });
});

failing('reports non-array implementations without crashing', [entry({ implementations: { invalid: true } })], /implementations must be an array/);

test('check accepts generated output with CRLF line endings', () => {
  const fix = fixture();
  assert.equal(run(fix, 'generate').status, 0);
  fs.writeFileSync(fix.out, fs.readFileSync(fix.out, 'utf8').replace(/\n/g, '\r\n'), 'utf8');
  const result = run(fix, 'check');
  assert.equal(result.status, 0, result.stderr);
});

test('escapes pipe characters in generated parity table cells', () => {
  const fix = fixture([entry({ term: 'Alpha|Pipe', domain: 'clients', implementations: [clientImplementation('desktop', 'Alpha|Symbol')] })]);
  fs.writeFileSync(path.join(fix.root, 'source.go'), 'Alpha|Symbol\n', 'utf8');
  assert.equal(run(fix, 'generate').status, 0);
  const row = fs.readFileSync(fix.out, 'utf8').split('\n').find((line) => line.startsWith('| Alpha\\|Pipe |'));
  assert.equal(row, '| Alpha\\|Pipe | `Alpha\\|Symbol` | `Alpha\\|Symbol` | `Alpha\\|Symbol` | None | iOS |');
});

test('renders multi-entry registry metadata, indexes, and replacements', () => {
  const terms = [
    entry({ id: 'alpha', term: 'Zulu', status: 'deprecated', replacementId: 'beta', qualifiers: ['local'], aliases: ['z alias'], legacyNames: ['old zulu'], notes: 'Retired term.' }),
    entry({ id: 'beta', term: 'Alpha', definition: 'Replacement definition.', domain: 'clients', kind: 'ui-component', status: 'review-needed', qualifiers: ['shared'], aliases: ['a alias'], legacyNames: ['old alpha'], contract: 'none', implementations: [clientImplementation('desktop', 'AlphaSymbol')], notes: 'Review this term.' }),
  ];
  const fix = fixture(terms);
  assert.equal(run(fix, 'generate').status, 0);
  const output = fs.readFileSync(fix.out, 'utf8');
  assert.match(output, /^---\ntitle: Ion Vocabulary\ndescription: Canonical terms/m);
  assert.ok(output.indexOf('- [Alpha](#term-beta)') < output.indexOf('- [Zulu](#term-alpha)'));
  assert.match(output, /Alias: `a alias` → \[Alpha\]\(#term-beta\)/);
  assert.match(output, /Legacy name: `old zulu` → \[Zulu\]\(#term-alpha\)/);
  assert.match(output, /\| `implementations` \| Optional array/);
  assert.match(output, /- \*\*ID:\*\* `alpha`/);
  assert.match(output, /- \*\*Status:\*\* `deprecated`/);
  assert.match(output, /- \*\*Qualifiers:\*\* `local`/);
  assert.match(output, /- \*\*Aliases:\*\* `z alias`/);
  assert.match(output, /- \*\*Legacy names:\*\* `old zulu`/);
  assert.match(output, /- \*\*Contract:\*\* `none`/);
  assert.match(output, /- \*\*Implementations:\*\*[\s\S]*`AlphaSymbol` in `source.go`/);
  assert.match(output, /- \*\*Notes:\*\* Retired term\./);
  assert.match(output, /- \*\*Replacement:\*\* \[Alpha\]\(#term-beta\)/);
  assert.match(output, /\[Zulu\]\(#term-alpha\): deprecated, replace with Alpha/);
  assert.match(output, /\[Alpha\]\(#term-beta\): review needed/);
});
