package backend

import (
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/types"
)

// TestSteer_NoSteerNormalExit verifies that a run with no steer message
// completes normally with exit code 0. This is the no-regression baseline.
func TestSteer_NoSteerNormalExit(t *testing.T) {
	setupTestProvider([][]types.LlmStreamEvent{
		textResponse("done", 10, 5),
	})

	b := NewApiBackend()
	c := collectEvents(b, "steer-no-steer")
	b.StartRun("steer-no-steer", types.RunOptions{
		Prompt:           "hello",
		ProjectPath:      "/tmp",
		Model:            testModel,
		EarlyStopEnabled: testEarlyStopDisabled(),
	})

	if !waitForExit(c, 5*time.Second) {
		t.Fatal("timed out waiting for exit")
	}

	c.mu.Lock()
	code := c.exitCode
	c.mu.Unlock()

	if code == nil || *code != 0 {
		t.Errorf("expected exit code 0, got %v", code)
	}

	// No SteerInjectedEvent should be present.
	c.mu.Lock()
	defer c.mu.Unlock()
	for _, ev := range c.normalized {
		if _, ok := ev.Data.(*types.SteerInjectedEvent); ok {
			t.Error("unexpected SteerInjectedEvent in no-steer run")
		}
	}
}

// TestSteer_BeforeEndTurnForcesContinuation verifies the critical fix:
// a steer message queued while the first LLM response is streaming is
// detected before TaskCompleteEvent fires, causing a forced continuation
// turn. The run must end with exit 0 and a SteerInjectedEvent must have
// been emitted.
func TestSteer_BeforeEndTurnForcesContinuation(t *testing.T) {
	setupTestProvider([][]types.LlmStreamEvent{
		textResponse("first response", 10, 5),
		textResponse("after steer response", 10, 5),
	})

	b := NewApiBackend()
	requestID := "steer-end-turn"
	c := collectEvents(b, requestID)

	b.StartRun(requestID, types.RunOptions{
		Prompt:           "do something",
		ProjectPath:      "/tmp",
		Model:            testModel,
		EarlyStopEnabled: testEarlyStopDisabled(),
	})

	// Send steer quickly — the mock provider returns immediately, so we
	// queue the steer message; drainSteer at the end_turn checkpoint will
	// pick it up before the run exits.
	b.Steer(requestID, "please redirect to topic B")

	if !waitForExit(c, 5*time.Second) {
		t.Fatal("timed out waiting for exit after steer injection")
	}

	c.mu.Lock()
	code := c.exitCode
	evs := append([]types.NormalizedEvent(nil), c.normalized...)
	c.mu.Unlock()

	if code == nil || *code != 0 {
		t.Errorf("expected exit code 0, got %v", code)
	}

	// SteerInjectedEvent must have been emitted.
	found := false
	for _, ev := range evs {
		if se, ok := ev.Data.(*types.SteerInjectedEvent); ok {
			found = true
			if se.MessageLength != len("please redirect to topic B") {
				t.Errorf("SteerInjectedEvent.MessageLength: want %d, got %d",
					len("please redirect to topic B"), se.MessageLength)
			}
		}
	}
	if !found {
		t.Error("expected SteerInjectedEvent but none was emitted")
	}
}

// TestSteer_DrainedAfterToolExecution verifies that a steer sent while a
// tool is running is captured by the post-tool-results drainSteer call and
// that the run completes normally.
func TestSteer_DrainedAfterToolExecution(t *testing.T) {
	setupTestProvider([][]types.LlmStreamEvent{
		// First turn: tool use
		toolUseResponse("Bash", "tool-1", map[string]any{"command": "echo hi"}, 10, 5),
		// Second turn: text response after tool result
		textResponse("tool done", 10, 5),
	})

	b := NewApiBackend()
	requestID := "steer-tool-drain"
	c := collectEvents(b, requestID)

	b.StartRun(requestID, types.RunOptions{
		Prompt:           "run a tool",
		ProjectPath:      "/tmp",
		Model:            testModel,
		EarlyStopEnabled: testEarlyStopDisabled(),
	})

	// Queue steer immediately; it will be drained after the tool completes.
	b.Steer(requestID, "steer during tool")

	if !waitForExit(c, 5*time.Second) {
		t.Fatal("timed out waiting for exit after tool+steer")
	}

	c.mu.Lock()
	code := c.exitCode
	evs := append([]types.NormalizedEvent(nil), c.normalized...)
	c.mu.Unlock()

	if code == nil || *code != 0 {
		t.Errorf("expected exit code 0, got %v", code)
	}

	// SteerInjectedEvent must have been emitted.
	found := false
	for _, ev := range evs {
		if _, ok := ev.Data.(*types.SteerInjectedEvent); ok {
			found = true
		}
	}
	if !found {
		t.Error("expected SteerInjectedEvent after tool execution steer")
	}
}

// TestSteer_MultipleSteersDrainCorrectly verifies that the steerCh buffer
// (capacity 4) can hold multiple messages and that each message queued before
// the run ends is surfaced as a SteerInjectedEvent. The run must complete with
// exit code 0.
//
// Each drainSteer call consumes exactly one message, so N steers require N
// continuation turns to fully drain. We set up N+1 provider responses to
// satisfy each turn.
func TestSteer_MultipleSteersDrainCorrectly(t *testing.T) {
	// 2 steers → 2 continuation turns → 3 provider responses total
	setupTestProvider([][]types.LlmStreamEvent{
		textResponse("response 1", 10, 5),
		textResponse("response 2", 10, 5),
		textResponse("response 3", 10, 5),
	})

	b := NewApiBackend()
	requestID := "steer-multi"
	c := collectEvents(b, requestID)

	b.StartRun(requestID, types.RunOptions{
		Prompt:           "do work",
		ProjectPath:      "/tmp",
		Model:            testModel,
		EarlyStopEnabled: testEarlyStopDisabled(),
	})

	// Queue two steers before the run finishes.
	b.Steer(requestID, "steer one")
	b.Steer(requestID, "steer two")

	if !waitForExit(c, 5*time.Second) {
		t.Fatal("timed out waiting for exit with multiple steers")
	}

	c.mu.Lock()
	code := c.exitCode
	evs := append([]types.NormalizedEvent(nil), c.normalized...)
	c.mu.Unlock()

	if code == nil || *code != 0 {
		t.Errorf("expected exit code 0, got %v", code)
	}

	// Count SteerInjectedEvents — should be at least 1 (may be 2 depending
	// on timing of the steer sends vs. drain checkpoints).
	steerCount := 0
	for _, ev := range evs {
		if _, ok := ev.Data.(*types.SteerInjectedEvent); ok {
			steerCount++
		}
	}
	if steerCount < 1 {
		t.Errorf("expected at least 1 SteerInjectedEvent, got %d", steerCount)
	}
}

// TestSteerWithReason_Delivered asserts the typed verdict for a live run with
// space in its steer channel: SteerWithReason returns SteerResultDelivered and
// the message is buffered (not dropped) for the next drain.
func TestSteerWithReason_Delivered(t *testing.T) {
	setupTestProvider([][]types.LlmStreamEvent{
		// A tool turn keeps the run live long enough to accept a steer while
		// the loop is parked inside executeTools — the same window a parent is
		// in while awaiting dispatched sub-agents (which execute as tools).
		toolUseResponse("Bash", "tool-1", map[string]any{"command": "echo hi"}, 10, 5),
		textResponse("done", 10, 5),
	})

	b := NewApiBackend()
	requestID := "steer-reason-delivered"
	c := collectEvents(b, requestID)

	b.StartRun(requestID, types.RunOptions{
		Prompt:           "park on a tool",
		ProjectPath:      "/tmp",
		Model:            testModel,
		EarlyStopEnabled: testEarlyStopDisabled(),
	})

	// The buffered channel (cap 4) accepts the steer immediately even while
	// the run is mid-tool; it is drained at the post-tool-results checkpoint
	// after the tool (sub-agent) returns.
	if got := b.SteerWithReason(requestID, "redirect while parked"); got != SteerResultDelivered {
		t.Fatalf("expected SteerResultDelivered, got %s", got)
	}

	if !waitForExit(c, 5*time.Second) {
		t.Fatal("timed out waiting for exit")
	}

	// And the steer must have actually been injected (drained) after the tool.
	c.mu.Lock()
	evs := append([]types.NormalizedEvent(nil), c.normalized...)
	c.mu.Unlock()
	found := false
	for _, ev := range evs {
		if _, ok := ev.Data.(*types.SteerInjectedEvent); ok {
			found = true
		}
	}
	if !found {
		t.Error("expected SteerInjectedEvent after the parked-on-tool steer was drained")
	}
}

// TestSteerWithReason_NoRun asserts the typed verdict for an unknown / inactive
// run: SteerWithReason returns SteerResultNoRun. The bare Steer wrapper must
// agree by returning false.
func TestSteerWithReason_NoRun(t *testing.T) {
	b := NewApiBackend()

	if got := b.SteerWithReason("no-such-run", "hello"); got != SteerResultNoRun {
		t.Fatalf("expected SteerResultNoRun, got %s", got)
	}
	if b.Steer("no-such-run", "hello") {
		t.Error("expected Steer to return false for an unknown run")
	}
}

// TestSteerWithReason_ChannelFull asserts the typed verdict when the steer
// channel is saturated. We construct an activeRun with a zero-capacity steer
// channel and register it directly so the non-blocking send fails immediately,
// exercising the channel-full branch deterministically.
func TestSteerWithReason_ChannelFull(t *testing.T) {
	b := NewApiBackend()
	const requestID = "steer-reason-full"

	// A zero-capacity channel with no receiver: every non-blocking send hits
	// the default branch (channel full).
	run := &activeRun{
		requestID: requestID,
		steerCh:   make(chan steerMessage), // cap 0, no drainer
	}
	b.mu.Lock()
	b.activeRuns[requestID] = run
	b.mu.Unlock()

	if got := b.SteerWithReason(requestID, "overflow"); got != SteerResultChannelFull {
		t.Fatalf("expected SteerResultChannelFull, got %s", got)
	}
	if b.Steer(requestID, "overflow") {
		t.Error("expected Steer to return false when the channel is full")
	}

	b.mu.Lock()
	delete(b.activeRuns, requestID)
	b.mu.Unlock()
}

// ─── drainSteer classification ───
//
// The defect: drainSteer called conversation.AddUserMessage, which stamps no
// kind, so a MACHINE-originated steer (a dispatch completion or a scheduled
// check-in bubbled into a live turn) was persisted as an ordinary user turn.
// The steer channel itself was `chan string`, so there was nowhere for a kind
// to travel and the drain point had nothing to read.
//
// These tests reach drainSteer directly with a conversation whose Entries slice
// is initialised, so the persisted MessageData is inspectable without touching
// the filesystem. conversation.Save writes to the default directory when given
// "" and its failure is logged rather than fatal, so the entry is asserted from
// memory.

// newSteerDrainRun builds an activeRun with a buffered steer channel and a
// conversation ready to receive entries.
func newSteerDrainRun(requestID string) (*activeRun, *conversation.Conversation) {
	run := &activeRun{
		requestID: requestID,
		steerCh:   make(chan steerMessage, 4),
	}
	conv := &conversation.Conversation{
		ID:      "conv-" + requestID,
		Entries: []conversation.SessionEntry{},
	}
	return run, conv
}

// findUserMessageEntry returns the first user-role message entry, which is the
// turn drainSteer injected.
func findUserMessageEntry(t *testing.T, conv *conversation.Conversation) conversation.MessageData {
	t.Helper()
	for _, e := range conv.Entries {
		if e.Type != conversation.EntryMessage {
			continue
		}
		md, ok := e.Data.(conversation.MessageData)
		if !ok {
			continue
		}
		if md.Role == "user" {
			return md
		}
	}
	t.Fatalf("no user message entry found among %d entries", len(conv.Entries))
	return conversation.MessageData{}
}

// TestDrainSteer_MachineSteerPersistsKind is the root-cause-3 regression. A
// steer carrying a kind must persist as that kind and be marked machine
// authored. Reverting drainSteer to AddUserMessage turns this red.
func TestDrainSteer_MachineSteerPersistsKind(t *testing.T) {
	b := NewApiBackend()
	run, conv := newSteerDrainRun("steer-kind-machine")

	run.steerCh <- steerMessage{
		text: "[SYSTEM] Dispatch check-in",
		kind: string(types.InjectionKindCheckIn),
	}

	if !b.drainSteer(run, conv) {
		t.Fatal("drainSteer reported no message consumed")
	}

	md := findUserMessageEntry(t, conv)
	if md.InjectionKind != string(types.InjectionKindCheckIn) {
		t.Errorf("persisted InjectionKind = %q, want %q. An unclassified row here is the "+
			"defect: the steer reloads as a user turn.", md.InjectionKind, types.InjectionKindCheckIn)
	}
	if !md.MachineAuthored {
		t.Error("persisted MachineAuthored = false on a checkin steer, want true")
	}
}

// TestDrainSteer_ClientSteerStaysUnclassified pins the boundary that keeps a
// HUMAN steer rendering exactly as before.
//
// A person typing into a running turn is as user-authored as a turn gets. If
// the kind defaulted to something machine-authored, every mid-turn steer the
// operator typed would vanish from the transcript — a far worse bug than the
// one being fixed.
func TestDrainSteer_ClientSteerStaysUnclassified(t *testing.T) {
	b := NewApiBackend()
	run, conv := newSteerDrainRun("steer-kind-client")

	run.steerCh <- steerMessage{text: "actually, check the logs first"}

	if !b.drainSteer(run, conv) {
		t.Fatal("drainSteer reported no message consumed")
	}

	md := findUserMessageEntry(t, conv)
	if md.InjectionKind != "" {
		t.Errorf("client steer persisted InjectionKind = %q, want empty", md.InjectionKind)
	}
	if md.MachineAuthored {
		t.Error("client steer persisted MachineAuthored = true; a human steer is a user turn")
	}
}

// TestDrainSteer_CarriesKindFromSteerWithKind covers the full path a caller
// actually takes: SteerWithKind buffers, drainSteer persists. Pins that the
// kind survives the channel hop rather than only the drain point handling it.
func TestDrainSteer_CarriesKindFromSteerWithKind(t *testing.T) {
	b := NewApiBackend()
	const requestID = "steer-kind-endtoend"
	run, conv := newSteerDrainRun(requestID)

	b.mu.Lock()
	b.activeRuns[requestID] = run
	b.mu.Unlock()
	defer func() {
		b.mu.Lock()
		delete(b.activeRuns, requestID)
		b.mu.Unlock()
	}()

	if got := b.SteerWithKind(requestID, "child result", string(types.InjectionKindAgentCompletion)); got != SteerResultDelivered {
		t.Fatalf("SteerWithKind = %s, want delivered", got)
	}
	if !b.drainSteer(run, conv) {
		t.Fatal("drainSteer reported no message consumed")
	}

	md := findUserMessageEntry(t, conv)
	if md.InjectionKind != string(types.InjectionKindAgentCompletion) {
		t.Errorf("InjectionKind = %q, want %q", md.InjectionKind, types.InjectionKindAgentCompletion)
	}
	if !md.MachineAuthored {
		t.Error("MachineAuthored = false on an agent_completion steer, want true")
	}
}

// ─── client correlation id + durable entry id echo ───
//
// The defect these pin: a client's optimistic UI row for an outstanding steer
// has no stable identity to resolve against once drainSteer confirms it, so
// clients were reduced to trusting arrival order / buffer position — which
// breaks the moment more than one steer is outstanding, or a machine
// injection interleaves with a human one. SteerWithClientID plumbs a client
// correlation id onto the buffered steerMessage; drainSteer echoes it back
// (along with the durable persisted entry id) ONLY for a genuine
// client-originated steer (kind == "").

// TestDrainSteer_EchoesClientMessageIDAndEntryIDForClientSteer is the
// regression test for the identity-vs-position defect: a client-originated
// steer delivered via SteerWithClientID must surface both its own correlation
// id and the durable entry id drainSteer persisted it under, on the emitted
// SteerInjectedEvent.
func TestDrainSteer_EchoesClientMessageIDAndEntryIDForClientSteer(t *testing.T) {
	b := NewApiBackend()
	const requestID = "steer-client-id-echo"
	run, conv := newSteerDrainRun(requestID)
	conv.Entries = []conversation.SessionEntry{} // ensure AddUserMessageWithKind persists an entry

	b.mu.Lock()
	b.activeRuns[requestID] = run
	b.mu.Unlock()
	defer func() {
		b.mu.Lock()
		delete(b.activeRuns, requestID)
		b.mu.Unlock()
	}()

	var captured *types.SteerInjectedEvent
	b.OnNormalized(func(_ string, ev types.NormalizedEvent) {
		if se, ok := ev.Data.(*types.SteerInjectedEvent); ok {
			captured = se
		}
	})

	const clientID = "client-corr-123"
	if got := b.SteerWithClientID(requestID, "please redirect", "", clientID); got != SteerResultDelivered {
		t.Fatalf("SteerWithClientID = %s, want delivered", got)
	}
	if !b.drainSteer(run, conv) {
		t.Fatal("drainSteer reported no message consumed")
	}

	if captured == nil {
		t.Fatal("expected a SteerInjectedEvent to be emitted")
	}
	if captured.ClientMessageID != clientID {
		t.Errorf("SteerInjectedEvent.ClientMessageID = %q, want %q", captured.ClientMessageID, clientID)
	}
	if captured.EntryID == "" {
		t.Error("SteerInjectedEvent.EntryID is empty, want the persisted entry's id")
	}

	// The persisted entry's id must match what was echoed, so a client can
	// use EntryID as an exact future rewind_session target.
	md := findUserMessageEntry(t, conv)
	_ = md // findUserMessageEntry already asserts a user entry exists
	var persistedID string
	for _, e := range conv.Entries {
		if e.Type == conversation.EntryMessage {
			if md, ok := e.Data.(conversation.MessageData); ok && md.Role == "user" {
				persistedID = e.ID
				break
			}
		}
	}
	if persistedID == "" {
		t.Fatal("no persisted user entry found to compare against")
	}
	if captured.EntryID != persistedID {
		t.Errorf("SteerInjectedEvent.EntryID = %q, want %q (the persisted entry id)", captured.EntryID, persistedID)
	}
}

// TestDrainSteer_MachineSteerNeverEchoesClientOrEntryID is the isolation
// regression: a machine-to-machine injection (kind != "") must never resolve
// a client's optimistic UI row, even if a caller mistakenly supplied a
// clientMessageID alongside a non-empty kind — the InjectionKind classifies
// the persisted turn as machine-authored, and drainSteer's echo guard keys off
// exactly that, not off whether a client id happens to be present.
func TestDrainSteer_MachineSteerNeverEchoesClientOrEntryID(t *testing.T) {
	b := NewApiBackend()
	const requestID = "steer-machine-no-echo"
	run, conv := newSteerDrainRun(requestID)

	b.mu.Lock()
	b.activeRuns[requestID] = run
	b.mu.Unlock()
	defer func() {
		b.mu.Lock()
		delete(b.activeRuns, requestID)
		b.mu.Unlock()
	}()

	var captured *types.SteerInjectedEvent
	b.OnNormalized(func(_ string, ev types.NormalizedEvent) {
		if se, ok := ev.Data.(*types.SteerInjectedEvent); ok {
			captured = se
		}
	})

	// Even with a client id present, a non-empty kind must suppress the echo.
	if got := b.SteerWithClientID(requestID, "child result", string(types.InjectionKindAgentCompletion), "should-never-echo"); got != SteerResultDelivered {
		t.Fatalf("SteerWithClientID = %s, want delivered", got)
	}
	if !b.drainSteer(run, conv) {
		t.Fatal("drainSteer reported no message consumed")
	}

	if captured == nil {
		t.Fatal("expected a SteerInjectedEvent to be emitted")
	}
	if captured.ClientMessageID != "" {
		t.Errorf("SteerInjectedEvent.ClientMessageID = %q on a machine steer, want empty", captured.ClientMessageID)
	}
	if captured.EntryID != "" {
		t.Errorf("SteerInjectedEvent.EntryID = %q on a machine steer, want empty", captured.EntryID)
	}
}

// TestDrainSteer_OmittedClientIDLeavesEventFieldsEmpty pins the legacy path:
// a client-originated steer with no clientMessageID supplied (older client, or
// a caller using the plain SteerWithKind entry point) still emits an event —
// just without the new correlation fields — never regressing the pre-existing
// length-only confirmation.
func TestDrainSteer_OmittedClientIDLeavesEventFieldsEmpty(t *testing.T) {
	b := NewApiBackend()
	const requestID = "steer-no-client-id"
	run, conv := newSteerDrainRun(requestID)

	b.mu.Lock()
	b.activeRuns[requestID] = run
	b.mu.Unlock()
	defer func() {
		b.mu.Lock()
		delete(b.activeRuns, requestID)
		b.mu.Unlock()
	}()

	var captured *types.SteerInjectedEvent
	b.OnNormalized(func(_ string, ev types.NormalizedEvent) {
		if se, ok := ev.Data.(*types.SteerInjectedEvent); ok {
			captured = se
		}
	})

	if got := b.SteerWithKind(requestID, "plain steer", ""); got != SteerResultDelivered {
		t.Fatalf("SteerWithKind = %s, want delivered", got)
	}
	if !b.drainSteer(run, conv) {
		t.Fatal("drainSteer reported no message consumed")
	}

	if captured == nil {
		t.Fatal("expected a SteerInjectedEvent to be emitted")
	}
	if captured.ClientMessageID != "" {
		t.Errorf("SteerInjectedEvent.ClientMessageID = %q, want empty when caller supplied none", captured.ClientMessageID)
	}
	// EntryID is still populated because this is a genuine client-originated
	// (kind=="") steer — only ClientMessageID depends on the caller supplying
	// one. This distinguishes "no correlation id was given" from "this was a
	// machine injection", per the SteerInjectedEvent contract.
	if captured.EntryID == "" {
		t.Error("SteerInjectedEvent.EntryID is empty for a genuine client steer, want the persisted entry id")
	}
	if captured.MessageLength != len("plain steer") {
		t.Errorf("MessageLength = %d, want %d", captured.MessageLength, len("plain steer"))
	}
}
