// Parser for the LogQL subset the dashboard recipes emit.
//
// The Azure Monitor target does not keep a second hand-written copy of every
// query. It parses the LogQL each panel already carries and compiles it to KQL
// (compile.ts), so a recipe change reaches both flavors in one edit. The
// grammar here is deliberately closed: anything outside it throws with the
// offending text, which fails generation instead of emitting a wrong panel.

export type MatchOp = '=' | '!=' | '=~' | '!~';

export interface Matcher {
  readonly name: string;
  readonly op: MatchOp;
  readonly value: string;
}

export type Stage =
  // `| json` or `| json alias="fields.path", ...`. Params map an alias to a body path.
  | { readonly kind: 'json'; readonly params: Readonly<Record<string, string>> }
  | { readonly kind: 'filter'; readonly name: string; readonly op: MatchOp; readonly value: string }
  // `| label_format x=`{{if .x}}{{.x}}{{else}}F{{end}}`` — present-or-fallback.
  | { readonly kind: 'coalesce'; readonly name: string; readonly fallback: string }
  // `| label_format ts="{{ __timestamp__ | unixEpoch }}"` — the line's own time in epoch seconds.
  | { readonly kind: 'timestamp'; readonly name: string }
  | { readonly kind: 'unwrap'; readonly name: string }
  // `| __error__=""` — Loki's parse-error guard; KQL has no equivalent failure to skip.
  | { readonly kind: 'noerror' };

export interface LogQuery {
  readonly matchers: readonly Matcher[];
  readonly stages: readonly Stage[];
}

export type RangeFn =
  | 'count_over_time'
  | 'sum_over_time'
  | 'avg_over_time'
  | 'max_over_time'
  | 'min_over_time'
  | 'last_over_time'
  | 'quantile_over_time'
  | 'rate';

export type AggOp = 'sum' | 'count' | 'max' | 'min' | 'avg' | 'topk';
export type BinOp = '+' | '-' | '*' | '/';
export type CmpOp = '>' | '<' | '>=' | '<=' | '==' | '!=';

export type Node =
  | { readonly t: 'num'; readonly v: number }
  // `vector(${__to:date:seconds})`: the dashboard's end time in epoch seconds.
  | { readonly t: 'now' }
  | {
      readonly t: 'range';
      readonly fn: RangeFn;
      readonly param?: number;
      readonly q: LogQuery;
      readonly window: string;
      readonly by?: readonly string[];
    }
  | { readonly t: 'agg'; readonly op: AggOp; readonly by?: readonly string[]; readonly param?: number; readonly arg: Node }
  | { readonly t: 'bin'; readonly op: BinOp; readonly l: Node; readonly r: Node }
  // A filtering comparison against a scalar: keeps the series where it holds.
  | { readonly t: 'cmp'; readonly op: CmpOp; readonly l: Node; readonly v: number }
  | {
      readonly t: 'label_replace';
      readonly arg: Node;
      readonly dst: string;
      readonly repl: string;
      readonly src: string;
      readonly regex: string;
    };

const RANGE_FNS: readonly string[] = [
  'count_over_time', 'sum_over_time', 'avg_over_time', 'max_over_time',
  'min_over_time', 'last_over_time', 'quantile_over_time', 'rate',
];
const AGG_OPS: readonly string[] = ['sum', 'count', 'max', 'min', 'avg', 'topk'];

class Cursor {
  pos = 0;
  readonly src: string;
  constructor(src: string) {
    this.src = src;
  }

  fail(msg: string): never {
    throw new Error(`LogQL parse: ${msg} at ${this.pos} in: ${this.src}`);
  }

  ws(): void {
    while (this.pos < this.src.length && /\s/.test(this.src[this.pos])) this.pos++;
  }

  peek(s: string): boolean {
    this.ws();
    return this.src.startsWith(s, this.pos);
  }

  eat(s: string): boolean {
    if (!this.peek(s)) return false;
    this.pos += s.length;
    return true;
  }

  expect(s: string): void {
    if (!this.eat(s)) this.fail(`expected "${s}"`);
  }

  done(): boolean {
    this.ws();
    return this.pos >= this.src.length;
  }

  ident(): string {
    this.ws();
    const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(this.src.slice(this.pos));
    if (!m) this.fail('expected identifier');
    this.pos += m[0].length;
    return m[0];
  }

  // Look at the next identifier without consuming it.
  peekIdent(): string | null {
    this.ws();
    const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(this.src.slice(this.pos));
    return m ? m[0] : null;
  }

  number(): number {
    this.ws();
    const m = /^\d+(?:\.\d+)?/.exec(this.src.slice(this.pos));
    if (!m) this.fail('expected number');
    this.pos += m[0].length;
    return Number(m[0]);
  }

  // A double-quoted string (Go escapes) or a backtick raw string.
  str(): string {
    this.ws();
    const q = this.src[this.pos];
    if (q === '`') {
      const end = this.src.indexOf('`', this.pos + 1);
      if (end < 0) this.fail('unterminated raw string');
      const out = this.src.slice(this.pos + 1, end);
      this.pos = end + 1;
      return out;
    }
    if (q !== '"') this.fail('expected string');
    let out = '';
    this.pos++;
    while (this.pos < this.src.length && this.src[this.pos] !== '"') {
      if (this.src[this.pos] === '\\') {
        this.pos++;
        out += this.src[this.pos];
      } else out += this.src[this.pos];
      this.pos++;
    }
    if (this.src[this.pos] !== '"') this.fail('unterminated string');
    this.pos++;
    return out;
  }

  op(): MatchOp {
    for (const o of ['=~', '!~', '!=', '='] as const) if (this.eat(o)) return o;
    this.fail('expected match operator');
  }

  // Raw text up to (not including) `close`, for `[window]` and `vector(...)`.
  rawUntil(close: string): string {
    const end = this.src.indexOf(close, this.pos);
    if (end < 0) this.fail(`expected "${close}"`);
    const out = this.src.slice(this.pos, end).trim();
    this.pos = end + close.length;
    return out;
  }

  labelList(): string[] {
    this.expect('(');
    const out: string[] = [];
    while (!this.eat(')')) {
      out.push(this.ident());
      this.eat(',');
    }
    return out;
  }
}

function parseSelector(c: Cursor): Matcher[] {
  c.expect('{');
  const out: Matcher[] = [];
  while (!c.eat('}')) {
    const name = c.ident();
    const op = c.op();
    out.push({ name, op, value: c.str() });
    c.eat(',');
  }
  return out;
}

const COALESCE = /^\{\{if \.(\w+)\}\}\{\{\.(\w+)\}\}\{\{else\}\}(.*)\{\{end\}\}$/;
const TIMESTAMP = /^\{\{\s*__timestamp__\s*\|\s*unixEpoch\s*\}\}$/;

function parseStage(c: Cursor): Stage {
  const word = c.ident();
  if (word === 'json') {
    const params: Record<string, string> = {};
    while (c.peekIdent() && !c.peek('|')) {
      const save = c.pos;
      const alias = c.ident();
      if (!c.eat('=')) {
        c.pos = save;
        break;
      }
      params[alias] = c.str();
      c.eat(',');
    }
    return { kind: 'json', params };
  }
  if (word === 'unwrap') return { kind: 'unwrap', name: c.ident() };
  if (word === 'label_format') {
    const name = c.ident();
    c.expect('=');
    const tmpl = c.str();
    const co = COALESCE.exec(tmpl);
    if (co && co[1] === name && co[2] === name) return { kind: 'coalesce', name, fallback: co[3] };
    if (TIMESTAMP.test(tmpl)) return { kind: 'timestamp', name };
    return c.fail(`unsupported label_format template ${tmpl}`);
  }
  const op = c.op();
  const value = c.str();
  if (word === '__error__') {
    if (op !== '=' || value !== '') c.fail('only __error__="" is supported');
    return { kind: 'noerror' };
  }
  return { kind: 'filter', name: word, op, value };
}

function parseLogQueryAt(c: Cursor): LogQuery {
  const matchers = parseSelector(c);
  const stages: Stage[] = [];
  while (c.eat('|')) stages.push(parseStage(c));
  return { matchers, stages };
}

function parseRange(c: Cursor, fn: RangeFn): Node {
  c.expect('(');
  let param: number | undefined;
  if (fn === 'quantile_over_time') {
    param = c.number();
    c.expect(',');
  }
  const q = parseLogQueryAt(c);
  c.expect('[');
  const window = c.rawUntil(']');
  c.expect(')');
  const by = c.peek('by') ? (c.ident(), c.labelList()) : undefined;
  return { t: 'range', fn, param, q, window, by };
}

function parseAgg(c: Cursor, op: AggOp): Node {
  let by = c.peek('by') ? (c.ident(), c.labelList()) : undefined;
  c.expect('(');
  let param: number | undefined;
  if (op === 'topk') {
    param = c.number();
    c.expect(',');
  }
  const arg = parseExpr(c);
  c.expect(')');
  if (!by && c.peek('by')) {
    c.ident();
    by = c.labelList();
  }
  return { t: 'agg', op, by, param, arg };
}

function parsePrimary(c: Cursor): Node {
  if (c.eat('(')) {
    const inner = parseExpr(c);
    c.expect(')');
    return inner;
  }
  if (/^\s*\d/.test(c.src.slice(c.pos))) return { t: 'num', v: c.number() };
  const word = c.ident();
  if (RANGE_FNS.includes(word)) return parseRange(c, word as RangeFn);
  if (AGG_OPS.includes(word)) return parseAgg(c, word as AggOp);
  if (word === 'vector') {
    c.expect('(');
    const arg = c.rawUntil(')');
    if (arg !== '${__to:date:seconds}') c.fail(`unsupported vector(${arg})`);
    return { t: 'now' };
  }
  if (word === 'label_replace') {
    c.expect('(');
    const arg = parseExpr(c);
    const parts: string[] = [];
    for (let i = 0; i < 4; i++) {
      c.expect(',');
      parts.push(c.str());
    }
    c.expect(')');
    return { t: 'label_replace', arg, dst: parts[0], repl: parts[1], src: parts[2], regex: parts[3] };
  }
  return c.fail(`unsupported function ${word}`);
}

// `on()` / `group_right()` only appear on the freshness subtraction, whose left
// side is a single scalar-like vector; matching modifiers change nothing there.
function skipMatching(c: Cursor): void {
  for (const kw of ['on', 'ignoring', 'group_left', 'group_right']) {
    if (c.peekIdent() === kw) {
      c.ident();
      c.labelList();
    }
  }
}

function parseTerm(c: Cursor): Node {
  let left = parsePrimary(c);
  for (;;) {
    const op = c.peek('*') ? '*' : c.peek('/') ? '/' : null;
    if (!op) return left;
    c.eat(op);
    skipMatching(c);
    left = { t: 'bin', op, l: left, r: parsePrimary(c) };
  }
}

// Comparison binds loosest; the recipes only compare a vector to a number.
function parseExpr(c: Cursor): Node {
  const left = parseSum(c);
  for (const op of ['>=', '<=', '==', '!=', '>', '<'] as const) {
    if (c.eat(op)) return { t: 'cmp', op, l: left, v: c.number() };
  }
  return left;
}

function parseSum(c: Cursor): Node {
  let left = parseTerm(c);
  for (;;) {
    const op = c.peek('+') ? '+' : c.peek('-') ? '-' : null;
    if (!op) return left;
    c.eat(op);
    skipMatching(c);
    left = { t: 'bin', op, l: left, r: parseTerm(c) };
  }
}

/** Parse a metric expression (anything that is not a bare stream selector). */
export function parseMetric(src: string): Node {
  const c = new Cursor(src);
  const node = parseExpr(c);
  if (!c.done()) c.fail('trailing input');
  return node;
}

/** Parse a log-stream query: a selector followed by pipeline stages. */
export function parseLogQuery(src: string): LogQuery {
  const c = new Cursor(src);
  const q = parseLogQueryAt(c);
  if (!c.done()) c.fail('trailing input');
  return q;
}

/** True when the expression is a bare stream (logs panel, annotation), not a metric. */
export function isStreamQuery(src: string): boolean {
  return src.trimStart().startsWith('{');
}
