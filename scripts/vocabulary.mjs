#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DOMAIN_VALUES = ['engine', 'harness-sdk', 'clients', 'relay'];
const KIND_VALUES = ['product-concept', 'ui-component', 'state', 'action', 'runtime-mechanic', 'internal-type', 'public-contract'];
const STATUS_VALUES = ['canonical', 'review-needed', 'deprecated'];
const CONTRACT_VALUES = ['public-wire', 'public-sdk', 'internal', 'none'];
const PLATFORM_VALUES = ['engine', 'sdk', 'desktop', 'studio', 'overlay', 'ios', 'relay'];
const PRESENTATION_VALUES = ['code', 'ui', 'wire', 'doc'];
const LANGUAGE_VALUES = ['go', 'typescript', 'swift', 'markdown', 'json'];
// Platform `desktop` records the shared Desktop client: one component that both Desktop
// presentations mount, so it covers the Studio column and the Overlay column. Platform
// `studio` or `overlay` records a presentation-specific surface, so it covers that one
// presentation and leaves the other presentation a real gap. The Desktop client itself is
// covered by any of the three, because Studio and Overlay are Desktop presentations.
const DESKTOP_PLATFORMS = ['desktop', 'studio', 'overlay'];
const CLIENT_PLATFORMS = [...DESKTOP_PLATFORMS, 'ios'];
const PARITY_COLUMNS = [
  ['Desktop', DESKTOP_PLATFORMS],
  ['Studio', ['studio', 'desktop']],
  ['Overlay', ['overlay', 'desktop']],
  ['iOS', ['ios']],
];

const DOMAIN_SCOPES = {
  engine: 'Headless runtime mechanics, normalized events, tools, and wire behavior.',
  'harness-sdk': 'Extension and SDK surfaces that decide policy on top of engine mechanics.',
  clients: 'Desktop, Studio, overlay, and iOS presentations of engine state.',
  relay: 'Transport, authentication, and synchronization between connected clients.',
};

const ENTRY_KEYS = new Set(['id', 'term', 'definition', 'domain', 'kind', 'status', 'qualifiers', 'aliases', 'legacyNames', 'implementations', 'contract', 'replacementId', 'notes']);
const IMPLEMENTATION_KEYS = new Set(['platform', 'presentation', 'language', 'symbol', 'path']);

function display(value) { return JSON.stringify(value); }
function string(value) { return typeof value === 'string' && value.trim() !== ''; }
function validateStringControlCharacters(errors, prefix, field, value) {
  if (typeof value === 'string' && /[\r\n]/.test(value)) errors.push(`${prefix}: ${field} must not contain carriage return or newline characters`);
}
function list(values) { return values.join(', '); }
function resolve(root, value) { return path.isAbsolute(value) ? value : path.resolve(root, value); }
function entryPrefix(entry, index) { return entry && typeof entry.id === 'string' ? `entry ${entry.id}` : `entry #${index + 1}`; }
function escapeRegex(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function hasBoundedSnippet(source, snippet) { return new RegExp(`(?<![A-Za-z0-9_$])${escapeRegex(snippet)}(?![A-Za-z0-9_$])`).test(source); }
function markdownCell(value) { return String(value).replace(/\|/g, '\\|'); }
function normalizedLines(value) { return value.replace(/\r\n/g, '\n'); }

function validateEnum(errors, prefix, field, value, allowed) {
  if (typeof value === 'string' && !allowed.includes(value)) {
    errors.push(`${prefix}: invalid ${field} ${display(value)}; allowed values: ${list(allowed)}`);
  }
}

export function validateRegistry(data, root) {
  const errors = [];
  if (!data || typeof data !== 'object' || Array.isArray(data)) return ['registry: expected a JSON object'];
  for (const key of Object.keys(data)) if (!['version', 'terms'].includes(key)) errors.push(`registry: unknown top-level key ${display(key)}`);
  if (data.version !== 1) errors.push(`registry: version must be 1; got ${display(data.version)}`);
  if (!Array.isArray(data.terms)) return [...errors, 'registry: terms must be an array'];

  const ids = new Map();
  const terms = new Map();
  const names = new Map();
  for (let index = 0; index < data.terms.length; index += 1) {
    const entry = data.terms[index];
    const prefix = entryPrefix(entry, index);
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) { errors.push(`${prefix}: must be an object`); continue; }
    for (const key of Object.keys(entry)) if (!ENTRY_KEYS.has(key)) errors.push(`${prefix}: unknown entry key ${display(key)}`);
    for (const field of ['id', 'term', 'definition', 'domain', 'kind', 'status', 'contract']) {
      if (!(field in entry)) errors.push(`${prefix}: missing required field ${field}`);
      else if (!string(entry[field])) errors.push(`${prefix}: ${field} must be a non-empty string`);
    }
    for (const field of ['term', 'definition']) validateStringControlCharacters(errors, prefix, field, entry[field]);
    if (typeof entry.id === 'string') {
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(entry.id)) errors.push(`${prefix}: id must be kebab-case`);
      if (ids.has(entry.id)) errors.push(`${prefix}: duplicate id ${display(entry.id)} also claimed by ${ids.get(entry.id)}`);
      else ids.set(entry.id, prefix);
    }
    if (typeof entry.term === 'string') {
      const normalized = entry.term.toLowerCase();
      if (terms.has(normalized)) errors.push(`${prefix}: duplicate canonical term ${display(entry.term)} also claimed by ${terms.get(normalized)}`);
      else terms.set(normalized, prefix);
    }
    validateEnum(errors, prefix, 'domain', entry.domain, DOMAIN_VALUES);
    validateEnum(errors, prefix, 'kind', entry.kind, KIND_VALUES);
    validateEnum(errors, prefix, 'status', entry.status, STATUS_VALUES);
    validateEnum(errors, prefix, 'contract', entry.contract, CONTRACT_VALUES);
    for (const field of ['qualifiers', 'aliases', 'legacyNames']) {
      if (field in entry && (!Array.isArray(entry[field]) || entry[field].some((value) => !string(value)))) errors.push(`${prefix}: ${field} must be an array of non-empty strings`);
      if (Array.isArray(entry[field])) entry[field].forEach((value, valueIndex) => validateStringControlCharacters(errors, prefix, `${field}[${valueIndex}]`, value));
    }
    for (const [role, values] of [['term', [entry.term]], ['alias', entry.aliases ?? []], ['legacy name', entry.legacyNames ?? []]]) {
      if (!Array.isArray(values)) continue;
      for (const value of values) {
        if (!string(value)) continue;
        const normalized = value.toLowerCase();
        if (names.has(normalized)) {
          const previous = names.get(normalized);
          errors.push(`${prefix}: ${role} ${display(value)} collides with ${previous.prefix} ${previous.role} ${display(previous.value)}`);
        } else names.set(normalized, { prefix, role, value });
      }
    }
    if ('replacementId' in entry && !string(entry.replacementId)) errors.push(`${prefix}: replacementId must be a non-empty string`);
    if ('notes' in entry && !string(entry.notes)) errors.push(`${prefix}: notes must be a non-empty string`);
    validateStringControlCharacters(errors, prefix, 'replacementId', entry.replacementId);
    validateStringControlCharacters(errors, prefix, 'notes', entry.notes);
    if (entry.status === 'deprecated' && !string(entry.replacementId)) errors.push(`${prefix}: deprecated entries require replacementId`);
    if (entry.status !== 'deprecated' && 'replacementId' in entry) errors.push(`${prefix}: non-deprecated entries must not carry replacementId`);
    if (entry.kind === 'public-contract' && !['public-wire', 'public-sdk'].includes(entry.contract)) errors.push(`${prefix}: public-contract entries require contract public-wire or public-sdk`);
    if (entry.kind === 'internal-type' && !['internal', 'none'].includes(entry.contract)) errors.push(`${prefix}: internal-type entries require contract internal or none`);
    if ('implementations' in entry && !Array.isArray(entry.implementations)) {
      errors.push(`${prefix}: implementations must be an array`);
      continue;
    }
    for (const [implementationIndex, implementation] of (entry.implementations ?? []).entries()) {
      if (!implementation || typeof implementation !== 'object' || Array.isArray(implementation)) { errors.push(`${prefix}: implementation must be an object`); continue; }
      for (const key of Object.keys(implementation)) if (!IMPLEMENTATION_KEYS.has(key)) errors.push(`${prefix}: implementation: unknown key ${display(key)}`);
      for (const field of ['platform', 'presentation', 'language', 'symbol', 'path']) {
        if (!(field in implementation)) errors.push(`${prefix}: implementation missing required field ${field}`);
        else if (!string(implementation[field])) errors.push(`${prefix}: implementation ${field} must be a non-empty string`);
        validateStringControlCharacters(errors, prefix, `implementations[${implementationIndex}].${field}`, implementation[field]);
      }
      validateEnum(errors, prefix, 'implementation platform', implementation.platform, PLATFORM_VALUES);
      validateEnum(errors, prefix, 'implementation presentation', implementation.presentation, PRESENTATION_VALUES);
      validateEnum(errors, prefix, 'implementation language', implementation.language, LANGUAGE_VALUES);
      if (string(implementation.path)) {
        const file = resolve(root, implementation.path);
        const relative = path.relative(root, file);
        if (path.isAbsolute(implementation.path) || relative === '..' || relative.startsWith(`..${path.sep}`)) {
          errors.push(`${prefix}: implementation path ${display(implementation.path)} must be repo-root-relative`);
        } else if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
          errors.push(`${prefix}: implementation path ${display(implementation.path)} does not exist as a file`);
        } else {
          let realRoot; let realFile;
          try { realRoot = fs.realpathSync(root); realFile = fs.realpathSync(file); } catch {
            errors.push(`${prefix}: implementation path ${display(implementation.path)} does not exist as a file`);
            continue;
          }
          const realRelative = path.relative(realRoot, realFile);
          if (realRelative === '..' || realRelative.startsWith(`..${path.sep}`) || path.isAbsolute(realRelative)) {
            errors.push(`${prefix}: implementation path ${display(implementation.path)} must stay within the repository root`);
          } else if (string(implementation.symbol) && !hasBoundedSnippet(fs.readFileSync(realFile, 'utf8'), implementation.symbol)) {
            errors.push(`${prefix}: symbol ${display(implementation.symbol)} not found in ${display(implementation.path)}`);
          }
        }
      }
    }
  }
  for (let index = 1; index < data.terms.length; index += 1) {
    const before = data.terms[index - 1]?.id;
    const after = data.terms[index]?.id;
    if (typeof before === 'string' && typeof after === 'string' && before > after) {
      errors.push(`registry: terms are not sorted by id: ${display(before)} must precede ${display(after)}`);
      break;
    }
  }
  for (const entry of data.terms) {
    if (!entry || typeof entry !== 'object') continue;
    const prefix = entryPrefix(entry, 0);
    if (entry.status === 'deprecated' && string(entry.replacementId)) {
      if (!ids.has(entry.replacementId)) errors.push(`${prefix}: replacementId ${display(entry.replacementId)} does not resolve to an entry`);
      if (entry.id === entry.replacementId) errors.push(`${prefix}: replacementId must not point at itself`);
    }
  }
  return errors;
}

function markdownList(values) { return values.length ? values.map((value) => `\`${value}\``).join(', ') : 'None'; }
function anchor(entry) { return `term-${entry.id}`; }
function schemaMarkdown() {
  return `## Registry schema\n\nRegistry: \`docs/vocabulary/terms.json\`. Its root object is \`{ "version": 1, "terms": [...] }\`. Unknown keys are rejected.\n\n| Field | Type and rule |\n| --- | --- |\n| \`id\` | Required string. Unique kebab-case stable identifier. |\n| \`term\` | Required string. Unique canonical human term, case-insensitive. |\n| \`definition\` | Required non-empty string. |\n| \`domain\` | Required enum: ${markdownCell(DOMAIN_VALUES.map((value) => `\`${value}\``).join(', '))}. |\n| \`kind\` | Required enum: ${markdownCell(KIND_VALUES.map((value) => `\`${value}\``).join(', '))}. |\n| \`status\` | Required enum: ${markdownCell(STATUS_VALUES.map((value) => `\`${value}\``).join(', '))}. |\n| \`qualifiers\` | Optional string array. Permitted modifier words. Default: \`[]\`. |\n| \`aliases\` | Optional string array. Informal or alternate names. Default: \`[]\`. |\n| \`legacyNames\` | Optional string array. Retired names. Default: \`[]\`. |\n| \`implementations\` | Optional array, default \`[]\`. Each item has \`platform\` (${markdownCell(PLATFORM_VALUES.map((value) => `\`${value}\``).join(', '))}), \`presentation\` (${markdownCell(PRESENTATION_VALUES.map((value) => `\`${value}\``).join(', '))}), \`language\` (${markdownCell(LANGUAGE_VALUES.map((value) => `\`${value}\``).join(', '))}), \`symbol\`, and repo-root-relative \`path\`. The file and literal symbol must exist. |\n| \`contract\` | Required enum: \`public-wire\`, \`public-sdk\`, \`internal\`, \`none\`. |\n| \`replacementId\` | Optional string. Required only for deprecated entries and must name another entry. |\n| \`notes\` | Optional non-empty string. |\n\nContract meanings: \`public-wire\` is a published wire contract. \`public-sdk\` is a published SDK contract. \`internal\` is an internal implementation contract. \`none\` has no contract classification. \`public-contract\` kinds require \`public-wire\` or \`public-sdk\`; \`internal-type\` kinds require \`internal\` or \`none\`.\n\nPlatform meanings for client surfaces: use \`desktop\` for a shared Desktop component that both Desktop presentations mount, and \`studio\` or \`overlay\` only for a surface that exists in one presentation. The generated parity matrix reads a \`desktop\` implementation as present in Studio and in Overlay.\n`;
}

export function renderMarkdown(data) {
  const entries = data.terms;
  const lines = ['---', 'title: Ion Vocabulary', 'description: Canonical terms for shared Ion concepts across the engine, harness SDK, clients, and relay.', 'sidebar_position: 1', '---', '', '<!-- GENERATED FILE. DO NOT EDIT. Source: docs/vocabulary/terms.json. Run `make generate-vocabulary`. -->', '', '# Ion Vocabulary', '', schemaMarkdown(), '## Naming and qualifier rules', '', 'Use each canonical term exactly as listed. A qualifier may precede or follow a canonical term only when it appears in that term\'s `qualifiers` list. Aliases and legacy names are index entries, not canonical names.', '', '## Four-domain model', ''];
  for (const domain of DOMAIN_VALUES) lines.push(`- **${domain}**: ${DOMAIN_SCOPES[domain]}`);
  lines.push('', '## Alphabetical index', '');
  for (const entry of [...entries].sort((a, b) => a.term < b.term ? -1 : a.term > b.term ? 1 : 0)) lines.push(`- [${entry.term}](#${anchor(entry)})`);
  for (const domain of DOMAIN_VALUES) {
    const domainEntries = entries.filter((entry) => entry.domain === domain);
    lines.push('', `## ${domain}`, '');
    if (!domainEntries.length) {
      lines.push('No entries.');
      continue;
    }
    for (const kind of KIND_VALUES) {
      const kindEntries = domainEntries.filter((entry) => entry.kind === kind);
      if (!kindEntries.length) continue;
      lines.push(`### ${kind}`, '');
      for (const entry of kindEntries) {
        lines.push(`#### ${entry.term} {#${anchor(entry)}}`, '', entry.definition, '', `- **ID:** \`${entry.id}\``, `- **Status:** \`${entry.status}\``, `- **Qualifiers:** ${markdownList(entry.qualifiers ?? [])}`, `- **Aliases:** ${markdownList(entry.aliases ?? [])}`, `- **Legacy names:** ${markdownList(entry.legacyNames ?? [])}`, `- **Contract:** \`${entry.contract}\``);
        if (entry.replacementId) lines.push(`- **Replacement:** [${entries.find((item) => item.id === entry.replacementId)?.term ?? entry.replacementId}](#term-${entry.replacementId})`);
        lines.push('- **Implementations:**');
        if ((entry.implementations ?? []).length) for (const implementation of entry.implementations) lines.push(`  - \`${implementation.platform}\` / \`${implementation.presentation}\` / \`${implementation.language}\`: \`${implementation.symbol}\` in \`${implementation.path}\``);
        else lines.push('  - None');
        if (entry.notes) lines.push(`- **Notes:** ${entry.notes}`);
        lines.push('');
      }
    }
  }
  const clientEntries = entries.filter((entry) => (entry.implementations ?? []).some((item) => CLIENT_PLATFORMS.includes(item.platform)));
  lines.push('## Client parity matrix', '', 'The Desktop client has two presentations, Studio and Overlay. An implementation on platform `desktop` is a shared Desktop component that both presentations mount, so it satisfies the Studio column and the Overlay column. An implementation on platform `studio` or `overlay` is presentation-specific and satisfies only that presentation. iOS is a separate client and is never satisfied by a Desktop implementation.', '', '| Canonical name | Desktop symbol | Studio use | Overlay use | iOS symbol | Gaps |', '| --- | --- | --- | --- | --- | --- |');
  for (const entry of clientEntries) {
    const implementations = entry.implementations;
    const symbols = (platforms) => implementations.filter((item) => platforms.includes(item.platform)).map((item) => `\`${item.symbol}\``).join(', ') || 'None';
    const gaps = PARITY_COLUMNS.filter(([, platforms]) => !implementations.some((item) => platforms.includes(item.platform))).map(([label]) => label).join(', ') || 'None';
    lines.push(`| ${markdownCell(entry.term)} | ${markdownCell(symbols(['desktop']))} | ${markdownCell(symbols(['studio', 'desktop']))} | ${markdownCell(symbols(['overlay', 'desktop']))} | ${markdownCell(symbols(['ios']))} | ${markdownCell(gaps)} |`);
  }
  if (!clientEntries.length) lines.push('| None | None | None | None | None | None |');
  const alternateNames = entries.flatMap((entry) => [...(entry.aliases ?? []).map((name) => ({ name, entry, role: 'Alias' })), ...(entry.legacyNames ?? []).map((name) => ({ name, entry, role: 'Legacy name' }))]).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  lines.push('', '## Alias and legacy-name index', '');
  if (alternateNames.length) for (const item of alternateNames) lines.push(`- ${item.role}: \`${item.name}\` → [${item.entry.term}](#${anchor(item.entry)})`);
  else lines.push('None.');
  const review = entries.filter((entry) => ['review-needed', 'deprecated'].includes(entry.status));
  lines.push('', '## Review queue', '');
  if (review.length) for (const entry of review) lines.push(`- [${entry.term}](#${anchor(entry)}): ${entry.status === 'deprecated' ? `deprecated, replace with ${entries.find((item) => item.id === entry.replacementId)?.term ?? entry.replacementId}` : 'review needed'}`);
  else lines.push('None.');
  lines.push('', '## Mechanical rename workflow', '', '1. Update the registry entry.', '2. Move the old canonical term into `legacyNames`.', '3. Run `make generate-vocabulary`.', '4. Run `make check-vocabulary`.', '5. Update code or contracts only under a separate explicit request.', '');
  return lines.join('\n');
}

export function run(options) {
  let text;
  try { text = fs.readFileSync(options.registry, 'utf8'); } catch (error) { return [`registry: cannot read ${options.registry}: ${error.message}`]; }
  let data;
  try { data = JSON.parse(text); } catch (error) { return [`registry: invalid JSON in ${options.registry}: ${error.message}`]; }
  const errors = validateRegistry(data, options.root);
  if (errors.length) return errors;
  const output = renderMarkdown(data);
  if (options.command === 'generate') { fs.mkdirSync(path.dirname(options.out), { recursive: true }); fs.writeFileSync(options.out, output, 'utf8'); return []; }
  let committed;
  try { committed = fs.readFileSync(options.out, 'utf8'); } catch (error) { return [`generated index: cannot read ${options.out}: ${error.message}`]; }
  return normalizedLines(committed) === normalizedLines(output) ? [] : ['generated index differs from registry output; run `make generate-vocabulary`'];
}

function parseArgs(argv) {
  const [command, ...args] = argv;
  if (!['generate', 'check'].includes(command)) throw new Error('usage: node scripts/vocabulary.mjs <generate|check> [--root <path>] [--registry <path>] [--out <path>]');
  const values = { command, root: process.cwd() };
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index]; const value = args[index + 1];
    if (!['--root', '--registry', '--out'].includes(flag) || value === undefined) throw new Error('usage: node scripts/vocabulary.mjs <generate|check> [--root <path>] [--registry <path>] [--out <path>]');
    values[flag.slice(2)] = value; index += 1;
  }
  values.root = path.resolve(values.root);
  values.registry = resolve(values.root, values.registry ?? 'docs/vocabulary/terms.json');
  values.out = resolve(values.root, values.out ?? 'docs/vocabulary/index.md');
  return values;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const errors = run(options);
    if (errors.length) { for (const error of errors) console.error(`vocabulary: ${error}`); process.exitCode = 1; }
  } catch (error) { console.error(`vocabulary: ${error.message}`); process.exitCode = 1; }
}
