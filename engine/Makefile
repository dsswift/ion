.PHONY: build build-linux build-darwin test test-integration test-e2e clean docker

BINARY := ion
VERSION ?= dev
LDFLAGS := -s -w -X main.version=$(VERSION)

build:
	CGO_ENABLED=0 go build -ldflags "$(LDFLAGS)" -o bin/$(BINARY) ./cmd/ion/

build-linux:
	CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -ldflags "$(LDFLAGS)" -o bin/$(BINARY)-linux-amd64 ./cmd/ion/

build-darwin:
	CGO_ENABLED=0 GOOS=darwin GOARCH=arm64 go build -ldflags "$(LDFLAGS)" -o bin/$(BINARY)-darwin-arm64 ./cmd/ion/

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
