/**
 * Barrel re-export so `@ion/server/store/git` resolves under the package's
 * `"./*": "./src/*.ts"` exports map, which does a literal `.ts` substitution
 * and has no directory-index fallback — a bare `store/git` request needs this
 * file to exist even though `store/git/index.ts` already does. Found while
 * working on spec 12 (the `--run host` desktop test filter pulled in
 * `studio-browser-host.test.tsx`, whose import chain hits this and failed
 * only under Vite's stricter exports-map resolution; `tsc` never caught it).
 */
export * from './git/index'
