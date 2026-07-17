//go:build integration

package integration

// Integration tests for the v2 ion-meta extension. The v2 upgrade added
// six new tools, six specialist agents (plus the orchestrator), and
// wired the orchestrator spine (session_start/agent_start/agent_end/
// capability_*/on_error/session_end). These tests assert the new
// surfaces are present and the snapshot contract (`engine_agent_state`)
// is honoured.
//
// File-size note: this file lives next to ion_meta_test.go to keep the
// original tests intact (they assert the legacy 3-tool contract still
// holds). Adding v2 cases to the legacy file would push it close to
// the 1500-line test cap.

import (
	"os"
	"strings"
	"sync"
	"testing"

	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/types"
)

// ─── Tools: v2 extension registers nine tools, not three ───

func TestIonMetaV2_RegistersNineTools(t *testing.T) {
	requireEsbuild(t)
	metaDir := ionMetaDir(t)
	entry := ionMetaEntry(t)

	host := extension.NewHost()
	t.Cleanup(func() { host.Dispose() })

	if err := host.Load(entry, &extension.ExtensionConfig{
		ExtensionDir:     metaDir,
		WorkingDirectory: "/tmp",
	}); err != nil {
		t.Fatalf("Load ion-meta: %v", err)
	}

	expected := []string{
		// v1 tools, kept.
		"ion_scaffold",
		"ion_validate_agent",
		"ion_list_hooks",
		// v2 additions.
		"ion_list_extensions",
		"ion_inspect_extension",
		"ion_list_sdk_methods",
		"ion_read_doc",
		"ion_validate_manifest",
		"ion_typecheck_extension",
	}
	tools := host.Tools()
	got := toolNames(tools)
	gotSet := make(map[string]struct{}, len(got))
	for _, name := range got {
		gotSet[name] = struct{}{}
	}
	for _, want := range expected {
		if _, ok := gotSet[want]; !ok {
			t.Errorf("missing tool %q. registered: %v", want, got)
		}
	}
	if len(got) < len(expected) {
		t.Errorf("expected at least %d tools, got %d: %v", len(expected), len(got), got)
	}
}

// ─── Persona: contains hook count, SDK methods, capability caveat ───

func TestIonMetaV2_PersonaIncludesV2Sections(t *testing.T) {
	requireEsbuild(t)
	metaDir := ionMetaDir(t)
	entry := ionMetaEntry(t)

	host := extension.NewHost()
	t.Cleanup(func() { host.Dispose() })

	if err := host.Load(entry, &extension.ExtensionConfig{
		ExtensionDir:     metaDir,
		WorkingDirectory: "/tmp",
	}); err != nil {
		t.Fatalf("Load: %v", err)
	}

	ctx := &extension.Context{Cwd: "/tmp"}

	prompt, system, err := host.FireBeforePrompt(ctx, "test prompt")
	if err != nil {
		t.Fatalf("FireBeforePrompt: %v", err)
	}
	if prompt != "test prompt" {
		t.Errorf("expected prompt unchanged, got %q", prompt)
	}

	// Persona MUST contain markers from each section. If any one of
	// these is missing it indicates the persona builder dropped a
	// section -- which is a regression worth catching loudly.
	mustContain := []string{
		"Ion Meta orchestrator",  // orchestrator body
		"createIon",              // SDK shape section
		"Canonical hook catalog", // hook catalog section
		"IonContext methods",     // SDK methods section
		"dispatchAgent",          // a specific method from the SDK
		"engine_agent_state",     // snapshot-contract reference
		"Engine CLI verbs",       // CLI section
		// Consumer-perspective boundary (replaces the old
		// "Engine-vs-harness boundary" framing which was internal
		// engine-team discipline, not consumer-facing).
		"What you own vs. what the engine handles", // sectionEngineBoundary()
		"ion_list_hooks",       // tool list
		"ion_read_doc",         // v2 tool
		"ion_list_sdk_methods", // v2 tool
		// Three-mode rework markers. If the persona drops the
		// intent-routing section the orchestrator can't classify;
		// if it drops the seams section the harness loses its
		// canonical statement of Ion's defining property.
		"Intent routing",     // sectionIntentRouting()
		"deterministic code", // sectionDeterministicSeams()
		"probabilistic",      // sectionDeterministicSeams()
		"ion-tutor",          // tutor mode agent named
		"extension-improver", // improver mode agent named
		"extension-builder",  // builder mode agent named
		"ADR-006",            // seams ADR cited
	}
	// Anti-markers: phrases that should NOT appear in the persona
	// because they leak engine-contributor framing into a consumer-
	// facing tool. If any of these regress, fail loudly with a
	// pointer to the right framing.
	mustNotContain := []string{
		// Contract-additivity is an engine-development discipline,
		// not something a consumer of the engine is in a position to
		// observe or enforce. A consumer doesn't write hooks; they
		// consume them.
		"Contracts are additive",
		"never rename a hook",
		"published contract",
		// "Engine-vs-harness boundary" as a section title was the
		// previous engine-team framing. The consumer-perspective
		// replacement ("What you own vs. what the engine handles")
		// is the new marker (asserted positively above).
		"Engine-vs-harness boundary",
		// "The engine ships zero policy" is internal triage language.
		// A consumer doesn't care that the engine ships zero policy;
		// they care what surface is available to them.
		"engine ships zero policy",
	}
	for _, needle := range mustContain {
		if !strings.Contains(system, needle) {
			t.Errorf("persona missing expected marker %q", needle)
		}
	}
	for _, banned := range mustNotContain {
		if strings.Contains(system, banned) {
			t.Errorf("persona contains banned engine-contributor phrase %q. "+
				"ion-meta is for consumers building on top of the engine, not "+
				"for working on the engine itself — frame from the consumer's "+
				"seat. See greeting.ts authoring rules and persona.ts "+
				"sectionEngineBoundary comment for the policy.", banned)
		}
	}
}

// ─── Agent-state contract: session_start emits a complete snapshot ───

func TestIonMetaV2_SessionStartEmitsAgentSnapshot(t *testing.T) {
	requireEsbuild(t)
	metaDir := ionMetaDir(t)
	entry := ionMetaEntry(t)

	host := extension.NewHost()
	t.Cleanup(func() { host.Dispose() })

	if err := host.Load(entry, &extension.ExtensionConfig{
		ExtensionDir:     metaDir,
		WorkingDirectory: "/tmp",
	}); err != nil {
		t.Fatalf("Load: %v", err)
	}

	// Hook-internal emits flow through ctx.Emit (see
	// engine/internal/extension/hook_errors.go emitHookEvents). Wire
	// the Context's Emit field so the snapshot lands in our slice.
	var (
		emitMu     sync.Mutex
		emitEvents []types.EngineEvent
	)
	ctx := &extension.Context{
		SessionKey: "ion-meta-v2-session-start",
		Cwd:        "/tmp",
		Emit: func(ev types.EngineEvent) {
			emitMu.Lock()
			emitEvents = append(emitEvents, ev)
			emitMu.Unlock()
		},
	}
	if err := host.FireSessionStart(ctx); err != nil {
		t.Fatalf("FireSessionStart: %v", err)
	}

	// Find the engine_agent_state emission. The snapshot contract
	// requires a complete listing -- we expect every dispatchable
	// specialist (three mode agents + six knowledge specialists), all
	// idle. The orchestrator is intentionally absent from the panel:
	// it is the conversation itself (the persona injected via
	// before_prompt), not a dispatchable sub-agent. See agent-state.ts
	// for the rationale; matches chief-of-staff's convention where the
	// root persona is not a panel row.
	emitMu.Lock()
	defer emitMu.Unlock()
	var snapshot *types.EngineEvent
	for i := range emitEvents {
		if emitEvents[i].Type == "engine_agent_state" {
			snapshot = &emitEvents[i]
			break
		}
	}
	if snapshot == nil {
		t.Fatalf("session_start did not emit engine_agent_state. emitted types: %v", typesOf(emitEvents))
	}
	expectedAgents := []string{
		// Mode-shaped (the orchestrator routes to these based on intent).
		"ion-tutor",
		"extension-improver",
		"extension-builder",
		// Knowledge-shaped (deep-dive helpers).
		"extension-architect",
		"agent-designer",
		"skill-author",
		"hook-specialist",
		"testing-guide",
		"orchestration-designer",
	}
	gotNames := make(map[string]string)
	for _, a := range snapshot.Agents {
		gotNames[a.Name] = a.Status
	}
	for _, want := range expectedAgents {
		if _, ok := gotNames[want]; !ok {
			t.Errorf("snapshot missing agent %q; got: %v", want, gotNames)
		}
	}
	// The orchestrator MUST NOT appear in the panel. If it does, the
	// root-persona-vs-dispatchable-agent boundary has regressed.
	if _, ok := gotNames["orchestrator"]; ok {
		t.Errorf("orchestrator should NOT be in the agent panel "+
			"(it is the conversation, not a dispatchable sub-agent); got: %v", gotNames)
	}
	// All dispatchable specialists should be idle on session_start --
	// nothing is running until the LLM dispatches one via the Agent
	// tool.
	for _, want := range expectedAgents {
		if status := gotNames[want]; status != "idle" {
			t.Errorf("specialist %q status: expected idle, got %q", want, status)
		}
	}
}

// ─── session_end wipes the panel ───

func TestIonMetaV2_SessionEndEmitsEmptySnapshot(t *testing.T) {
	requireEsbuild(t)
	metaDir := ionMetaDir(t)
	entry := ionMetaEntry(t)

	host := extension.NewHost()
	t.Cleanup(func() { host.Dispose() })

	if err := host.Load(entry, &extension.ExtensionConfig{
		ExtensionDir:     metaDir,
		WorkingDirectory: "/tmp",
	}); err != nil {
		t.Fatalf("Load: %v", err)
	}

	var (
		emitMu     sync.Mutex
		emitEvents []types.EngineEvent
	)
	ctx := &extension.Context{
		SessionKey: "ion-meta-v2-session-end",
		Cwd:        "/tmp",
		Emit: func(ev types.EngineEvent) {
			emitMu.Lock()
			emitEvents = append(emitEvents, ev)
			emitMu.Unlock()
		},
	}
	if err := host.FireSessionStart(ctx); err != nil {
		t.Fatalf("FireSessionStart: %v", err)
	}
	if err := host.FireSessionEnd(ctx); err != nil {
		t.Fatalf("FireSessionEnd: %v", err)
	}

	// The last engine_agent_state emission MUST carry agents: []. The
	// snapshot contract treats this as the canonical session-reset
	// signal.
	emitMu.Lock()
	defer emitMu.Unlock()
	var last *types.EngineEvent
	for i := range emitEvents {
		if emitEvents[i].Type == "engine_agent_state" {
			ev := emitEvents[i]
			last = &ev
		}
	}
	if last == nil {
		t.Fatalf("no engine_agent_state event emitted")
	}
	if len(last.Agents) != 0 {
		names := make([]string, 0, len(last.Agents))
		for _, a := range last.Agents {
			names = append(names, a.Name)
		}
		t.Errorf("session_end snapshot expected empty agents list; got: %v", names)
	}
}

// ─── Bundled agents: extension ships the orchestrator + mode + knowledge specialists ───

func TestIonMetaV2_BundledAgentsInclude_NewSpecialist(t *testing.T) {
	// Filesystem check rather than runtime check: the engine discovers
	// agents by walking <ext>/agents/ -- if any agent file is missing,
	// that specialist will not be reachable from the orchestrator.
	metaDir := ionMetaDir(t)
	requireFile(t, metaDir+"/agents/orchestrator.md")
	for _, s := range []string{
		// Mode-shaped agents (post-three-mode rework).
		"ion-tutor",
		"extension-improver",
		"extension-builder",
		// Knowledge-shaped specialists.
		"extension-architect",
		"agent-designer",
		"skill-author",
		"hook-specialist",
		"testing-guide",
		"orchestration-designer",
	} {
		requireFile(t, metaDir+"/agents/"+s+".md")
	}
}

// ─── Agent frontmatter: tier assignments and no concrete model ids ───
//
// ion-meta declares abstract tiers (`fast`, `standard`) in agent
// frontmatter, never concrete model ids. This is doubly important:
// (1) the orchestrator's tier (`fast`) is the per-turn cost knob;
// (2) shipping a concrete Anthropic model id like `claude-sonnet-4-6`
// would assume the user has access to that specific model — which we
// cannot assume (the engine supports Anthropic, OpenAI, Google, Azure,
// Groq, Mistral, Cohere, AWS Bedrock, and any user-configured baseURL
// provider). The engine's modelconfig.ResolveTier lookups handle the
// abstract names; ion-meta must not bake in opinions.
//
// If a future PR regresses (e.g. someone "helpfully" pins a concrete
// model back in), this test fails with a clear message.
func TestIonMetaV2_AgentTierAssignments(t *testing.T) {
	metaDir := ionMetaDir(t)
	cases := map[string]string{
		// Orchestrator: fast tier (one-shot intent classification on
		// every user turn; latency + cost matter most).
		"orchestrator": "fast",
		// Mode agents: standard tier (cross-doc synthesis, code reading,
		// code generation; verification loop budget is 3 attempts and
		// we want to spend it well).
		"ion-tutor":          "standard",
		"extension-improver": "standard",
		"extension-builder":  "standard",
		// Knowledge specialists: standard tier (deep-dive on one
		// surface when conversations need real depth).
		"extension-architect":    "standard",
		"agent-designer":         "standard",
		"skill-author":           "standard",
		"hook-specialist":        "standard",
		"testing-guide":          "standard",
		"orchestration-designer": "standard",
	}
	for agent, wantTier := range cases {
		path := metaDir + "/agents/" + agent + ".md"
		data, err := os.ReadFile(path)
		if err != nil {
			t.Errorf("read %s: %v", path, err)
			continue
		}
		body := string(data)
		// Frontmatter line we expect, e.g. "model: fast" or
		// "model: standard". We match the line as a whole substring
		// rather than parsing YAML — keeps the test free of yaml
		// dependencies and the assertion concrete.
		wantLine := "model: " + wantTier
		if !strings.Contains(body, wantLine) {
			t.Errorf("agent %s: missing frontmatter line %q. ion-meta agents must declare "+
				"abstract tiers (fast/standard), not concrete model ids. See "+
				"docs/extensions/ion-meta.md#model-tiers.", agent, wantLine)
		}
		// Reject concrete Anthropic / OpenAI / Google model ids in the
		// agent's frontmatter section (first ~10 lines). Look for the
		// canonical prefixes that would slip through.
		fmEnd := strings.Index(body, "\n---\n")
		if fmEnd == -1 {
			fmEnd = len(body)
		} else {
			fmEnd += len("\n---\n")
		}
		frontmatter := body[:fmEnd]
		for _, banned := range []string{
			"claude-sonnet", "claude-opus", "claude-haiku", "claude-3",
			"gpt-4", "gpt-3", "o1-",
			"gemini-", "mistral-",
		} {
			if strings.Contains(strings.ToLower(frontmatter), banned) {
				t.Errorf("agent %s frontmatter contains concrete model id substring %q. "+
					"ion-meta ships no model opinions — use abstract tiers (fast/standard).",
					agent, banned)
			}
		}
	}
}

// ─── Helpers ─────────────────────────────────────────────────────────────

func typesOf(events []types.EngineEvent) []string {
	out := make([]string, 0, len(events))
	for _, e := range events {
		out = append(out, e.Type)
	}
	return out
}

func requireFile(t *testing.T, path string) {
	t.Helper()
	if _, err := os.Stat(path); err != nil {
		t.Errorf("expected file at %s: %v", path, err)
	}
}
