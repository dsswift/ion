#!/usr/bin/env node
// patch-zustand.js — CRITICAL: Patch Zustand's useStore to use useRef-cached
// selectors.
//
// Zustand 5.x passes inline selectors to useCallback, but React 19's strict
// useSyncExternalStore checks call getSnapshot consecutively and require
// identical return values. Inline selectors produce new function refs each
// render, causing React error #185 (Maximum update depth exceeded) which
// crashes the entire React tree -- the transparent overlay window shows but
// renders nothing visible.
//
// This patch caches the selector in useRef so getSnapshot stays stable.
// Remove this patch only after Zustand fixes the upstream issue.
// Ported from patch-zustand.sh to run on every platform (postinstall.js is
// Node, not bash, so it works identically on Windows).
const fs = require('fs')
const path = require('path')

const PATCHED_SOURCE = `import React from 'react';
import { createStore } from 'zustand/vanilla';

const identity = (arg) => arg;
function useStore(api, selector = identity) {
  const selectorRef = React.useRef(selector);
  const resultRef = React.useRef();
  const stateRef = React.useRef();
  selectorRef.current = selector;

  const getSnapshot = React.useCallback(() => {
    const state = api.getState();
    if (stateRef.current === state && resultRef.current !== undefined) {
      return resultRef.current;
    }
    const result = selectorRef.current(state);
    stateRef.current = state;
    resultRef.current = result;
    return result;
  }, [api]);

  const getServerSnapshot = React.useCallback(() => {
    return selectorRef.current(api.getInitialState());
  }, [api]);

  const slice = React.useSyncExternalStore(
    api.subscribe,
    getSnapshot,
    getServerSnapshot
  );
  React.useDebugValue(slice);
  return slice;
}
const createImpl = (createState) => {
  const api = createStore(createState);
  const useBoundStore = (selector) => useStore(api, selector);
  Object.assign(useBoundStore, api);
  return useBoundStore;
};
const create = ((createState) => createState ? createImpl(createState) : createImpl);

export { create, useStore };
`

/**
 * Patches the given zustand/esm/react.mjs file in place if it still carries
 * the unpatched React.useCallback(selector...) pattern. Idempotent: a
 * second call against an already-patched file is a no-op. Returns nothing;
 * prints its outcome, matching the original bash script's console output.
 */
function patchZustand(filePath) {
  if (!fs.existsSync(filePath)) return
  const contents = fs.readFileSync(filePath, 'utf8')
  if (!/React\.useCallback[^\n]*selector/.test(contents)) {
    console.log('zustand already patched')
    return
  }
  fs.writeFileSync(filePath, PATCHED_SOURCE)
  console.log('Patched Zustand useStore (ref-cached selectors)')
}

module.exports = { patchZustand }

if (require.main === module) {
  patchZustand(path.join(__dirname, '..', 'node_modules', 'zustand', 'esm', 'react.mjs'))
}
