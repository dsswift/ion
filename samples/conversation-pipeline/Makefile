# Local conversation pipeline. Reached from the repository root as
# `make demo <verb>`, or directly from this directory as `make <verb>`.
#
# Containers are orchestrated by the repository's dev.yaml (profile
# `pipeline`, compose project `ion-demo`); this Makefile delegates to the
# `dev` CLI for that and never carries its own compose file. The Go
# commands run on the host and talk to the published ports.

SHELL := /bin/bash
.DEFAULT_GOAL := help

# Host-side endpoints: the pipeline profile's published ports (dev.yaml).
export EVENTHUB_CONNECTION_STRING ?= Endpoint=sb://localhost:5673;SharedAccessKeyName=RootManageSharedAccessKey;SharedAccessKey=SAS_KEY_VALUE;UseDevelopmentEmulator=true;
export EVENTHUB_NAME ?= conversation-events
export COSMOS_ENDPOINT ?= http://localhost:8081/
export COSMOS_KEY ?= C2y6yHQvUrCCxVMhcVoGjHAyB6C5yKl4OO3JJDIdjKxOP4BhQvpxiDyuYyMK9+gXCcrjKa5vXczV14MK1pIZ3g==
export BLOB_CONNECTION_STRING ?= DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==;BlobEndpoint=http://127.0.0.1:10100/devstoreaccount1;

HOT_WINDOW ?= 30s
CONV ?=
ROOT := $(abspath $(dir $(lastword $(MAKEFILE_LIST)))/../..)
PROJECT := ion-demo
SVC ?= pipeline-capture

.PHONY: help build check up down reset status logs seed list transcript fold run checkpoints

help:
	@echo "verb                          reads                     writes                          what it does"
	@echo "up                            -                         -                               dev run pipeline: eventhub, azurite, cosmos, capture writer, ingest function"
	@echo "status                        -                         -                               show every container and whether the function host answers 200"
	@echo "checkpoints                   event hub, azurite        deletes stale checkpoints       audit both consumers' checkpoints against the hub and remove those from an earlier hub"
	@echo "seed                          -                         event hub                       publish one scripted conversation (prints its id); the only verb that writes the hub"
	@echo "list                          cosmos, archive blob      -                               list conversations in the hot store and the archive"
	@echo "transcript CONV=<id>          cosmos, then archive blob -                               reconstruct one conversation; --source cosmos|archive forces one side"
	@echo "fold [HOT_WINDOW=$(HOT_WINDOW)]        capture blob, cosmos      archive blob; deletes from cosmos  fold idle conversations from capture into the archive, then clear the hot store"
	@echo "run [RUN_ARGS=--verbose]      all of the above          all of the above                guided walkthrough: seed, wait, transcript from cosmos, fold, transcript from the archive, checked"
	@echo "logs [SVC=pipeline-capture]   -                         -                               follow one container (pipeline-capture, pipeline-ingest, pipeline-eventhub, ...)"
	@echo "check                         -                         -                               go vet + go test + function typecheck"
	@echo "build                         -                         -                               go build + npm ci + tsc"
	@echo "down                          -                         -                               stop the stack, keep its data"
	@echo "reset                         -                         -                               stop the stack and delete its data"
	@echo
	@echo "The hub is fed by seed, or by an engine configured per README.md. The capture writer and the"
	@echo "ingest function run in Docker and are what move hub messages into capture blob and cosmos."

build:
	go build ./...
	cd function && npm ci --no-audit --no-fund && npm run build

check:
	go vet ./... && go test ./...
	cd function && npm run typecheck

# dev run deploys the profile from the repository root (build contexts in
# dev.yaml are root-relative). Stop, reset, status, and logs address the
# profile's compose project by name so the observability stack is never
# touched.
up:
	@command -v dev >/dev/null 2>&1 || { echo "the dev CLI is required (see dev.yaml at the repository root)"; exit 1; }
	cd "$(ROOT)" && dev run pipeline
	@$(MAKE) --no-print-directory checkpoints
	@$(MAKE) --no-print-directory status

# A redeploy recreates the emulator hub while Azurite keeps the consumers'
# checkpoints, which then point into a hub that no longer exists. Prove
# which ones are stale and remove them, so the consumers start clean. The
# capture writer audits its own group before it starts; the Functions host
# cannot, so when its checkpoints were stale it is restarted to re-read.
checkpoints:
	@out=$$(go run ./cmd/checkpoints --repair) && echo "$$out" && \
	if echo "$$out" | grep -q "^  ingest .*stale, deleted"; then \
	  echo "ingest checkpoints were stale; restarting the function host so it re-reads them"; \
	  docker restart "$(PROJECT)-pipeline-ingest" >/dev/null; \
	fi

down:
	docker ps -q --filter "label=com.docker.compose.project=$(PROJECT)" | xargs -r docker stop

reset:
	docker ps -aq --filter "label=com.docker.compose.project=$(PROJECT)" | xargs -r docker rm -f
	docker volume ls -q --filter "label=com.docker.compose.project=$(PROJECT)" | xargs -r docker volume rm

logs:
	docker logs -f --tail 100 "$(PROJECT)-$(SVC)"

status:
	@docker ps --filter "label=com.docker.compose.project=$(PROJECT)" --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
	@printf 'function host: '; curl -s -o /dev/null -w '%{http_code}\n' http://localhost:7071/ || true

seed:
	go run ./cmd/seed $(SEED_ARGS)

list:
	go run ./cmd/transcript --list

transcript:
	@test -n "$(CONV)" || (echo "usage: make transcript CONV=<conversation id>"; exit 2)
	go run ./cmd/transcript --conversation "$(CONV)" --verify

fold:
	go run ./cmd/fold --hot-window $(HOT_WINDOW) $(FOLD_ARGS)

# The guided walkthrough: seed, wait for each store to actually hold the
# conversation, reconstruct from Cosmos DB, fold, reconstruct from the
# archive, with every step narrated and checked. RUN_ARGS="--verbose"
# shows the log lines the commands write while they work.
run:
	go run ./cmd/demo $(RUN_ARGS)
