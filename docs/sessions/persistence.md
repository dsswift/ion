---
title: Session Persistence
description: JSONL storage format, entry types, migration, and storage location.
sidebar_position: 3
---

# Session Persistence

Conversations are persisted to disk as JSONL files. Each file contains a metadata header followed by one line per conversation entry.

## Storage location

```
~/.ion/conversations/{sessionID}.jsonl
```

The directory is created automatically on first save. A custom directory can be passed to `Save` and `Load`, but the default is `~/.ion/conversations/`.

## File format

### JSONL (v2, current)

Line 1 is the metadata header. All subsequent lines are session entries.

**Header line:**

```json
{
  "meta": true,
  "id": "abc123",
  "version": 2,
  "model": "claude-sonnet-4-6",
  "system": "",
  "totalInputTokens": 45230,
  "totalOutputTokens": 12400,
  "lastInputTokens": 8100,
  "totalCost": 0.042,
  "createdAt": 1713800000000,
  "leafId": "a1b2c3d4"
}
```

**Entry lines:**

```json
{"id":"f0e1d2c3","parentId":"a1b2c3d4","type":"message","timestamp":1713800001000,"data":{"role":"user","content":"explain this code"}}
{"id":"b4a5c6d7","parentId":"f0e1d2c3","type":"message","timestamp":1713800002000,"data":{"role":"assistant","content":[{"type":"text","text":"..."}],"usage":{"input_tokens":1200,"output_tokens":340}}}
```

### JSON (v1, legacy)

Older conversations are stored as a single JSON file (`{sessionID}.json`). The engine tries JSONL first, then falls back to JSON on load.

## Session entry types

Each entry in the conversation tree has a type that determines how `data` is interpreted.

| Type | Data struct | Description |
|------|-------------|-------------|
| `message` | `MessageData` | A chat message (user, assistant, or tool results) |
| `compaction` | `CompactionData` | A compaction event replacing older messages with a summary |
| `model_change` | `ModelChangeData` | Records a model switch mid-conversation |
| `label` | `LabelData` | A label annotation on an entry (e.g., user bookmark) |
| `custom` | Arbitrary | Extension-defined entry types |

### MessageData

```go
type MessageData struct {
    Role    string     // "user" or "assistant"
    Content any        // string or []LlmContentBlock
    Usage   *LlmUsage // token counts (assistant messages only)
}
```

### CompactionData

```go
type CompactionData struct {
    Summary          string // text summary of compacted messages
    FirstKeptEntryID string // ID of the first entry after compaction
    TokensBefore     int    // token count before compaction
}
```

### ModelChangeData

```go
type ModelChangeData struct {
    Model         string // new model name
    PreviousModel string // previous model name
}
```

### LabelData

```go
type LabelData struct {
    TargetID string  // entry being labeled
    Label    *string // label text (nil to remove)
}
```

## SessionEntry structure

Every entry has the same envelope:

```go
type SessionEntry struct {
    ID        string           // 8-character hex ID (crypto/rand)
    ParentID  *string          // nil for root entries
    Type      SessionEntryType // message, compaction, model_change, label, custom
    Timestamp int64            // Unix milliseconds
    Data      any              // typed based on Type
}
```

Entry IDs are generated from 4 bytes of `crypto/rand`, encoded as hex (8 characters).

## Migration

The engine supports automatic migration from older formats:

**v0 to v1:** Adds the `version` field.

**v1 to v2:** Converts the flat `messages` array into tree entries. Each message becomes an entry chained by `parentId`. The last entry's ID becomes `leafId`.

Migration runs automatically on `Load`. The migrated conversation can be saved back to upgrade the file on disk.

## Token tracking

The conversation tracks cumulative token usage:

| Field | Description |
|-------|-------------|
| `TotalInputTokens` | Sum of all input tokens across all turns |
| `TotalOutputTokens` | Sum of all output tokens across all turns |
| `LastInputTokens` | Input tokens from the most recent LLM call |
| `TotalCost` | Running cost total in USD |

These values are updated by `AddAssistantMessage` and `UpdateCost`.
