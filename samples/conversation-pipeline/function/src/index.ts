// The ingest function: an Event Hub trigger that writes every delivered
// message into the Cosmos DB hot store as its own document, keyed so that a
// redelivery is an upsert of the same document rather than a duplicate.
//
// This is a consumer BEHIND the hub, not an ingestion endpoint in front of
// it: the fleet talks to the hub, and this reads the hub in batches on its
// own consumer group. It reassembles nothing. A segmented event lands as
// one document per part, in the same partition as the rest of its
// conversation; the fold job puts it back together once, later.

import { app, InvocationContext } from '@azure/functions'
import { Container, CosmosClient } from '@azure/cosmos'
import { HotDocument, StreamEnvelope, toHotDocument } from './document'

const endpoint = process.env.COSMOS_ENDPOINT ?? 'http://localhost:8081/'
const key = process.env.COSMOS_KEY ?? ''
const databaseId = process.env.COSMOS_DATABASE ?? 'conversations'
const containerId = process.env.COSMOS_CONTAINER ?? 'events'
const hotTtlSeconds = Number(process.env.HOT_TTL_SECONDS ?? 7 * 24 * 3600)

let containerPromise: Promise<Container> | undefined

/**
 * Connects once per worker and ensures the database and container exist
 * with the same shape the Go tooling creates: partitioned on
 * conversation_id, per-item TTL enabled. Whichever process starts first
 * shapes the store; both shape it identically.
 */
function hotContainer(context: InvocationContext): Promise<Container> {
  if (!containerPromise) {
    containerPromise = (async () => {
      if (!key) throw new Error('COSMOS_KEY is required')
      const client = new CosmosClient({ endpoint, key })
      const { database } = await client.databases.createIfNotExists({ id: databaseId })
      const { container } = await database.containers.createIfNotExists({
        id: containerId,
        partitionKey: { paths: ['/conversation_id'] },
        defaultTtl: -1,
      })
      context.log(JSON.stringify({ msg: 'hot store open', endpoint, database: databaseId, container: containerId, hot_ttl_seconds: hotTtlSeconds }))
      return container
    })().catch((err: unknown) => {
      containerPromise = undefined
      throw err
    })
  }
  return containerPromise
}

/** A hub message body arrives parsed when it is JSON and as text otherwise. */
function parseBody(body: unknown): StreamEnvelope | undefined {
  const value: unknown = typeof body === 'string' ? JSON.parse(body) : body
  if (typeof value !== 'object' || value === null) return undefined
  const e = value as Partial<StreamEnvelope>
  if (typeof e.event_id !== 'string' || typeof e.name !== 'string' || typeof e.ts !== 'string' || typeof e.payload !== 'object' || e.payload === null) return undefined
  return e as StreamEnvelope
}

function asNumber(v: unknown): number | undefined {
  if (typeof v === 'number') return v
  if (typeof v === 'object' && v !== null && 'low' in v && 'high' in v) {
    const { low, high } = v as { low: number; high: number }
    return high * 2 ** 32 + (low >>> 0)
  }
  return undefined
}

async function ingest(messages: unknown[], context: InvocationContext): Promise<void> {
  const container = await hotContainer(context)
  const metadata = context.triggerMetadata ?? {}
  const partitionContext = metadata.partitionContext as { partitionId?: string } | undefined
  // The host hands sequence numbers over as 64-bit Long objects; render
  // them as plain numbers so the log line reads as one.
  const sequenceNumbers = (metadata.sequenceNumberArray as unknown[] | undefined)?.map(asNumber)
  const ingestedAt = new Date().toISOString()

  let upserted = 0
  let skipped = 0
  const failures: string[] = []
  for (let i = 0; i < messages.length; i++) {
    const envelope = parseBody(messages[i])
    if (!envelope || typeof envelope.payload.conversation_id !== 'string') {
      skipped++
      context.warn(JSON.stringify({ msg: 'message is not a conversation event; skipped', index: i, sequence_number: sequenceNumbers?.[i] }))
      continue
    }
    const doc: HotDocument = toHotDocument(envelope, ingestedAt, hotTtlSeconds)
    try {
      await container.items.upsert(doc)
      upserted++
    } catch (err) {
      failures.push(`${doc.id}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  context.log(JSON.stringify({
    msg: 'batch ingested', partition: partitionContext?.partitionId, messages: messages.length, upserted, skipped, failed: failures.length,
    first_sequence_number: sequenceNumbers?.[0], last_sequence_number: sequenceNumbers?.[sequenceNumbers.length - 1],
  }))
  if (failures.length > 0) {
    // Throwing keeps the checkpoint where it was, so the batch is delivered
    // again. The documents that did land are upserts, so the retry is safe.
    throw new Error(`hot store upsert failed for ${failures.length} message(s): ${failures.join('; ')}`)
  }
}

app.eventHub('ingestConversationEvents', {
  connection: 'EventHubConnection',
  eventHubName: process.env.EVENTHUB_NAME ?? 'conversation-events',
  consumerGroup: process.env.EVENTHUB_CONSUMER_GROUP ?? 'ingest',
  cardinality: 'many',
  handler: ingest,
})
