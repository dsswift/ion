.PHONY: build build-linux build-darwin test test-integration test-e2e clean docker

BINARY := ion
VERSION ?= dev
LDFLAGS := -s -w -X main.version=$(VERSION)

# Darwin builds need cgo for the Local Network warmup probe
# (internal/network/lanwarmup_darwin.go — Network.framework). Linux builds
# stay CGO_ENABLED=0 for the static FROM-scratch container binary; the darwin
# probe file is excluded there by build tag, and a darwin build without cgo
# still compiles (the probe becomes a logged no-op).
CGO_DARWIN := $(if $(filter Darwin,$(shell uname -s)),1,0)

build:
	CGO_ENABLED=$(CGO_DARWIN) go build -ldflags "$(LDFLAGS)" -o bin/$(BINARY) ./cmd/ion/

build-linux:
	CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -ldflags "$(LDFLAGS)" -o bin/$(BINARY)-linux-amd64 ./cmd/ion/

build-darwin:
	CGO_ENABLED=1 GOOS=darwin GOARCH=arm64 go build -ldflags "$(LDFLAGS)" -o bin/$(BINARY)-darwin-arm64 ./cmd/ion/

test:
	go test ./...

test-integration:
	go test -tags integration ./...

test-e2e:
	go test -tags e2e ./...

clean:
	rm -rf bin/

docker:
	docker build --platform linux/amd64 -t ion-engine .

install: build
	cp bin/$(BINARY) /usr/local/bin/$(BINARY)
