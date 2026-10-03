FROM golang:1.27.1-alpine AS build
# Defaults to a parseable-but-obviously-synthetic semver rather than the Go
# source default ("dev", set in cmd/ion/main.go): `internal/config`'s and
# `@ion/server`'s `version-check.ts`'s `parseVersion` both require
# `major.minor.patch` and REFUSE (not "pass open") an unparseable version --
# a client fronting this engine over `server.json`'s `engine.minVersion`
# never reaches ready with the old hardcoded "dev". Real releases (CI's
# `build-engine-image` job) override this with the actual semver via
# `--build-arg VERSION=X.Y.Z`; `make docker` and any other unparameterized
# caller of this Dockerfile now get a parseable placeholder instead of a
# permanently-incompatible one.
ARG VERSION=0.0.0-dev
# bubblewrap is FR-03's OS-level sandbox on Linux (internal/sandbox's
# generateBwrapArgs/WrapCommand). Installed in this Alpine build stage --
# never available on the scratch final stage's own package manager, because
# it has none -- so its binary and every shared library it links against
# (libcap, musl's libc.so, etc.) are copied explicitly below rather than
# relying on a runtime linker to resolve them from a filesystem that does
# not exist in the final image.
RUN apk add --no-cache ca-certificates bubblewrap
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -ldflags "-s -w -X main.version=${VERSION}" -o /ion ./cmd/ion/

FROM scratch
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=build /usr/bin/bwrap /usr/bin/bwrap
COPY --from=build /lib/ld-musl-*.so.1 /lib/
COPY --from=build /usr/lib/libcap.so.2* /usr/lib/
# bwrap's --tmpfs /tmp (generateBwrapArgs' default mounts) needs /tmp to
# already exist as a directory node under the bound root -- scratch has no
# mkdir, so the empty directory is copied in from the Alpine build stage,
# which already has one.
COPY --from=build --chmod=1777 /tmp /tmp
COPY --from=build /ion /ion
ENV HOME=/data
ENV ION_DATA_DIR=/data
VOLUME ["/data"]
ENTRYPOINT ["/ion"]
CMD ["serve"]
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 CMD ["/ion", "health"]
