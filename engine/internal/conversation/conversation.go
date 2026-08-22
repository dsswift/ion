package conversation

import (
	"sync"

	"github.com/dsswift/ion/engine/internal/types"
)

// CurrentVersion is the schema version for new conversations.
const CurrentVersion = 2

// DefaultContext is the default context window size in tokens.
// Auto-compaction triggers below this — see AutoCompactTokenLimit, which
// reserves room for the next response and for the compaction summary itself.
const DefaultContext = 200000

// SessionEntryType identifies the kind of tree entry.
type SessionEntryType string

const (
	EntryMessage       SessionEntryType = "message"
	EntryCompaction    SessionEntryType = "compaction"
	EntryModelChange   SessionEntryType = "model_change"
	EntryLabel         SessionEntryType = "label"
	EntryCustom        SessionEntryType = "custom"
	EntryAgentDispatch SessionEntryType = "agent_dispatch"
	// EntryDispatchError records a terminal dispatch failure discovered after
	// the child backend's final save (for example code 0 + signal "cancelled"
	// mapped to an error by the dispatch lifecycle). It replays as a system-role
	// error row in scrollback and is excluded from provider-visible context.
	EntryDispatchError SessionEntryType = "dispatch_error"
	// EntryPlanMarker records a plan-file-written event so the "plan created /
	// updated" marker survives reload; it renders live via PlanFileWrittenEvent,
	// which is not persisted.
	EntryPlanMarker SessionEntryType = "plan_marker"
	// EntrySteerMarker records a steer-injection event so the steer marker
	// survives reload; it renders live via SteerInjectedEvent, which is not
	// persisted.
	EntrySteerMarker SessionEntryType = "steer_marker"
	// EntryCleared records a /clear checkpoint so the "── Cleared at ──"
	// divider survives reload. The live divider is synthesized by clients
	// from engine_command_result{command:"clear"}; without this entry there
	// is no persisted signal for flattenEntries to replay on reload.
	EntryCleared SessionEntryType = "cleared"
)

// MessageData holds a chat message entry.
type MessageData struct {
	Role       string          `json:"role"`
	Content    any             `json:"content"`              // display content: string or []types.LlmContentBlock
	LlmContent any             `json:"llmContent,omitempty"` // provider-visible content when it differs from display
	Usage      *types.LlmUsage `json:"usage,omitempty"`
	Model      string          `json:"model,omitempty"`
	StopReason string          `json:"stopReason,omitempty"`

	// SlashCommand carries the raw slash-command invocation (including the
	// leading slash, e.g. "/diagram") when this user turn originated from a
	// slash command that the engine resolved and expanded. It is a display /
	// provenance field only: the engine attaches no behavior to it. When set,
	// the LLM-visible content (in conv.Messages) is the EXPANDED template body,
	// while this entry's Content holds the raw invocation the user typed, so
	// consumers render the command pill instead of the expanded text. Empty for
	// ordinary prompts.
	SlashCommand string `json:"slashCommand,omitempty"`
	// SlashArgs carries the raw argument string the user typed after the command
	// name (the text that was substituted into $ARGUMENTS / appended). Display
	// provenance only. Empty when the command was invoked with no args.
	SlashArgs string `json:"slashArgs,omitempty"`
	// SlashSource records where the command template was resolved from:
	// "extension" | "ion" | "claude" | "skill" | "project". Display provenance
	// only; lets a consumer label the pill by origin. Empty for ordinary prompts.
	SlashSource string `json:"slashSource,omitempty"`
	// SlashModelAlias is the command-owned model selector from slash frontmatter
	// (`model:` key). Empty when no model selector was declared.
	SlashModelAlias string `json:"slashModelAlias,omitempty"`
	// SlashModelEffective is the concrete model selected to start this slash run
	// after tier and provider resolution. It never reflects conversation picker
	// state when SlashModelAlias is set.
	SlashModelEffective string `json:"slashModelEffective,omitempty"`

	// DisplayOnly marks an entry that belongs in the tree/scrollback (so the
	// user sees it and it survives reload) but must NOT be reconstructed into
	// the LLM context by BuildContextPath. The canonical use is the `context:
	// fork` slash path: the parent conversation records the raw invocation as a
	// display turn so the user sees what they ran, but the parent's model never
	// consumed it (the expansion ran in a forked child). Without this flag,
	// saveSplit → BuildContextPath would resurrect the raw invocation as a user
	// message in the parent's .llm.jsonl on the next save, poisoning the parent's
	// context with a turn the model never saw. Default false: an ordinary entry
	// is part of the LLM context. Additive (omitempty) — absent on every legacy
	// entry, which correctly reconstructs as before.
	DisplayOnly bool `json:"displayOnly,omitempty"`

	// InjectionKind classifies the origin of an engine-side injected user
	// turn. See types.InjectionKind for the enumerated set. Empty means an
	// ordinary user turn with no special classification. Additive (omitempty):
	// absent on every legacy entry, which correctly reads as an ordinary turn.
	InjectionKind string `json:"injectionKind,omitempty"`

	// DeliveryIDs identifies engine-owned deliveries represented by this message.
	// It is persistence metadata only: providers never receive it. A retry uses
	// these stable IDs to avoid adding an already-injected completion twice.
	DeliveryIDs []string `json:"deliveryIds,omitempty"`

	// MachineAuthored reports whether an engine-side actor authored this turn
	// rather than a user, derived from InjectionKind at write time. Persisted
	// (rather than re-derived on read) so a consumer reloading history reads
	// the same classification the live event carried, without needing to know
	// the engine's kind taxonomy. Additive (omitempty): absent on legacy rows,
	// where the kind remains available as the fallback.
	MachineAuthored bool `json:"machineAuthored,omitempty"`
}

// CompactionData holds metadata about a compaction event. The enriched fields
// (MessagesBefore/After, ClearedBlocks, Strategy, MicroOnly) mirror the live
// CompactingEvent so the persisted compaction entry carries the same structured
// payload the live marker had. flattenEntries replays them as a system-role
// SessionMessage on historical reload. All enriched fields are additive
// (omitempty): legacy entries that lack them reload with zero values.
type CompactionData struct {
	Summary            string                  `json:"summary"`
	FirstKeptEntryID   string                  `json:"firstKeptEntryId"`
	TokensBefore       int                     `json:"tokensBefore"`
	MessagesSummarized int                     `json:"messagesSummarized,omitempty"`
	MessagesBefore     int                     `json:"messagesBefore,omitempty"`
	MessagesAfter      int                     `json:"messagesAfter,omitempty"`
	ClearedBlocks      int                     `json:"clearedBlocks,omitempty"`
	Strategy           string                  `json:"strategy,omitempty"`
	MicroOnly          bool                    `json:"microOnly,omitempty"`
	FactCount          int                     `json:"factCount,omitempty"`
	RecentFiles        []string                `json:"recentFiles,omitempty"`
	RestoredSkills     []types.SkillInvocation `json:"restoredSkills,omitempty"`
}

// LabelData holds a label annotation on an entry.
type LabelData struct {
	TargetID string  `json:"targetId"`
	Label    *string `json:"label"`
}

// PlanMarkerData records a plan file written event for persistence and replay.
// It mirrors the live PlanFileWrittenEvent so flattenEntries can replay a
// "plan created / updated" marker on historical reload.
type PlanMarkerData struct {
	Operation    string `json:"operation"` // "created" | "updated"
	PlanFilePath string `json:"planFilePath"`
	PlanSlug     string `json:"planSlug"`
}

// SteerMarkerData records a steer injection event for persistence and replay.
// It mirrors the live SteerInjectedEvent so flattenEntries can replay a steer
// marker on historical reload.
type SteerMarkerData struct {
	MessageLength int `json:"messageLength"`
}

// ClearedData records a /clear checkpoint for persistence and replay.
// It carries no payload beyond the timestamp embedded in the tree entry
// itself — the only signal flattenEntries needs is that a clear occurred
// at a specific point in the tree so clients can replay the divider.
type ClearedData struct{}

// ModelChangeData records a model switch.
type ModelChangeData struct {
	Model         string `json:"model"`
	PreviousModel string `json:"previousModel,omitempty"`
}

// AgentDispatchData records a completed agent dispatch for persistence.
type AgentDispatchData struct {
	AgentName       string                   `json:"agentName"`
	AgentID         string                   `json:"agentId"`
	DisplayName     string                   `json:"displayName,omitempty"`
	Task            string                   `json:"task,omitempty"`
	Model           string                   `json:"model,omitempty"`
	Status          string                   `json:"status"`
	Elapsed         float64                  `json:"elapsed,omitempty"`
	ConversationID  string                   `json:"conversationId,omitempty"`
	ConversationIDs []string                 `json:"conversationIds,omitempty"`
	Dispatches      []map[string]interface{} `json:"dispatches,omitempty"`
	// DispatchDepth is the nesting depth of this dispatch from the root run
	// (0 for a top-level dispatch, 1 for its child, etc.). Persisted so the
	// depth attribution survives an engine restart and can be rehydrated onto
	// the agent-state row.
	DispatchDepth int `json:"dispatchDepth,omitempty"`
	// DispatchParentID is the dispatch id of the agent that spawned this one
	// (empty for a top-level dispatch). Persisted so the parent linkage
	// survives an engine restart and can be rehydrated onto the agent-state row.
	DispatchParentID string `json:"dispatchParentId,omitempty"`
	// LostNoticeState tracks durable lost-dispatch delivery: "", "pending", or "sent".
	LostNoticeState string `json:"lostNoticeState,omitempty"`
	// RecallIntent prevents recalled dispatches from being announced as restart losses.
	RecallIntent bool `json:"recallIntent,omitempty"`
}

// SessionEntry is a single node in the conversation tree.
type SessionEntry struct {
	ID        string           `json:"id"`
	ParentID  *string          `json:"parentId"`
	Type      SessionEntryType `json:"type"`
	Timestamp int64            `json:"timestamp"`
	Data      any              `json:"data"`
}

// TreeNode is a tree representation of entries for visualization.
type TreeNode struct {
	Entry    SessionEntry `json:"entry"`
	Children []TreeNode   `json:"children"`
}

// Conversation is the top-level session object.
type Conversation struct {
	ID                string             `json:"id"`
	System            string             `json:"system"`
	Model             string             `json:"model"`
	Messages          []types.LlmMessage `json:"messages"`
	TotalInputTokens  int                `json:"totalInputTokens"`
	TotalOutputTokens int                `json:"totalOutputTokens"`
	TotalCost         float64            `json:"totalCost"`
	CreatedAt         int64              `json:"createdAt"`
	Version           int                `json:"version,omitempty"`
	ParentID          string             `json:"parentId,omitempty"`
	Entries           []SessionEntry     `json:"entries,omitempty"`
	LeafID            *string            `json:"leafId"`
	WorkingDirectory  string             `json:"workingDirectory,omitempty"`

	// Backend records which run backend produced this conversation ("api"
	// today; CLI kinds if delegated backends ever write the Ion store).
	// Additive: legacy files decode with "" and consumers treat "" as api,
	// since only the API backend has ever written Ion conversation files.
	// Lets a consumer assert the history format per conversation instead of
	// inferring it from a global mode.
	Backend string `json:"backend,omitempty"`

	// DispatchTranscriptMirror marks an Ion-owned mirror of a native child
	// session. Native backends may reuse their external session ID; a later
	// dispatch must append to this mirror, while a genuine engine-owned child
	// conversation remains authoritative and disables mirror recording.
	DispatchTranscriptMirror bool `json:"dispatchTranscriptMirror,omitempty"`

	// NativeSessions maps a delegated-CLI backend kind ("claude-code",
	// "codex", "grok", "cursor") to the native-session cursor captured at
	// the exit of the last run this conversation completed on that backend.
	// A cursor is a disposable per-provider CACHE over Ion's transcript: it
	// is valid for native resume only while HeadEntryID still equals the
	// conversation's LeafID (no other writer advanced the transcript since
	// capture). Stale or absent cursors are discarded and the next run on
	// that backend re-bridges from the transcript instead. Persisted in the
	// .tree.jsonl header (additive, omitempty) so continuity survives an
	// engine restart. See session/native_session.go for capture/decide.
	NativeSessions map[string]NativeSessionCursor `json:"nativeSessions,omitempty"`

	// ActiveRun is a durable journal for one accepted root run. It shares the
	// tree header's atomic write with the transcript, so recovery never has to
	// reconcile a sidecar against conversation history after a daemon restart.
	// Nil means no work is pending recovery.
	ActiveRun *RunJournalEntry `json:"activeRun,omitempty"`
	// RecoveryRepairVersion records completion of precise legacy recovery
	// repairs. Optional for old conversations; zero means repair has not run.
	RecoveryRepairVersion int `json:"recoveryRepairVersion,omitempty"`
	// _recoveryRepairPending is set while decoding an old file. Load persists the
	// version through UpdateOnDisk before returning so later loads skip the sweep.
	_recoveryRepairPending bool

	// _isLegacy is set by Load when reading a legacy .jsonl or .json file.
	// Save reads this flag to decide whether to unlink the legacy file after
	// writing the new split format. Not JSON-tagged — never persisted.
	_isLegacy bool

	// mu serializes access to Entries, LeafID, and Messages. A live
	// conversation is mutated from multiple goroutines (runloop appends,
	// plan/steer markers inside parallel tool goroutines, Save from the
	// signal-handler flush). Unexported — encoding/json ignores it, so the
	// persisted shape is unchanged. See lock.go for the locking discipline.
	mu sync.Mutex
}

// NativeSessionCursor is one delegated-CLI backend's resumable native-session
// handle, position-tagged against Ion's conversation tree. Cursor is the
// backend-native resume id (claude session UUID / codex thread id / ACP
// session id). HeadEntryID is the conversation's LeafID at capture time — the
// validity tag: the cursor may feed a native resume only while it still
// equals the live LeafID, proving no other provider (or /clear, rewind, tree
// navigation) advanced the transcript since this backend last saw it.
type NativeSessionCursor struct {
	Cursor      string `json:"cursor"`
	HeadEntryID string `json:"headEntryId"`
}

// ContextUsageInfo describes current context window consumption.
type ContextUsageInfo struct {
	Percent   int  `json:"percent"`
	Tokens    int  `json:"tokens"`
	Limit     int  `json:"limit"`
	Estimated bool `json:"estimated"`
}
