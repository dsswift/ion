// Tests for the engine_command_registry snapshot event and the unknown-command
// default arm of Manager.SendCommand. Both behaviors back Phase 0.5 + Phase 2
// of the unified slash-command pipeline.

package session

import (
	"strings"
	"sync"
	"testing"

	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/types"
)

// TestBuildCommandListings_NilGroup verifies that a nil group yields a non-nil
// empty slice. The wire snapshot must always be observable as
// `"commands":[]` rather than the field being omitted, because consumers use
// the field's presence as the "this was a snapshot, replace your cache" signal.
func TestBuildCommandListings_NilGroup(t *testing.T) {
	got := buildCommandListings(nil)
	if got == nil {
		t.Fatal("buildCommandListings(nil): want non-nil empty slice, got nil")
	}
	if len(got) != 0 {
		t.Errorf("buildCommandListings(nil): want empty, got %v", got)
	}
}

// TestBuildCommandListings_EmptyGroup mirrors the nil-group case for the
// "constructed but with zero hosts" path. Same snapshot-semantics rationale.
func TestBuildCommandListings_EmptyGroup(t *testing.T) {
	got := buildCommandListings(extension.NewExtensionGroup())
	if got == nil {
		t.Fatal("buildCommandListings(empty group): want non-nil empty slice, got nil")
	}
	if len(got) != 0 {
		t.Errorf("buildCommandListings(empty group): want empty, got %v", got)
	}
}

// TestBuildCommandListings_SortedByName checks that the listing output is
// alphabetically sorted. Consumers MUST NOT depend on order (snapshot is
// snapshot), but deterministic ordering makes log diffs and test assertions
// readable. Lock it in so a refactor doesn't accidentally swap to map-iteration
// order and force every consumer test to use unordered comparisons.
func TestBuildCommandListings_SortedByName(t *testing.T) {
	group := extension.NewExtensionGroup()
	host := newTestHostWithCommands(map[string]string{
		"zebra":  "z cmd",
		"apple":  "a cmd",
		"middle": "m cmd",
	})
	group.Add(host)

	got := buildCommandListings(group)
	if len(got) != 3 {
		t.Fatalf("buildCommandListings: want 3 entries, got %d", len(got))
	}
	wantOrder := []string{"apple", "middle", "zebra"}
	for i, w := range wantOrder {
		if got[i].Name != w {
			t.Errorf("listing[%d].Name = %q; want %q", i, got[i].Name, w)
		}
	}
}

// TestBuildCommandListings_PreservesDescription verifies the Description field
// is propagated end-to-end. Without this, consumers that surface autocomplete
// hints would lose the human-readable description from extension command
// definitions.
func TestBuildCommandListings_PreservesDescription(t *testing.T) {
	group := extension.NewExtensionGroup()
	host := newTestHostWithCommands(map[string]string{
		"review": "Review the staged diff for issues",
	})
	group.Add(host)

	got := buildCommandListings(group)
	if len(got) != 1 {
		t.Fatalf("want 1 listing, got %d", len(got))
	}
	if got[0].Description != "Review the staged diff for issues" {
		t.Errorf("Description = %q; want propagated from CommandDefinition", got[0].Description)
	}
}

// TestSendCommand_UnknownCommandEmitsResult is the unknown-command
// contract test. Before this change, an unknown command was a silent no-op
// that left in-flight conversations hanging. Now the engine must emit an
// engine_command_result with CommandError populated so consumers can route
// to whatever fallback they own (or surface "unknown command" to the user
// when no fallback resolves).
func TestSendCommand_UnknownCommandEmitsResult(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	ec := newEventCollector(mgr)

	_, _ = mgr.StartSession("uk", defaultConfig())

	mgr.SendCommand("uk", "no-such-thing", "")

	results := ec.byType("engine_command_result")
	if len(results) == 0 {
		t.Fatal("expected engine_command_result for unknown command, got none")
	}
	last := results[len(results)-1].event
	if !strings.Contains(last.EventMessage, "unknown command") {
		t.Errorf("EventMessage = %q; want it to mention 'unknown command'", last.EventMessage)
	}
	if !strings.Contains(last.EventMessage, "no-such-thing") {
		t.Errorf("EventMessage = %q; want it to mention the command name", last.EventMessage)
	}
	if last.CommandError == "" {
		t.Errorf("CommandError empty; want non-empty so consumers can distinguish error from success")
	}
	if last.Command != "no-such-thing" {
		t.Errorf("Command = %q; want %q so consumers can switch on it without reparsing EventMessage", last.Command, "no-such-thing")
	}
}

// TestSendCommand_ClearEmitsSuccessResult locks in the contract: every
// successful built-in command also emits engine_command_result with the
// Command field populated. Consumers subscribing to this event use the
// signal to render any post-clear UI; without this emit the consumer has
// no engine-driven trigger to react to.
func TestSendCommand_ClearEmitsSuccessResult(t *testing.T) {
	t.Setenv("HOME", t.TempDir())

	mb := newMockBackend()
	mgr := NewManager(mb)
	ec := newEventCollector(mgr)

	const key = "clear-emits-result"
	if _, err := mgr.StartSession(key, defaultConfig()); err != nil {
		t.Fatalf("StartSession failed: %v", err)
	}
	t.Cleanup(func() { _ = mgr.StopSession(key) })

	mgr.SendCommand(key, "clear", "")

	results := ec.byType("engine_command_result")
	if len(results) == 0 {
		t.Fatal("expected engine_command_result for /clear, got none")
	}
	last := results[len(results)-1].event
	if last.Command != "clear" {
		t.Errorf("Command = %q; want \"clear\"", last.Command)
	}
	if last.CommandError != "" {
		t.Errorf("CommandError = %q; want empty (this is the success case)", last.CommandError)
	}
	if !strings.Contains(last.EventMessage, "clear") {
		t.Errorf("EventMessage = %q; want it to mention the command name", last.EventMessage)
	}
}

// TestSendCommand_MissingSessionEmitsUnknownCommand verifies the missing-
// session path now emits an engine_command_result with
// CommandError='unknown_command' instead of returning silently. This is the
// fix for the regression where a session that hadn't started yet would
// silently swallow a slash command, leaving any awaiter hanging until
// timeout. Consumers rely on EVERY dispatch producing a result event; the
// previous silent-drop path violated that invariant.
//
// The signal is intentionally the same shape as the default-arm
// unknown-command emit (CommandError='unknown_command') so consumers can
// use a single fallback branch — semantically the engine cannot run the
// command and the consumer should route to whatever fallback it owns.
func TestSendCommand_MissingSessionEmitsUnknownCommand(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	ec := newEventCollector(mgr)

	// Note: NO StartSession call — the key doesn't exist.
	mgr.SendCommand("ghost", "ion--review-changes", "138")

	results := ec.byType("engine_command_result")
	if len(results) != 1 {
		t.Fatalf("missing-session SendCommand should emit exactly one engine_command_result; got %d (total events=%d)", len(results), ec.count())
	}
	ev := results[0].event
	if ev.Command != "ion--review-changes" {
		t.Errorf("event Command: want %q, got %q", "ion--review-changes", ev.Command)
	}
	if ev.CommandError != "unknown_command" {
		t.Errorf("event CommandError: want %q, got %q", "unknown_command", ev.CommandError)
	}
	if !strings.Contains(ev.EventMessage, "unknown command") {
		t.Errorf("event EventMessage should mention 'unknown command', got %q", ev.EventMessage)
	}
	if results[0].key != "ghost" {
		t.Errorf("event key: want %q, got %q", "ghost", results[0].key)
	}
}

// TestEmitCommandRegistry_MissingSessionIsSafe ensures the registry-emit
// function is no-op-safe when called for a session that has been torn down
// concurrently. Hosts hold a captured key closure for their onCommandsChange
// observer, and the observer can fire after StopSession races with a
// late-arriving RegisterCommand. We must not panic in that case.
func TestEmitCommandRegistry_MissingSessionIsSafe(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	ec := newEventCollector(mgr)

	// No StartSession; emit against a key that has never existed.
	mgr.emitCommandRegistry("never-existed")

	if ec.count() != 0 {
		t.Errorf("expected zero events for missing session; got %d", ec.count())
	}
}

// TestEmitCommandRegistry_InitialSnapshot covers the Phase 0.5 initial-publish
// flow at the unit-test level: a session with a wired extension group emits an
// engine_command_registry event listing exactly the commands the group exposes.
// This is the event consumers subscribe to for their routing-hint cache, so
// the shape matters: full snapshot semantics, sorted by name, with descriptions.
func TestEmitCommandRegistry_InitialSnapshot(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	ec := newEventCollector(mgr)

	const key = "registry-initial"
	if _, err := mgr.StartSession(key, defaultConfig()); err != nil {
		t.Fatalf("StartSession failed: %v", err)
	}
	t.Cleanup(func() { _ = mgr.StopSession(key) })

	group := extension.NewExtensionGroup()
	group.Add(newTestHostWithCommands(map[string]string{
		"alpha": "first cmd",
		"beta":  "second cmd",
	}))
	mgr.TestSetExtGroup(key, group)

	mgr.emitCommandRegistry(key)

	results := ec.byType("engine_command_registry")
	if len(results) != 1 {
		t.Fatalf("expected exactly 1 engine_command_registry event, got %d", len(results))
	}
	cmds := results[0].event.Commands
	if len(cmds) != 2 {
		t.Fatalf("expected 2 commands in snapshot, got %d (%+v)", len(cmds), cmds)
	}
	if cmds[0].Name != "alpha" || cmds[1].Name != "beta" {
		t.Errorf("expected sorted order [alpha, beta]; got [%s, %s]", cmds[0].Name, cmds[1].Name)
	}
	if cmds[0].Description != "first cmd" {
		t.Errorf("description not propagated: got %q", cmds[0].Description)
	}
}

// TestEmitCommandRegistry_EmptyGroupSnapshot locks in the snapshot-contract
// invariant: a session with no extensions still emits a registry event with an
// empty list (not nil, not absent). Consumers use the event's arrival as the
// "clear your cache" signal — without this, a session that loses all
// extensions would leave stale entries cached on the consumer side forever.
func TestEmitCommandRegistry_EmptyGroupSnapshot(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	ec := newEventCollector(mgr)

	const key = "registry-empty"
	if _, err := mgr.StartSession(key, defaultConfig()); err != nil {
		t.Fatalf("StartSession failed: %v", err)
	}
	t.Cleanup(func() { _ = mgr.StopSession(key) })

	// No TestSetExtGroup — session has no extensions wired.
	mgr.emitCommandRegistry(key)

	results := ec.byType("engine_command_registry")
	if len(results) != 1 {
		t.Fatalf("expected 1 registry event even with no extensions; got %d", len(results))
	}
	if results[0].event.Commands == nil {
		t.Error("Commands should be non-nil empty slice for snapshot-contract correctness")
	}
	if len(results[0].event.Commands) != 0 {
		t.Errorf("Commands should be empty when no extensions; got %+v", results[0].event.Commands)
	}
}

// TestEmitCommandRegistry_MidSessionRegistrationReSnapshots is the headline
// test for the dynamic-mutability story. An extension registers a new command
// AFTER the initial snapshot has been published. The wired onCommandsChange
// observer should fire a fresh full snapshot containing the new entry, with
// SNAPSHOT semantics (full set, not a diff).
func TestEmitCommandRegistry_MidSessionRegistrationReSnapshots(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	ec := newEventCollector(mgr)

	const key = "registry-mid-session"
	if _, err := mgr.StartSession(key, defaultConfig()); err != nil {
		t.Fatalf("StartSession failed: %v", err)
	}
	t.Cleanup(func() { _ = mgr.StopSession(key) })

	// Start with one command, then wire the observer + emit the initial snapshot.
	host := newTestHostWithCommands(map[string]string{
		"alpha": "first cmd",
	})
	group := extension.NewExtensionGroup()
	group.Add(host)
	mgr.TestSetExtGroup(key, group)

	mgr.emitCommandRegistry(key)
	host.SetOnCommandsChange(func() {
		mgr.emitCommandRegistry(key)
	})

	// Sanity: one initial event.
	if got := len(ec.byType("engine_command_registry")); got != 1 {
		t.Fatalf("after initial emit, want 1 registry event; got %d", got)
	}

	// Mid-session registration. The wired observer must fire a second snapshot.
	host.SDK().RegisterCommand("beta", extension.CommandDefinition{
		Description: "registered mid-session",
		Execute: func(args string, ctx *extension.Context) error { return nil },
	})

	results := ec.byType("engine_command_registry")
	if len(results) != 2 {
		t.Fatalf("expected 2 registry events (initial + mid-session); got %d", len(results))
	}

	// Second snapshot must contain BOTH commands (full set, not a diff).
	second := results[1].event.Commands
	if len(second) != 2 {
		t.Fatalf("second snapshot should be full set with 2 commands; got %d (%+v)", len(second), second)
	}
	names := []string{second[0].Name, second[1].Name}
	if names[0] != "alpha" || names[1] != "beta" {
		t.Errorf("second snapshot want [alpha beta] sorted; got %v", names)
	}
}

// TestSDK_OnCommandsChangeFiresAfterRegister checks the lowest-level SDK
// behavior: registering a command must invoke the wired observer once,
// outside the lock (so observers can safely call SDK.Commands without
// deadlocking on the registration mutex).
func TestSDK_OnCommandsChangeFiresAfterRegister(t *testing.T) {
	sdk := extension.NewSDK()

	var (
		fires      int
		seenCmds   map[string]extension.CommandDefinition
		mu         sync.Mutex
	)
	sdk.SetOnCommandsChange(func() {
		mu.Lock()
		fires++
		// Calling Commands() inside the observer must not deadlock — it
		// re-acquires the same RWMutex the registration released a moment
		// ago. This assertion is the whole reason the callback fires
		// outside the lock.
		seenCmds = sdk.Commands()
		mu.Unlock()
	})

	sdk.RegisterCommand("foo", extension.CommandDefinition{Description: "a foo"})

	mu.Lock()
	defer mu.Unlock()
	if fires != 1 {
		t.Errorf("observer should fire exactly once per RegisterCommand; got %d", fires)
	}
	if _, ok := seenCmds["foo"]; !ok {
		t.Errorf("observer's call to Commands() did not see the freshly-registered entry; got %v", seenCmds)
	}
}

// TestSDK_OnCommandsChangeClearedByNil ensures SetOnCommandsChange(nil) is a
// valid clear operation. Useful for tests and for session-teardown paths
// that want to detach observers before the session goes away.
func TestSDK_OnCommandsChangeClearedByNil(t *testing.T) {
	sdk := extension.NewSDK()

	fired := false
	sdk.SetOnCommandsChange(func() { fired = true })
	sdk.SetOnCommandsChange(nil)
	sdk.RegisterCommand("foo", extension.CommandDefinition{})

	if fired {
		t.Error("observer should not fire after being cleared with nil")
	}
}

// ---------------------------------------------------------------------------
// Test helpers (this file only; see manager_helpers_test.go for the shared
// fixtures used by the broader session test suite).
// ---------------------------------------------------------------------------

// newTestHostWithCommands constructs a Host whose SDK is pre-populated with
// the given name→description map. Used as a stand-in for a real loaded
// extension when the test only cares about the command table, not about hook
// firing or subprocess lifecycle.
func newTestHostWithCommands(cmds map[string]string) *extension.Host {
	h := extension.NewHost()
	for name, desc := range cmds {
		// Capture name+desc per iteration so the closures don't all share
		// the last loop variable.
		n, d := name, desc
		h.SDK().RegisterCommand(n, extension.CommandDefinition{
			Description: d,
			Execute: func(args string, ctx *extension.Context) error {
				// Executes do nothing in these tests; we only care about
				// the registry projection, not dispatch behavior.
				_ = args
				_ = ctx
				return nil
			},
		})
	}
	return h
}

// Compile-time use of types so unused-import warnings don't fire when the
// fixtures above evolve to need a types import.
var _ = types.EngineCommandListing{}
