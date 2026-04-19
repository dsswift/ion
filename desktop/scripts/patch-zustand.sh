#!/usr/bin/env bash
# CRITICAL: Patch Zustand's useStore to use useRef-cached selectors.
#
# Zustand 5.x passes inline selectors to useCallback, but React 19's strict
# useSyncExternalStore checks call getSnapshot consecutively and require
# identical return values. Inline selectors produce new function refs each
# render, causing React error #185 (Maximum update depth exceeded) which
# crashes the entire React tree -- the transparent overlay window shows but
# renders nothing visible.
#
# This patch caches the selector in useRef so getSnapshot stays stable.
# Remove this patch only after Zustand fixes the upstream issue.
# See: https://github.com/pmndrs/zustand/issues
set -euo pipefail

ZUSTAND_REACT="node_modules/zustand/esm/react.mjs"
[ -f "$ZUSTAND_REACT" ] || exit 0

# Only patch if it still uses the broken useCallback pattern
if grep -q 'React.useCallback.*selector' "$ZUSTAND_REACT"; then
  cat > "$ZUSTAND_REACT" << 'EOF'
import React from 'react';
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
EOF
  echo "Patched Zustand useStore (ref-cached selectors)"
fi
