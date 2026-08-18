package conversation

import (
	"encoding/json"
	"fmt"

	"github.com/dsswift/ion/engine/internal/types"
)

// SlashInvocation captures the raw slash-command invocation that produced a
// user turn. The engine resolves and expands a slash command into the prompt
// the model sees, but the user must see the invocation they typed — so the
// LLM-visible content and the persisted/displayed content diverge. This struct
// is the display side of that split. All fields are provenance only; the engine
// attaches no behavior to them.
type SlashInvocation struct {
	// Command is the raw invocation including the leading slash, e.g. "/diagram".
	Command string
	// Args is the raw argument string the user typed after the command name.
	Args string
	// Source records where the template resolved from: "extension" | "ion" |
	// "claude" | "skill" | "project".
	Source string
	// ModelAlias is the model string from the command's frontmatter (`model:`).
	// Empty when the command declared no model hint.
	ModelAlias string
	// ModelEffective is the model the engine resolved for this run after
	// applying the frontmatter hint. Empty when no model was resolved.
	ModelEffective string
}

// AddUserMessageWithInvocation appends a user turn whose LLM-visible content
// (expanded) differs from its persisted display content (the raw invocation).
//
// expandedContent is what the model consumes: the resolved template body with
// $ARGUMENTS substituted. It is written to conv.Messages so the provider request
// and token accounting see the full instructions. inv carries the raw
// invocation the user typed; it is written onto the display entry in
// conv.Entries (the .tree.jsonl) as the entry Content plus the SlashCommand /
// SlashArgs / SlashSource provenance fields, so consumers render the command
// pill — not the expanded body — and so the invocation survives a reload from
// disk (the entry tree is the source of truth for plain-conversation scrollback).
//
// This mirrors the Messages-vs-Entries divergence that AddTransientUserMessage
// and the SuppressSystemMessages path already rely on; the difference is that
// here BOTH stores receive an entry (the LLM gets the expansion, the tree gets
// the invocation), rather than one store being skipped.
//
// Returns the *SessionEntry that AppendEntry produced (the display/tree entry
// carrying the raw invocation) so callers that need the entry id can thread it
// out. Returns nil when conv.Entries is nil. Additive: existing callers that
// ignore the return value are unaffected.
func AddUserMessageWithInvocation(conv *Conversation, expandedContent any, inv SlashInvocation) *SessionEntry {
	expandedBlocks := toContentBlocks(expandedContent)

	conv.lock()
	defer conv.unlock()

	// LLM sees the expanded template body.
	conv.Messages = append(conv.Messages, types.LlmMessage{Role: "user", Content: expandedBlocks})

	// The display/tree entry shows the raw invocation, with provenance.
	if conv.Entries != nil {
		display := inv.Command
		if inv.Args != "" {
			display = inv.Command + " " + inv.Args
		}
		entry := appendEntryLocked(conv, EntryMessage, MessageData{
			Role:                "user",
			Content:             []types.LlmContentBlock{textBlock(display)},
			LlmContent:          expandedBlocks,
			SlashCommand:        inv.Command,
			SlashArgs:           inv.Args,
			SlashSource:         inv.Source,
			SlashModelAlias:     inv.ModelAlias,
			SlashModelEffective: inv.ModelEffective,
		}, "")
		conv.Messages[len(conv.Messages)-1].EntryID = entry.ID
		return entry
	}
	return nil
}

// toContentBlocks normalizes the loosely-typed content argument (string or
// []LlmContentBlock) into a content-block slice. Shared by AddUserMessage and
// AddUserMessageWithInvocation so the coercion rule stays in one place.
func toContentBlocks(content any) []types.LlmContentBlock {
	switch c := content.(type) {
	case string:
		return []types.LlmContentBlock{textBlock(c)}
	case []types.LlmContentBlock:
		return c
	case []any:
		data, err := json.Marshal(c)
		if err != nil {
			return []types.LlmContentBlock{textBlock(fmt.Sprint(c))}
		}
		var blocks []types.LlmContentBlock
		if err := json.Unmarshal(data, &blocks); err != nil {
			return []types.LlmContentBlock{textBlock(fmt.Sprint(c))}
		}
		return blocks
	default:
		return []types.LlmContentBlock{textBlock(fmt.Sprint(c))}
	}
}

// AddTransientUserMessage appends a user message to the in-memory conversation
// for the current API call but does NOT persist it to the session entry list.
// Used when SuppressSystemMessages is enabled: the LLM sees the message, but
// it won't appear in session history on reload.
func AddTransientUserMessage(conv *Conversation, content string) {
	blocks := []types.LlmContentBlock{textBlock(content)}
	conv.lock()
	defer conv.unlock()
	conv.Messages = append(conv.Messages, types.LlmMessage{Role: "user", Content: blocks, Transient: true})
}

// AddContextInjectionMessage appends a read-triggered nested-context injection
// block carries the rendered "# Context from <path>" body the model sees plus
// the structured ContextPaths the dedup seeder reads back.
//
// transient controls persistence, mirroring the AddUserMessage /
// AddTransientUserMessage split: when true (SuppressSystemMessages), the block
// is appended to conv.Messages only, so the model sees it this turn but it does
// not survive reload; when false, it is also written to the entry tree so the
// injection (and its ContextPaths) round-trips through persistence and the
// seeder recovers it on the next session.
func AddContextInjectionMessage(conv *Conversation, paths []string, renderedText string, transient bool) {
	msg := BuildContextInjectionMessage(paths, renderedText)
	msg.Transient = transient
	conv.lock()
	defer conv.unlock()
	conv.Messages = append(conv.Messages, msg)
	if transient {
		return
	}
	blocks, _ := msg.Content.([]types.LlmContentBlock) //nolint:errcheck // non-slice content yields nil blocks, handled below
	if conv.Entries != nil {
		entry := appendEntryLocked(conv, EntryMessage, MessageData{Role: "user", Content: blocks}, "")
		conv.Messages[len(conv.Messages)-1].EntryID = entry.ID
	}
}

// AddAssistantMessage appends an assistant message with usage tracking.
func AddAssistantMessage(conv *Conversation, blocks []types.LlmContentBlock, usage types.LlmUsage) {
	AddAssistantMessageWithEntryID(conv, blocks, usage, "")
}

// AddAssistantMessageNoUsage appends an assistant message that carries NO
// provider accounting. This is the correct funnel for turns Ion persists on a
// backend's behalf without token data — delegated-CLI turns copied into Ion's
// transcript at run exit. Annotating those with a zero-valued LlmUsage{} is
// what poisoned GetContextUsage's backward scan (the zero struct read as "the
// provider says ~0 tokens"), so this variant leaves Usage nil on both the
// message and the persisted entry.
func AddAssistantMessageNoUsage(conv *Conversation, blocks []types.LlmContentBlock) {
	conv.lock()
	defer conv.unlock()
	conv.Messages = append(conv.Messages, types.LlmMessage{Role: "assistant", Content: blocks})

	if conv.Entries != nil {
		entry := appendEntryLocked(conv, EntryMessage, MessageData{Role: "assistant", Content: blocks}, "")
		conv.Messages[len(conv.Messages)-1].EntryID = entry.ID
	}
}

// AddAssistantMessageWithEntryID is AddAssistantMessage with a pre-minted
// entry id. The runloop mints the id before emitting message_end so consumers
// can re-key their live-streamed assistant rows to the canonical persisted
// identity; passing the same id here guarantees the persisted entry matches
// what already went out on the wire. An empty entryID generates a fresh one.
func AddAssistantMessageWithEntryID(conv *Conversation, blocks []types.LlmContentBlock, usage types.LlmUsage, entryID string) {
	conv.lock()
	defer conv.unlock()
	conv.Messages = append(conv.Messages, types.LlmMessage{Role: "assistant", Content: blocks})
	// Track total context size including cached tokens. The API's input_tokens
	// field only counts non-cached tokens; cache_read and cache_creation must
	// be added to get the actual context window consumption.
	totalInput := usage.InputTokens + usage.CacheReadInputTokens + usage.CacheCreationInputTokens
	conv.TotalInputTokens += totalInput
	conv.TotalOutputTokens += usage.OutputTokens
	conv.Messages[len(conv.Messages)-1].Usage = &usage

	if conv.Entries != nil {
		entry := appendEntryLocked(conv, EntryMessage, MessageData{Role: "assistant", Content: blocks, Usage: &usage}, entryID)
		conv.Messages[len(conv.Messages)-1].EntryID = entry.ID
	}
}
