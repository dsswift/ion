package conversation

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"time"

	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// ToolResultEntry is a tool result to add as a user message.
type ToolResultEntry struct {
	ToolUseID string `json:"tool_use_id"`
	Content   string `json:"content"`
	// PersistContent, when non-empty, replaces Content in the persisted
	// entry tree while Content is still what the provider sees for the
	// current turn. Empty (the default) means "persist Content verbatim",
	// which is the behavior every caller had before this field existed.
	//
	// This exists for tool results whose text is only TRUE for the turn
	// that produced it. The motivating case is the EnterPlanMode sentinel
	// (runloop_plan_mode_gates.go): its result carries the full plan-mode
	// framing, including "You are in planning mode. You MUST NOT make any
	// edits ... This overrides any conflicting instructions you have
	// received elsewhere in this prompt or conversation." That is correct
	// guidance for the turn it lands on, and a lie on every later turn
	// after the mode has been exited — but it is persisted history, so the
	// model re-reads it as ground truth and declines to re-enter plan mode
	// ("Do NOT call this tool if: You are already in plan mode"), narrating
	// the transition instead of invoking it.
	//
	// A tool result cannot simply be dropped from history the way a
	// transient injected message can: every persisted tool_use requires a
	// matching tool_result on reload, or the provider rejects the request
	// (see the ordering contract on AddToolResults below). So the fix is to
	// persist a SHORTER, still-true statement rather than nothing at all.
	//
	// Same reasoning as the AddUserMessage / AddTransientUserMessage split
	// and the transient parameter on AddContextInjectionMessage: the engine
	// already distinguishes "the model sees this now" from "this belongs in
	// history". This field extends that distinction to tool results, which
	// previously had no way to express it.
	PersistContent   string               `json:"persist_content,omitempty"`
	IsError          bool                 `json:"is_error,omitempty"`
	Images           []*types.ImageSource `json:"images,omitempty"` // durable vision images to attach alongside text
	BackgroundTaskID string               `json:"background_task_id,omitempty"`
	// EphemeralImages are provider input for only this live turn. They are never
	// copied into the entry tree or serialized into conversation history.
	EphemeralImages []*types.ImageSource `json:"-"`
	// SkillInvocation is populated only by the built-in Skill tool. It is
	// converted into typed skill_content after provider-required tool-result
	// blocks, while the compact PersistContent remains durable history.
	SkillInvocation *types.SkillInvocation `json:"-"`
}

// ContextFile is a discovered context file on disk.
type ContextFile struct {
	Path    string
	Content string
}

// GenEntryID generates an 8-character hex ID from crypto/rand.
func GenEntryID() string {
	b := make([]byte, 4)
	if _, err := rand.Read(b); err != nil {
		panic("crypto/rand failed: " + err.Error())
	}
	return hex.EncodeToString(b)
}

func nowMillis() int64 {
	return time.Now().UnixMilli()
}

// textBlock creates a text content block.
func textBlock(text string) types.LlmContentBlock {
	return types.LlmContentBlock{Type: "text", Text: text}
}

// CreateConversation initializes a new v2 conversation.
func CreateConversation(id, system, model string) *Conversation {
	return &Conversation{
		ID:        id,
		System:    system,
		Model:     model,
		Messages:  []types.LlmMessage{},
		CreatedAt: nowMillis(),
		Version:   CurrentVersion,
		Entries:   []SessionEntry{},
		LeafID:    nil,
	}
}

// AddUserMessage appends a user message to the conversation. The same content
// becomes both the LLM-visible message (conv.Messages) and the persisted
// display entry (conv.Entries) — the right behavior for an ordinary prompt
// where what the user typed and what the model sees are identical.
//
// Returns the *SessionEntry that AppendEntry produced (the display/tree entry)
// so callers that need the entry id can thread it out. Returns nil when
// conv.Entries is nil (the LLM-only path that skips the tree write).
// Additive: existing callers that ignore the return value are unaffected.
func AddUserMessage(conv *Conversation, content any) *SessionEntry {
	blocks := toContentBlocks(content)

	conv.lock()
	defer conv.unlock()
	conv.Messages = append(conv.Messages, types.LlmMessage{Role: "user", Content: blocks})

	if conv.Entries != nil {
		entry := appendEntryLocked(conv, EntryMessage, MessageData{Role: "user", Content: blocks}, "")
		conv.Messages[len(conv.Messages)-1].EntryID = entry.ID
		return entry
	}
	return nil
}

// AddUserMessageWithDeliveryIDs adds one classified user message atomically and
// returns false when every delivery ID is already represented in the persisted
// tree. All supplied IDs map to one message, so a retry cannot duplicate a
// batch of child completions.
func AddUserMessageWithDeliveryIDs(conv *Conversation, content any, kind string, deliveryIDs []string) bool {
	if len(deliveryIDs) == 0 {
		AddUserMessageWithKind(conv, content, kind)
		return true
	}
	blocks := toContentBlocks(content)
	wanted := make(map[string]struct{}, len(deliveryIDs))
	for _, id := range deliveryIDs {
		wanted[id] = struct{}{}
	}

	conv.lock()
	defer conv.unlock()
	for _, entry := range conv.Entries {
		message, ok := entry.Data.(MessageData)
		if !ok {
			continue
		}
		for _, id := range message.DeliveryIDs {
			delete(wanted, id)
		}
	}
	if len(wanted) == 0 {
		return false
	}

	conv.Messages = append(conv.Messages, types.LlmMessage{Role: "user", Content: blocks})
	if conv.Entries != nil {
		ids := make([]string, 0, len(wanted))
		for _, id := range deliveryIDs {
			if _, remains := wanted[id]; remains {
				ids = append(ids, id)
			}
		}
		entry := appendEntryLocked(conv, EntryMessage, MessageData{
			Role:            "user",
			Content:         blocks,
			InjectionKind:   kind,
			MachineAuthored: types.InjectionKind(kind).IsMachineToMachine(),
			DeliveryIDs:     ids,
		}, "")
		conv.Messages[len(conv.Messages)-1].EntryID = entry.ID
	}
	return true
}

// HasDeliveryID scans the conversation's persisted entries for a message
// carrying the given delivery ID. Used by the dispatch layer to enforce
// idempotent prompt submission before a run starts.
func HasDeliveryID(conv *Conversation, id string) bool {
	if id == "" {
		return false
	}
	conv.lock()
	defer conv.unlock()
	for _, entry := range conv.Entries {
		message, ok := entry.Data.(MessageData)
		if !ok {
			continue
		}
		for _, did := range message.DeliveryIDs {
			if did == id {
				return true
			}
		}
	}
	return false
}

// AddUserMessageWithDisplay appends a user turn whose provider-visible content
// differs from its persisted display content. Both values are durable:
// BuildContextPath reconstructs the provider history from LlmContent, while
// clients receive Content when they load the transcript.
func AddUserMessageWithDisplay(conv *Conversation, llmContent, displayContent any) *SessionEntry {
	llmBlocks := toContentBlocks(llmContent)
	displayBlocks := toContentBlocks(displayContent)

	conv.lock()
	defer conv.unlock()
	conv.Messages = append(conv.Messages, types.LlmMessage{Role: "user", Content: llmBlocks})
	if conv.Entries != nil {
		entry := appendEntryLocked(conv, EntryMessage, MessageData{
			Role:       "user",
			Content:    displayBlocks,
			LlmContent: llmBlocks,
		}, "")
		conv.Messages[len(conv.Messages)-1].EntryID = entry.ID
		return entry
	}
	return nil
}

// AddUserMessageWithKind is the kind-aware variant of AddUserMessage. It
// stamps InjectionKind on the persisted entry, plus the MachineAuthored flag
// derived from it, so consumers can classify the injection on historical
// reload without knowing the engine's kind taxonomy. An empty kind is
// identical to calling AddUserMessage.
func AddUserMessageWithKind(conv *Conversation, content any, kind string) *SessionEntry {
	if kind == "" {
		return AddUserMessage(conv, content)
	}
	blocks := toContentBlocks(content)

	conv.lock()
	defer conv.unlock()
	conv.Messages = append(conv.Messages, types.LlmMessage{Role: "user", Content: blocks})

	if conv.Entries != nil {
		entry := appendEntryLocked(conv, EntryMessage, MessageData{
			Role:    "user",
			Content: blocks,

			InjectionKind: kind,
			// Derived once here, at the single write seam for classified
			// injections, rather than by each reader re-deriving it from the
			// kind string.
			MachineAuthored: types.InjectionKind(kind).IsMachineToMachine(),
		}, "")
		conv.Messages[len(conv.Messages)-1].EntryID = entry.ID
		return entry
	}
	return nil
}

// ClassifyEntry stamps an injection classification onto an already-appended
// user entry, deriving MachineAuthored from the kind exactly as the
// kind-bearing constructors do.
//
// This exists because classification is ORTHOGONAL to content shape. A
// persisted user turn's shape is chosen by its provenance — a slash expansion,
// image attachments, a background-work payload, plain text — while its kind
// says who authored it. The two are independently true: a machine-authored
// recovery continuation can carry the attachments of the run it resumes, and a
// classified injection can carry a slash expansion.
//
// Collapsing them into one mutually-exclusive choice is what broke: the kind
// was a competing switch arm, so any injected turn that also had attachments
// took the attachment arm and persisted with no kind and no MachineAuthored.
// Both clients suppress on those two fields, so the engine's steering messages
// reloaded as user turns in the transcript.
//
// A no-op when kind is empty, and it never overwrites a kind the constructor
// already set — the background-work payload is authoritative for its own
// delivery.
func ClassifyEntry(entry *SessionEntry, kind string) {
	if entry == nil || kind == "" {
		return
	}
	md, ok := entry.Data.(MessageData)
	if !ok || md.InjectionKind != "" {
		return
	}
	md.InjectionKind = kind
	md.MachineAuthored = types.InjectionKind(kind).IsMachineToMachine()
	entry.Data = md
}

// SetImplementationPhase records the RunOptions decision on the persisted user
// turn. This applies after content-shape selection because implementation phase
// is provenance independent of slash expansion, attachments, and injections.
func SetImplementationPhase(entry *SessionEntry, implementationPhase bool) {
	if entry == nil || !implementationPhase {
		return
	}
	md, ok := entry.Data.(MessageData)
	if !ok {
		return
	}
	md.ImplementationPhase = true
	entry.Data = md
}

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
	// Frontmatter is the complete parsed command frontmatter at invocation time.
	// It includes extension-defined keys the engine does not interpret.
	Frontmatter map[string]any
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
			SlashFrontmatter:    cloneSlashFrontmatter(inv.Frontmatter),
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

// AddToolResults appends tool results as a user message with tool_result content blocks.
// All tool_result blocks are emitted first (in result order), then all image blocks
// (in result/image order). This ordering is load-bearing: the Anthropic API requires
// every tool_result in the post-tool_use user message to come immediately after the
// tool_use turn, so no image block may be interleaved between two tool_result blocks.
// With parallel tool calls where a non-final result carries an image, interleaving the
// image after its owning tool_result would separate a later tool_result from the
// tool_use turn and the API rejects the request ("tool_use ids were found without
// tool_result blocks immediately after"). Images still ride in the same user message,
// and each tool_result's text content (e.g. "[Image: foo.png]") keeps the image
// identifiable, so model comprehension is preserved.
func AddToolResults(conv *Conversation, results []ToolResultEntry) {
	var blocks []types.LlmContentBlock
	var imageBlocks []types.LlmContentBlock
	var ephemeralImageBlocks []types.LlmContentBlock
	// persistOverrides maps a block index in `blocks` to the text that should
	// be written to the entry tree instead of the block's live Content. Only
	// populated for results that set PersistContent; nil-safe and empty for
	// every existing caller, which keeps the persisted history byte-identical
	// to what it was before this field existed.
	var persistOverrides map[int]string
	for _, r := range results {
		isErr := r.IsError
		if r.PersistContent != "" {
			if persistOverrides == nil {
				persistOverrides = make(map[int]string, 1)
			}
			persistOverrides[len(blocks)] = r.PersistContent
		}
		blocks = append(blocks, types.LlmContentBlock{
			Type:      "tool_result",
			ToolUseID: r.ToolUseID,
			Content:   r.Content,
			IsError:   &isErr,
		})
		for _, img := range r.Images {
			imageBlocks = append(imageBlocks, types.LlmContentBlock{
				Type: "image",
				// Carry the owning tool call's id on the persisted image block.
				// Providers ignore ToolUseID on an image block (every provider
				// serialiser reads only Source for type=="image"), so this never
				// reaches the wire — but it is what lets flattenEntries associate
				// a reloaded image back to its tool message on historical reload.
				// Without it, images loaded from disk have no home and are dropped.
				ToolUseID: r.ToolUseID,
				Source:    img,
			})
		}
		for _, img := range r.EphemeralImages {
			ephemeralImageBlocks = append(ephemeralImageBlocks, types.LlmContentBlock{
				Type:      "image",
				ToolUseID: r.ToolUseID,
				Source:    img,
				Ephemeral: true,
			})
		}
	}
	for _, r := range results {
		for i := range blocks {
			if blocks[i].ToolUseID == r.ToolUseID && blocks[i].Type == "tool_result" {
				blocks[i].BackgroundTaskID = r.BackgroundTaskID
			}
		}
	}
	blocks = append(blocks, imageBlocks...)
	// Provider-required tool results stay first. The full Skill body follows as
	// typed content in this same carrier, so provider adapters never see two
	// consecutive user messages and history can distinguish instructions from
	// generic tool output.
	for _, r := range results {
		if r.SkillInvocation == nil || r.IsError || r.SkillInvocation.Name == "" || r.SkillInvocation.Content == "" {
			continue
		}
		blocks = append(blocks, types.LlmContentBlock{
			Type:           SkillContentBlockType,
			Text:           skillLoadingText(*r.SkillInvocation),
			SkillName:      r.SkillInvocation.Name,
			SkillSource:    r.SkillInvocation.Source,
			SkillInvokedAt: r.SkillInvocation.InvokedAt,
		})
		utils.LogWithFields(utils.LevelInfo, "conversation.skill", "skill invocation persisted", map[string]any{
			"name": r.SkillInvocation.Name, "source": r.SkillInvocation.Source,
			"content_len": len(r.SkillInvocation.Content),
		})
	}
	liveBlocks := append(append([]types.LlmContentBlock(nil), blocks...), ephemeralImageBlocks...)

	conv.lock()
	defer conv.unlock()
	conv.Messages = append(conv.Messages, types.LlmMessage{Role: "user", Content: liveBlocks})

	if conv.Entries != nil {
		// Deep-copy blocks so MicroCompact mutations on conv.Messages
		// cannot corrupt the persisted entry history.
		entryCopy := make([]types.LlmContentBlock, len(blocks))
		copy(entryCopy, blocks)
		// Apply PersistContent overrides to the COPY only, so the provider
		// still sees the full text on this turn while history stores the
		// shorter, still-true statement. See the field comment on
		// ToolResultEntry.PersistContent for why a tool result cannot simply
		// be omitted from history the way a transient message can.
		for idx, text := range persistOverrides {
			entryCopy[idx].Content = text
		}
		entry := appendEntryLocked(conv, EntryMessage, MessageData{Role: "user", Content: entryCopy}, "")
		_ = entry
		conv.Messages[len(conv.Messages)-1].EntryID = entry.ID
	}
}

// AddToolResultsWithSizeCheck appends tool results with an automatic size cap.
// Results exceeding maxChars are persisted to disk and replaced with a preview
// containing the first 2K characters plus a file path the model can Read.
// When maxChars <= 0, DefaultMaxToolResultChars is used.
func AddToolResultsWithSizeCheck(conv *Conversation, results []ToolResultEntry, convDir string, maxChars int) {
	for i := range results {
		replaced, persisted := PersistAndPreview(results[i].Content, results[i].ToolUseID, convDir, conv.ID, maxChars)
		if persisted {
			results[i].Content = replaced
		}
	}
	AddToolResults(conv, results)
}
