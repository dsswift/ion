# node:22-alpine digest current as of implementation (child 11, 2026-09-09):
#   docker buildx imagetools inspect node:22-alpine
# Multi-arch index digest, not a single-platform manifest digest, so this
# pins correctly whether Docker resolves linux/amd64 or linux/arm64.
ARG NODE_DIGEST=sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32

FROM node:22-alpine@${NODE_DIGEST} AS build
WORKDIR /app
# Root package.json/lockfile define the npm workspace; packages/ and server/
# are the two workspace members @ion/server's own build needs. desktop/ is a
# third workspace member, needed here ONLY to build the browser Studio
# client (spec 18's `build:web`, served at server/web/ per spec 11) -- not
# for anything else in desktop/, which is why it's copied but never run
# outside that one script.
COPY package.json package-lock.json ./
COPY packages packages
COPY server server
COPY desktop desktop
RUN npm ci --ignore-scripts && npm -w server run build && npm -w desktop run build:web
# `npm ci` (no --omit=dev) installed every workspace's devDependencies too --
# typescript, eslint, vitest, jsdom, esbuild/lightningcss/rollup/vite
# (desktop's own toolchain, needed for build:web above), none of which the
# running server needs. Pruning after both builds (server/dist and
# server/web already produced) keeps only what a production
# `npm ci --omit=dev` would have installed, cutting node_modules from
# ~230MB to what server/scripts/build.mjs's own EXTERNAL runtime deps
# actually need. Required to stay under this child's 400MB image-size gate.
# --ignore-scripts here too: npm prune re-runs lifecycle scripts on its
# reinstall pass unless told not to, and desktop's postinstall tries to
# node-gyp-rebuild @parcel/watcher for Electron -- needs Python, which this
# alpine stage doesn't have and the server doesn't need that dependency at
# all (desktop/ is only ever used for its build:web script above).
RUN npm prune --omit=dev --ignore-scripts

# node-pty is a NATIVE module and `--ignore-scripts` above skipped its
# node-gyp build, so the package installed with no `build/Release/pty.node`
# and no `prebuilds/` -- every terminal in the pod failed with
# "Error: node-pty is not available", both the conversation terminal panel
# and a Studio surface terminal (which rendered as an empty box with a
# cursor and no shell).
#
# It must be rebuilt AFTER the prune: `npm prune` runs its own reinstall
# pass, which replaces package directories and would discard a binding
# built before it. The toolchain is a virtual apk package deleted in the
# same layer, so none of it reaches the runtime image; node-pty's own
# `--ignore-scripts` exemption is scoped to this one package rather than
# dropping the flag globally (desktop's postinstall still must not run).
#
# `alpine-linux-<arch>` is the prebuild-install triple; building from source
# is what actually produces the binding, since node-pty ships no musl
# prebuild.
RUN apk add --no-cache --virtual .node-pty-build python3 make g++ \
 && npm rebuild node-pty --build-from-source --foreground-scripts \
 && node -e "require('node-pty'); console.log('node-pty loads OK')" \
 && apk del .node-pty-build

FROM node:22-alpine@${NODE_DIGEST}
WORKDIR /app
ENV ION_DATA_DIR=/data
ENV NODE_ENV=production
# Log to the mounted file AND to stdout. The file is what an operator greps on
# the volume; stdout is what `docker logs`, `kubectl logs` and every container
# log collector read -- and it was empty, because the server only ever wrote
# the file, which goes away with the pod.
ENV ION_LOG_OUTPUT=both
# server/scripts/build.mjs esbuild-bundles everything EXCEPT the packages
# listed in its own EXTERNAL array (node-pty, chokidar, picomatch, archiver,
# yauzl, ws, bonjour-service, zustand) -- those stay real npm dependencies
# resolved from node_modules at runtime, so the runtime image needs the
# workspace's installed node_modules alongside the bundle, not just dist/.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/server/node_modules ./server/node_modules
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/server/package.json ./server/package.json
# static.ts's defaultWebDir() resolves relative to the bundled dist/main.js
# (dirname(main.js) + '../../web'): /app/server/dist -> /app/server ->
# /app -> /app/web. Must land here, not at /app/server/web.
COPY --from=build /app/server/web ./web
# git-runner.ts and the worktree/bench/integration modules under server/src
# all shell out to a real `git` binary (and, for SSH remotes, need `ssh` on
# PATH for GIT_SSH_COMMAND-based clone/push) -- these are documented,
# consumer-facing server features (Git panel, worktree lifecycle, bench
# assembly), not an optional extra, so the runtime image must ship both
# rather than assume a deployer provides them. node:22-alpine has neither by
# default.
RUN apk add --no-cache git openssh-client
WORKDIR /app/server
RUN mkdir -p /data && chown -R node:node /data
USER node
EXPOSE 7331
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:7331/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]
