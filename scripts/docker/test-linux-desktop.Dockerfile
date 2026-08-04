# Prebaked image for `make test-linux-desktop`.
#
# Bakes in the non-root `ionci` user with its home directory pre-created, so
# the per-run critical path skips `useradd -m ionci` on every single gate
# invocation.
#
# Rebuilt (via `docker build`) before every `make test-linux-desktop` run.
# Docker's own layer cache makes that a fast no-op unless this file or the
# base image changes — see the Makefile target for the build invocation.
ARG NODE_VERSION=22
FROM node:${NODE_VERSION}

# Fixed home directory + pre-created, pre-owned npm cache directory. The
# Makefile mounts a named Docker volume at /home/ionci/.npm — npm's default
# cache location for this user — so repeated `npm ci` runs resolve from a
# warm cache instead of re-downloading the registry every time. Docker
# populates a freshly-created named volume from the image's existing
# directory contents (and ownership) on first mount, so chowning here is
# what makes the volume usable by the non-root ionci user without a runtime
# chown step.
RUN useradd -m -s /bin/bash ionci && \
    mkdir -p /home/ionci/.npm && \
    chown -R ionci:ionci /home/ionci
