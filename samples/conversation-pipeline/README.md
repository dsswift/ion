# Conversation pipeline sample

A complete, local, end-to-end consumer of Ion's `conversation.*` stream. It exists to prove one mental model with running code:

> **A conversation is a log, not a document.** The engine emits one event at a time to one destination. Everything downstream is a consumer of that log. Reassembly happens once, at the fold, and never in the hot path.

```
Ion engine ──AMQP──▶ Event Hub ──Capture──▶ Blob  capture/          record of truth (Avro, Capture layout)
                         │
                         └──Function──▶ Cosmos DB  conversations/events   hot index: one document per message, TTL

                     fold job:  capture/ ──reassemble + verify──▶ Blob  archive/<conversation>.json
                                          then clears the conversation from Cosmos DB
```

Every piece maps to an Azure component. Two are stand-ins because the emulators lack them:

| Here | In Azure | Notes |
|---|---|---|
| `pipeline-eventhub` (emulator, port 5673) | Event Hubs namespace + hub | Same AMQP SDK, same connection-string shape, consumer groups `capture` and `ingest`. |
| `pipeline-capture` (Go process) | **Event Hubs Capture** (a setting on the hub) | The emulator has no Capture. This process writes the same Avro schema at the same blob path layout, windowed by time and size, so a reader built here reads real Capture output unchanged. |
| `pipeline-ingest` (Functions host in Docker) | Azure Function, consumption plan, Event Hub trigger | Real Functions runtime, real trigger binding, real checkpointing to blob. |
| `pipeline-cosmos` (emulator, port 8081) | Cosmos DB serverless | Partition key `/conversation_id`, per-item TTL. A disposable hot index, never the system of record. |
| `pipeline-azurite` | Storage account | `capture/` and `archive/` containers, plus the Function's checkpoint store. |
| `fold` (Go command) | Scheduled job (Function timer / Logic App) | Where ADR-6002's LLM sanitization plugs in. This sample folds and verifies; it does not sanitize. |
| `transcript` (Go command) | Query and replay tooling | Reads the hot store first, then the archive. |

## Run it

Prerequisites: Docker Desktop, the [`dev`](https://github.com/dsswift/dev.yaml) CLI the repository's `dev.yaml` is written for, Go 1.25+, and Node 20+ (only to build the function locally; the container builds it too).

The containers are the `pipeline` profile in the repository's `dev.yaml`, compose project `ion-demo`, so they deploy through `dev run pipeline` like every other local stack here and run beside the `observability` profile without touching it. Every command is `make demo <verb>` from the repository root, or `make <verb>` from this directory. `make demo` alone prints the verbs.

```bash
make demo up          # dev run pipeline: eventhub, azurite, cosmos, capture writer, ingest function
make demo status      # wait until the function host answers 200
make demo run         # seed -> transcript from Cosmos -> fold -> transcript from the archive
```

`make demo run` is a guided walkthrough. It narrates each step, says what proves the step worked, waits for each store to actually hold the conversation instead of sleeping, and ends with `PASS` or `FAIL` and a non-zero exit on failure. The steps:

1. **Check the stack.** Cosmos DB, Azurite, and the function host answer.
2. **Publish one conversation.** Seven events. One tool output is 3 MiB, so it goes as five messages sharing one `event_id`. The first user message is sent twice on purpose. The messages go out in a scrambled order, parts included, half a second apart so the sequence is visible; the stores must restore the order from `seq` and `part` alone. `--in-order` sends them naturally and `--gap` changes the pause (`RUN_ARGS="--in-order --gap 100ms"`).
3. **Watch Cosmos DB fill.** Eleven documents, not twelve: the redelivery lands on the same document id.
4. **Watch capture fill.** Twelve messages, redelivery included: capture is the raw stream.
5. **Reconstruct from Cosmos DB.** Seven events in `seq` order although they were delivered scrambled; the big call reads `[5 parts, verified]`.
6. **Fold.** Archive written from capture, eleven hot documents cleared, Cosmos DB now empty for the conversation.
7. **Reconstruct from the archive.** Header says `source capture`; the timeline is event-for-event identical to step 5.

Output is colored on a terminal and plain in a pipe or when `NO_COLOR` is set. `make demo run RUN_ARGS=--verbose` shows the JSON log lines the commands write while they work; by default they stay off the console. The commands write those lines to stderr, so their real output (a transcript, a conversation id) stays pipeable.

Then look at the data directly:

- Cosmos Data Explorer: <http://localhost:1234> (database `conversations`, container `events`).
- Blob containers via Azure Storage Explorer against `http://127.0.0.1:10100/devstoreaccount1`, or `make demo list`.

## Feed it from a real engine

Point the engine's conversation stream at this stack's hub. In `~/.ion/engine.json`:

```json
{
  "conversationEvents": {
    "enabled": true,
    "targets": ["eventhub"],
    "eventHubConnectionString": "Endpoint=sb://localhost:5673;SharedAccessKeyName=RootManageSharedAccessKey;SharedAccessKey=SAS_KEY_VALUE;UseDevelopmentEmulator=true;",
    "eventHubName": "conversation-events"
  }
}
```

Restart the engine, work in a conversation, then:

```bash
make demo list                                   # find the conversation id
make demo transcript CONV=<conversation id>      # from the hot store
make demo fold HOT_WINDOW=2m                     # after the conversation has been idle two minutes
make demo transcript CONV=<conversation id>      # now from the archive
```

The engine's own size contract (`docs/enterprise/telemetry.md`, "Size contract") produces the same `segment` block the seed produces, so a real 50 MB tool output arrives as parts, lands as one document per part, and reassembles at the fold with the same verification.

## What each command does

Which store each verb touches, so a test of one path is not mistaken for a test of another:

| Verb | Reads | Writes |
|---|---|---|
| `seed` | nothing | the Event Hub. The only verb that writes the hub; a configured engine is the other writer. |
| `transcript CONV=<id>` | Cosmos first; the archive blob when Cosmos has nothing (`--source` forces one) | nothing |
| `list` | Cosmos and the archive container | nothing |
| `fold` | the capture blobs (the record of truth), plus a Cosmos check that capture holds every hot document | the archive blob; then deletes the conversation from Cosmos |
| `checkpoints` | the hub's creation time and partition bounds, both consumers' checkpoint blobs | deletes checkpoints that belong to an earlier hub |
| `run` | all of the above, in order | all of the above |

The hub itself is exercised by the two consumers in Docker, not by any verb: the capture writer moves hub messages into capture blobs, the ingest function moves them into Cosmos. `transcript` is therefore the read path a portal would use, hot and archived; `fold` is the archive job.

- **`cmd/capture`** claims every partition on the `capture` consumer group, buffers each partition's events for `CAPTURE_WINDOW_SECONDS` (default 20) or `CAPTURE_WINDOW_BYTES`, then writes one Avro file at `{namespace}/{hub}/{partition}/{yyyy}/{MM}/{dd}/{HH}/{mm}/{ss}.avro` and checkpoints after the write. A crash between write and checkpoint replays the window, which the idempotent stores downstream absorb.
- **`function/`** (`ingestConversationEvents`) is an Event Hub trigger with `cardinality: many` on the `ingest` consumer group. For each message it writes one document with `id` = `event_id` (or `event_id:part`), `conversation_id`, `sort_key` (nanosecond `ts`, then `seq`), the whole envelope under `event`, and a TTL. It reassembles nothing and throws on a failed upsert so the batch is redelivered.
- **`cmd/transcript`** reads one conversation from Cosmos with a single-partition query ordered by `sort_key`, folds it (dedupe by document id, group parts by `event_id`, concatenate in part order, verify length and SHA-256), and renders it. With no hot documents it reads the archive. `--verify` exits non-zero on any reassembly problem; `--json` dumps the folded transcript.
- **`cmd/fold`** scans the capture container, groups by conversation, and for each conversation idle past `--hot-window` checks that every hot document is present in capture, folds from capture, writes `archive/<conversation_id>.json`, and only then deletes the hot documents. A conversation with a missing part is archived with the problem recorded and its hot copy kept.

`internal/stream` is the one place the envelope, the document identity, the sort key, and reassembly are defined. The function's `src/document.ts` mirrors the two derivations it needs. The contract they both implement is `docs/observability/conversation-events.schema.json`.

## Ordering, identity, and fidelity

- **Order** is `ts` parsed as a timestamp, then `payload.seq`, then `segment.part`. Never string-compare `ts`; RFC 3339 trims trailing zeros. `seq` is assigned by the engine in the same critical section as `ts`, so the two orders never disagree within one engine process. Delivery order is irrelevant by design: the demo sends every message scrambled and `internal/stream` has a test that folds a scrambled conversation, redelivery included, back to seq order.
- **Identity** of a delivered message is `event_id` plus `segment.part` when present. Every store keys on it; every redelivery is an upsert.
- **Fidelity** is checked, not assumed. A reassembled event is `Verified` only when its length and SHA-256 match what the parts declared. A gap is reported as a problem on the event, never silently dropped, and the fold will not clear the hot store while one exists.

## Checkpoints outlive the hub

Both consumers record where they are in each partition as blobs in Azurite (the capture writer in `capture-checkpoints`, the Functions host in `azure-webjobs-eventhub`). Those blobs survive a redeploy; the emulator's hub does not. After `make demo up` the hub's offsets start again from zero while the checkpoints still point into the old hub. The Functions SDK then fails every read on that partition with `The supplied offset ... is invalid` and never resets, and a checkpoint whose sequence number happens to be inside the new hub's range silently skips everything below it. This is not an emulator quirk: the same thing happens in Azure after a hub is rebuilt, or when a checkpoint falls behind the retention window.

The sample makes the decision explicit instead of hoping. `internal/checkpoints` compares each checkpoint with the hub and calls it stale on either of two proofs: the blob was last modified before the hub was created, or its sequence number is past the partition's last enqueued sequence number. A stale checkpoint and its ownership record are deleted so the consumer re-claims the partition from the beginning of what the hub still holds. The audit runs in three places: the capture writer audits its own group before it starts, `make demo up` audits both groups right after deploy and restarts the function host if its checkpoints were stale, and the demo's first step audits again and narrates what it found. `make demo checkpoints` runs it by hand; without `--repair` it only reports.

## Production notes

- Enable Capture on the hub with a short window (one minute) into a container with a lifecycle rule that deletes raw files after the hot window plus margin. That container is the system of record until the fold runs; the fold's archive is the record after.
- Put "audit and reset consumer checkpoints" in the runbook for rebuilding a hub or changing its retention. The consumers will not do it for you.
- Cosmos DB is a hot index. Set the per-item TTL to the hot window; losing the container never loses the record. Serverless throughput fits a 150-seat fleet; the read pattern is single-partition.
- The fold in production reads the Capture files for its time window (they are named by enqueue time) rather than scanning the container, and runs sanitization on the folded transcript before the archive write.
- Azure Data Explorer is the alternative if cross-conversation analytics become the dominant read. The log shape above moves there without changing the engine or the hub.

## Tests

```bash
make demo check  # go vet + go test (reassembly, ordering, splitter round trip), function typecheck
```

`internal/stream/event_test.go` pins the consumer-side contract: ordering by timestamp not string, dedupe by document id, reassembly with verification, missing-part reporting, and that `SplitField` (the seed's splitter) round-trips through `Reassemble`.
