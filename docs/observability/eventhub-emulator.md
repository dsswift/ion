# Local Event Hub emulator

A local Azure Event Hubs emulator, for exercising `conversationEvents.targets: ["eventhub"]` (or `telemetry.targets: ["eventhub"]`) end to end without a real Azure subscription. It's part of the default `observability` `dev.yaml` profile, so it comes up automatically with the rest of the local observability stack.

## Bring it up

```
dev run
```

This starts, among the rest of the `observability` profile, two additional containers:

| Service | Image | Ports | Purpose |
|---|---|---|---|
| `eventhub-emulator` | `mcr.microsoft.com/azure-messaging/eventhubs-emulator:latest` | 5672 (AMQP), 9092 (Kafka-compatible, unused), 5300 (health) | The emulator itself |
| `azurite` | `mcr.microsoft.com/azure-storage/azurite:latest` | 10000-10002 | Metadata/blob storage the emulator requires |

The emulator speaks AMQP (and a Kafka-compatible protocol) only — it has no HTTPS ingest endpoint. This is why the engine's `eventhub` target uses the `azeventhubs` AMQP SDK rather than reusing the `http` target.

## Entity configuration

The emulator's namespace and event hub are defined by [`eventhub-emulator-config.json`](eventhub-emulator-config.json), mounted read-only at `/Eventhubs_Emulator/ConfigFiles/Config.json`:

| Field | Value |
|---|---|
| Namespace | `emulatorns1` (the only namespace name the emulator's validator accepts — confirmed by its own startup rejection of any other value) |
| Event hub (entity) name | `conversation-events` |
| Partition count | 2 |
| Consumer group | `$Default` (auto-created by the emulator — do not declare it explicitly in `ConsumerGroups`, the emulator rejects a config that redeclares it) |

Editing this file changes what event hub name the engine's `eventHubName` config must match. The emulator reads it at container start — restart the container after an edit.

## Connection string

When the engine runs natively on the host (not inside a container) and the emulator's AMQP port is published to `localhost:5672` (the default above), use:

```
Endpoint=sb://localhost;SharedAccessKeyName=RootManageSharedAccessKey;SharedAccessKey=SAS_KEY_VALUE;UseDevelopmentEmulator=true;
```

`UseDevelopmentEmulator=true` is recognized by the `azeventhubs` Go SDK and handles the emulator's self-signed TLS internally — no `InsecureSkipVerify` or other manual TLS override is needed.

## Engine config

```json
{
  "conversationEvents": {
    "enabled": true,
    "targets": ["eventhub"],
    "eventHubConnectionString": "Endpoint=sb://localhost;SharedAccessKeyName=RootManageSharedAccessKey;SharedAccessKey=SAS_KEY_VALUE;UseDevelopmentEmulator=true;",
    "eventHubName": "conversation-events"
  }
}
```

The same block shape works under `telemetry` instead of `conversationEvents`, using the identical `eventHubConnectionString`/`eventHubName` fields — see [`telemetry.md`](../enterprise/telemetry.md) § "Event Hub target".

## Accumulate-while-off, drain-on-recovery

This is not a separate mechanism — it's the generalized retry queue described in [`telemetry.md`](../enterprise/telemetry.md) § "Durable delivery". While the emulator container is stopped, every failed publish is written to an on-disk retry queue instead of being dropped. Once the emulator is running again and answering, the next flush tick redelivers the queued batches in order with exponential backoff between attempts on a batch that keeps failing.

To see this happen:

1. Stop just the `eventhub-emulator` container (`docker stop ion-obs-eventhub-emulator`) — no need to tear down the rest of the `observability` stack.
2. Drive conversation activity through an engine configured as above. Watch `~/.ion/engine.jsonl` for a redelivery-failed / rescheduling log line.
3. Restart the container (`docker start ion-obs-eventhub-emulator`, or `dev run` to reconcile the whole profile).
4. Watch for the retry queue's redelivery log line, then confirm the events landed by reading them back from the emulator (e.g. a small `azeventhubs.NewConsumerClient` reader against the `conversation-events` entity's `$Default` consumer group).

## Reading the stream back: the conversation pipeline sample

[`samples/conversation-pipeline/`](../../samples/conversation-pipeline/README.md) is a self-contained consumer of this stream — its own emulator, a stand-in for Event Hubs Capture, an Event Hub-triggered Azure Function writing a Cosmos DB emulator, a transcript reconstruction tool, and a fold job that moves idle conversations to a blob archive. It is the `pipeline` profile in `dev.yaml` (compose project `ion-demo`, reached as `make demo up`), and its own Event Hubs emulator listens on port 5673 with the consumer groups its two consumers need, so it runs beside this stack without touching it; point the engine at it with the connection string in that README.

