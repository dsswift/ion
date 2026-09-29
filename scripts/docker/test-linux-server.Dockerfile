# Prebaked image for `make test-linux-server`.
#
# Identical shape to test-linux-desktop.Dockerfile: the @ion/server workspace
# package has no native dependencies, so this is Node executing JavaScript
# and the image only needs the same non-root ionci user pre-created.
ARG NODE_VERSION=22
FROM node:${NODE_VERSION}

RUN useradd -m -s /bin/bash ionci && \
    mkdir -p /home/ionci/.npm && \
    chown -R ionci:ionci /home/ionci
