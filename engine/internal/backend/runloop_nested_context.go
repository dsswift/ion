package backend

import (
	"fmt"
	"path/filepath"
	"strings"

	ioncontext "github.com/dsswift/ion/engine/internal/context"
	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// nestedContextMarkerPrefix is the per-file header the eager context injector
// (session.injectContextFiles) and the nested injector below both write:
//
//	# Context from <absolute-path>
//
// Seeding scans for this exact prefix to recover which context-file paths are
// already present in a conversation (system prompt + message history), so a
// reload never re-injects a file that is already there.
const nestedContextMarkerPrefix = "# Context from "

// drainNestedContext implements read-triggered nested context loading
// (progressive AGENTS.md/ION.md descent). It drains the paths tools touched
// since the last turn, walks the directories strictly below cwd on the path to
// each touched file, and injects any not-yet-seen instruction files once via
// the existing system-message path.
//
// Called at the top of the agent loop, before streamOpts is built, so freshly
// discovered subtree context reaches the model on the very next provider call.
// Honors opts.DisableNestedContext (hard off) and opts.ClaudeCompat (Claude
// files gated; Ion-native files always). cwd is the run's project path.
func (b *ApiBackend) drainNestedContext(
	run *activeRun,
	conv *conversation.Conversation,
	hooks RunHooks,
	opts types.RunOptions,
	cwd string,
	turn, maxTurns int,
) {
	if opts.DisableNestedContext {
		// Sink may still have entries; drain to keep it from growing unbounded,
		// but inject nothing.
		_ = run.touchedSink.DrainAndClear()
		utils.Debug("ApiBackend", fmt.Sprintf("nestedContext: disabled for run=%s, drained-and-discarded", run.requestID))
		return
	}
	if cwd == "" {
		_ = run.touchedSink.DrainAndClear()
		return
	}

	touched := run.touchedSink.DrainAndClear()
	if len(touched) == 0 {
		return
	}

	// Build the walker config once: same pattern tiers + gate as the eager
	// walk, home roots off (nested loading only descends under cwd), includes
	// processed via the @ directive.
	cfg := ioncontextPreset(opts.ClaudeCompat)

	// Collect new (not-yet-injected) files across all touched paths, in
	// discovery order, deduped within this drain via a local set layered on
	// top of the conversation-lifetime set.
	var newFiles []ioncontext.DiscoveredContext
	dirsWalked := 0
	dedupedCount := 0
	localSeen := make(map[string]bool)

	run.mu.Lock()
	if run.injectedNestedPaths == nil {
		run.injectedNestedPaths = make(map[string]bool)
	}
	for _, tp := range touched {
		discovered := ioncontext.WalkNestedContextDirs(cwd, tp, cfg)
		dirsWalked++
		for _, dc := range discovered {
			if run.injectedNestedPaths[dc.Path] || localSeen[dc.Path] {
				dedupedCount++
				continue
			}
			localSeen[dc.Path] = true
			newFiles = append(newFiles, dc)
		}
	}
	// Mark the new files as injected up front (under the same lock) so a
	// concurrent path could not double-count; injection itself happens after
	// the lock is released.
	for _, dc := range newFiles {
		run.injectedNestedPaths[dc.Path] = true
	}
	run.mu.Unlock()

	if len(newFiles) == 0 {
		utils.Debug("ApiBackend", fmt.Sprintf(
			"nestedContext: run=%s turn=%d drained=%d walked=%d new=0 deduped=%d (nothing to inject)",
			run.requestID, turn, len(touched), dirsWalked, dedupedCount))
		return
	}

	// Format exactly like the eager injector so the model sees a uniform
	// "# Context from <path>" block regardless of eager-vs-nested origin. The
	// rendered prose is what the model reads; the structured path list below
	// is what the dedup seeder reads back, so the two are tracked separately.
	var sb strings.Builder
	injectedPaths := make([]string, 0, len(newFiles))
	for _, dc := range newFiles {
		sb.WriteString("\n")
		sb.WriteString(nestedContextMarkerPrefix)
		sb.WriteString(dc.Path)
		sb.WriteString("\n")
		sb.WriteString(dc.Content)
		sb.WriteString("\n")
		injectedPaths = append(injectedPaths, dc.Path)
	}

	utils.Info("ApiBackend", fmt.Sprintf(
		"nestedContext: run=%s turn=%d drained=%d walked=%d new=%d deduped=%d injecting",
		run.requestID, turn, len(touched), dirsWalked, len(newFiles), dedupedCount))

	b.injectNestedContext(run, conv, hooks, opts, injectedPaths, sb.String(), turn, maxTurns)
}

// injectNestedContext persists a read-triggered nested-context injection as a
// typed context_injection block. It mirrors injectSystemMessage's gate-and-hook
// flow (DisableNestedContext gate, OnSystemInject hook with harness override /
// suppress) but writes the typed block via AddContextInjectionMessage so the
// injected paths survive reload as structured data — the precise dedup key the
// seeder recovers, instead of a "# Context from" prose substring.
//
// paths is the structured dedup key; renderedText is the human-readable body
// the model sees. A harness hook may rewrite the body (hookText); it cannot
// rewrite the paths, which are engine-internal provenance.
func (b *ApiBackend) injectNestedContext(
	run *activeRun,
	conv *conversation.Conversation,
	hooks RunHooks,
	opts types.RunOptions,
	paths []string,
	renderedText string,
	turn, maxTurns int,
) {
	if opts.DisableNestedContext {
		return
	}

	text := renderedText
	if hooks.OnSystemInject != nil {
		hookText, suppress := hooks.OnSystemInject("nested_context", renderedText, turn, maxTurns)
		if suppress {
			return
		}
		if hookText != "" {
			text = hookText
		}
	}

	conversation.AddContextInjectionMessage(conv, paths, text, opts.SuppressSystemMessages)
	if !opts.SuppressSystemMessages {
		if err := conversation.Save(conv, ""); err != nil {
			utils.Log("ApiBackend", "failed to save conversation after nested context inject: "+err.Error())
		}
	}
}

// ioncontextPreset returns the walker config for nested loading: the same
// Ion-native-always / Claude-gated pattern tiers as the eager IonPreset, with
// home roots disabled (nested descent stays strictly under cwd).
func ioncontextPreset(claudeCompat bool) ioncontext.WalkerConfig {
	cfg := ioncontext.IonPreset()
	cfg.ClaudeCompat = claudeCompat
	cfg.IncludeHomeRoots = false
	return cfg
}

// seedInjectedNestedPaths recovers the set of context-file paths already
// present in a conversation so the nested loader never re-injects them. It
// draws from two sources, each with the recovery method appropriate to it:
//
//   - The eager root/home walk writes its "# Context from <path>" blocks into
//     the SYSTEM PROMPT (opts.AppendSystemPrompt and conv.System). The system
//     prompt is a single engine-authored string with no arbitrary user content,
//     so scanning it for the marker prefix is a precise recovery — there is no
//     foreign text that could carry a colliding marker line.
//
//   - Prior-session nested injections live in conv.Messages as typed
//     context_injection blocks (AddContextInjectionMessage). These are
//     recovered STRUCTURALLY via CollectInjectedContextPaths, reading the
//     block's ContextPaths field. This is what makes the message-side seed
//     precise: a user or model message whose body merely contains a
//     "# Context from <path>" line carries no context_injection block and so
//     cannot poison the seed. (The previous implementation text-scanned every
//     message body, which a colliding marker line could falsely seed.)
//
// Returns a fresh set; the caller assigns it to run.injectedNestedPaths under
// run.mu.
func seedInjectedNestedPaths(conv *conversation.Conversation, opts types.RunOptions) map[string]bool {
	seen := make(map[string]bool)
	if conv == nil {
		return seen
	}
	// System-prompt recovery: precise text scan over engine-authored strings.
	collectMarkers(opts.AppendSystemPrompt, seen)
	collectMarkers(conv.System, seen)
	// Message-side recovery: structural, from typed context_injection blocks.
	for p := range conversation.CollectInjectedContextPaths(conv) {
		seen[p] = true
	}
	return seen
}

// collectMarkers scans text line-by-line for "# Context from <path>" and adds
// each path to seen. Paths are stored cleaned (filepath.Clean) so they compare
// equal to WalkNestedContextDirs output, which joins cleaned components.
func collectMarkers(text string, seen map[string]bool) {
	if text == "" {
		return
	}
	for _, line := range strings.Split(text, "\n") {
		trimmed := strings.TrimSpace(line)
		if !strings.HasPrefix(trimmed, nestedContextMarkerPrefix) {
			continue
		}
		p := strings.TrimSpace(strings.TrimPrefix(trimmed, nestedContextMarkerPrefix))
		if p == "" {
			continue
		}
		seen[filepath.Clean(p)] = true
	}
}
