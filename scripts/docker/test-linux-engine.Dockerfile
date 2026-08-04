# Prebaked image for `make test-linux-engine` / `make test-linux-engine-summary`.
#
# Bakes in `nodejs` (needed by the contract-manifest test, which shells out to
# node) and the non-root `ionci` user with its home directory pre-created.
# Before this image existed, every single gate invocation ran
# `apt-get update && apt-get install -y nodejs && useradd -m ionci` fresh
# inside the ephemeral `--rm` container — pure per-run overhead that this
# image pays once, at build time, instead.
#
# Rebuilt (via `docker build`) before every `make test-linux-engine` run.
# Docker's own layer cache makes that a fast no-op unless this file or the
# base image changes — see the Makefile targets for the build invocation.
ARG GO_VERSION=1.25
FROM golang:${GO_VERSION}

# `nodejs` matches the package name used by the prior in-container apt-get
# call; `--no-install-recommends` keeps the image lean since only the `node`
# binary itself is needed (contract manifest test shells out to plain node,
# no npm packages).
RUN apt-get update -qq && \
    apt-get install -y -qq --no-install-recommends nodejs && \
    rm -rf /var/lib/apt/lists/*

# Fixed home directory + pre-created, pre-owned cache mount points. The
# Makefile mounts named Docker volumes at /home/ionci/go and
# /home/ionci/gocache; Docker populates a freshly-created named volume from
# the image's existing directory contents (and ownership) on first mount, so
# chowning these here is what makes the volume usable by the non-root ionci
# user without a runtime chown step.
RUN useradd -m -s /bin/bash ionci && \
    mkdir -p /home/ionci/.ion /home/ionci/go /home/ionci/gocache && \
    chown -R ionci:ionci /home/ionci
