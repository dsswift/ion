package backend

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"sort"
	"sync"

	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// prompt_prefix.go — a record of each conversation's prompt prefix, so a
// change to it is visible in the log.
//
// A provider caches a prompt as a prefix: the model, the tool list, the system
// prompt, then the messages. When any of the first three differs from the
// previous run of the same conversation, the provider discards the cached
// conversation and rewrites all of it at the cache-write rate. Nothing fails
// when that happens; the run is just slower and several times more expensive.
// The only evidence is in token counts an operator has no reason to read.
//
// The tracker makes it a log line: every run records a fingerprint of each
// part, and a run whose fingerprint differs from the conversation's previous
// run says which part changed.

// prefixTrackerLimit bounds the tracker. It holds a few short hashes per
// conversation; when the bound is reached the record is dropped and rebuilt
// from the runs that follow.
const prefixTrackerLimit = 4096

// prefixTracker remembers the last prompt-prefix fingerprint per conversation.
type prefixTracker struct {
	mu   sync.Mutex
	last map[string]map[string]string
}

func newPrefixTracker() *prefixTracker {
	return &prefixTracker{last: make(map[string]map[string]string)}
}

// promptPrefixes is process-wide: a conversation's runs may be served by more
// than one backend instance.
var promptPrefixes = newPrefixTracker()

// observe records parts as the conversation's current fingerprint and returns
// the names of the parts that differ from its previous run, sorted. first is
// true when the tracker holds no previous run for the conversation.
func (t *prefixTracker) observe(conversationID string, parts map[string]string) (changed []string, first bool) {
	t.mu.Lock()
	defer t.mu.Unlock()
	prev, ok := t.last[conversationID]
	if !ok && len(t.last) >= prefixTrackerLimit {
		t.last = make(map[string]map[string]string)
	}
	t.last[conversationID] = parts
	if !ok {
		return nil, true
	}
	for name, hash := range parts {
		if prev[name] != hash {
			changed = append(changed, name)
		}
	}
	for name := range prev {
		if _, still := parts[name]; !still {
			changed = append(changed, name)
		}
	}
	sort.Strings(changed)
	return changed, false
}

// prefixHash is a short fingerprint of one prefix part.
func prefixHash(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:8])
}

// logPromptPrefix records a run's prompt prefix and logs it: at info every
// run, and at warn when a part changed since the conversation's previous run.
// backendKind names the backend for the log line.
func logPromptPrefix(backendKind, runID, conversationID string, parts map[string]string) {
	if conversationID == "" {
		return
	}
	fields := map[string]any{"backend": backendKind, "run_id": runID, "conversation_id": conversationID}
	for name, hash := range parts {
		fields[name] = hash
	}
	changed, first := promptPrefixes.observe(conversationID, parts)
	switch {
	case first:
		utils.LogWithFields(utils.LevelInfo, "backend.prompt_prefix", "prompt prefix recorded", fields)
	case len(changed) == 0:
		utils.LogWithFields(utils.LevelInfo, "backend.prompt_prefix", "prompt prefix unchanged since the previous run", fields)
	default:
		fields["changed"] = changed
		utils.LogWithFields(utils.LevelWarn, "backend.prompt_prefix", "prompt prefix changed since the previous run; the provider cache for this conversation is rewritten", fields)
	}
}

// observePromptPrefix fingerprints what an API run sends ahead of its
// messages.
func (b *ApiBackend) observePromptPrefix(run *activeRun, conversationID, model, system string, toolDefs []types.LlmToolDef, serverTools []map[string]any) {
	tools, err := json.Marshal(struct {
		Tools  []types.LlmToolDef `json:"tools"`
		Server []map[string]any   `json:"server"`
	}{toolDefs, serverTools})
	if err != nil {
		utils.LogWithFields(utils.LevelWarn, "backend.prompt_prefix", "tool list could not be fingerprinted", map[string]any{"run_id": run.requestID, "error": err.Error()})
		return
	}
	logPromptPrefix("api", run.requestID, conversationID, map[string]string{
		"model_hash":  prefixHash([]byte(model)),
		"system_hash": prefixHash([]byte(system)),
		"tools_hash":  prefixHash(tools),
	})
}

// cliPrefixVolatileFlags are claude CLI flags whose values change from run to
// run without changing the prompt the CLI sends: which session to resume, and
// the paths of per-session files.
var cliPrefixVolatileFlags = map[string]bool{
	"--resume":         true,
	"--mcp-config":     true,
	"--settings":       true,
	"--max-turns":      true,
	"--max-budget-usd": true,
}

// observeCliPromptPrefix fingerprints the spawn arguments that shape the
// prompt a claude-code run sends. The model's own tool list is the CLI's, but
// everything the engine contributes to it rides in these arguments: the
// system prompt, the tool-alias directive naming every bridged tool, and the
// allowed-tool list.
func observeCliPromptPrefix(runID, conversationID string, args []string) {
	logPromptPrefix("claude-code", runID, conversationID, cliPrefixParts(args))
}

// cliPrefixParts fingerprints the prompt-shaping spawn arguments.
func cliPrefixParts(args []string) map[string]string {
	parts := map[string]string{}
	var rest []string
	for i := 0; i < len(args); i++ {
		arg := args[i]
		if cliPrefixVolatileFlags[arg] {
			i++
			continue
		}
		switch arg {
		case "--model", "--system-prompt", "--append-system-prompt", "--allowedTools":
			if i+1 < len(args) {
				parts[arg[2:]+"_hash"] = prefixHash([]byte(args[i+1]))
				i++
			}
		default:
			rest = append(rest, arg)
		}
	}
	// Marshalling a []string cannot fail.
	other, _ := json.Marshal(rest) //nolint:errcheck // []string always marshals
	parts["other_args_hash"] = prefixHash(other)
	return parts
}
