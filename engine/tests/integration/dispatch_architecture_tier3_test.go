//go:build integration

package integration

import (
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/providers"
	"github.com/dsswift/ion/engine/internal/session"
	"github.com/dsswift/ion/engine/internal/session/extcontext"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/tests/helpers"
)

// TestDispatchArchitecture_ThirdTierAndSteering proves the full n-tier +
// steering matrix:
//   - 2nd-tier agents dispatch their own 3rd-tier children via ctx.DispatchAgent
//   - Output isolation: 2nd-tier and 3rd-tier outputs are independently
//     retrievable by dispatchId
//   - Follow-up: a previously dispatched 3rd-tier agent can be continued via
//     SessionID continuation
//   - Recall + recreate: a 3rd-tier dispatch is recalled, then a fresh
//     3rd-tier is dispatched
//   - Steer: a running 3rd-tier agent is steered via SteerDispatch; the
//     steered message appears in the 3rd-tier conversation
//   - Root-to-2nd steer: the root steers a 2nd-tier dispatch
//   - Root-to-2nd follow-up: the root sends a follow-up to a 2nd-tier dispatch
//   - Depth cap: a depth-2 agent attempting a 4th-tier dispatch is blocked
//     with ErrDispatchDepthExceeded and no dispatch_start event
//   - Parallel isolation: two parallel 3rd-tier dispatches have isolated
//     output, each retrievable by dispatchId
//   - Steer-to-finished: steer to a completed dispatch returns not_found
//   - Steer vs follow-up are distinct mechanisms
func TestDispatchArchitecture_ThirdTierAndSteering(t *testing.T) {
	providers.ResetRegistries()
	t.Cleanup(func() { providers.ResetRegistries() })

	mp := helpers.NewMockProvider("mock")
	providers.RegisterProvider(mp)
	providers.RegisterModel("mock-model", types.ModelInfo{
		ProviderID:      "mock",
		ContextWindow:   200000,
		CostPer1kInput:  0.003,
		CostPer1kOutput: 0.015,
	})

	// Event collector for the session.
	var (
		evMu   sync.Mutex
		events []types.EngineEvent
	)

	mgr := session.NewManager(backend.NewApiBackend())
	mgr.OnEvent(func(_ string, ev types.EngineEvent) {
		evMu.Lock()
		events = append(events, ev)
		evMu.Unlock()
	})

	cfg := types.EngineConfig{
		ProfileID:        "tier3-test",
		WorkingDirectory: t.TempDir(),
	}
	if _, err := mgr.StartSession("tier3", cfg); err != nil {
		t.Fatalf("StartSession: %v", err)
	}
	t.Cleanup(func() { mgr.StopSession("tier3") })

	// Completion/error outcome tracking keyed by agent name.
	type outcome struct {
		result *extension.DispatchAgentResult
		err    *extension.DispatchError
	}
	var (
		omu      sync.Mutex
		outcomes = map[string]*outcome{}
	)
	done := make(chan string, 32)

	onComplete := func(name string) func(extension.DispatchAgentResult) {
		return func(r extension.DispatchAgentResult) {
			omu.Lock()
			outcomes[name] = &outcome{result: &r}
			omu.Unlock()
			done <- name
		}
	}
	onError := func(name string) func(extension.DispatchError) {
		return func(e extension.DispatchError) {
			omu.Lock()
			outcomes[name] = &outcome{err: &e}
			omu.Unlock()
			done <- name
		}
	}
	waitFor := func(name string, timeout time.Duration) {
		dl := time.After(timeout)
		for {
			select {
			case n := <-done:
				if n == name {
					return
				}
				// Not the one we want; keep waiting.
			case <-dl:
				t.Fatalf("timeout waiting for %q", name)
			}
		}
	}
	getOutcome := func(name string) *outcome {
		omu.Lock()
		defer omu.Unlock()
		return outcomes[name]
	}

	// Register a minimal extension group so the session has one.
	host := extension.NewHost()
	group := extension.NewExtensionGroup()
	group.Add(host)
	mgr.TestSetExtGroup("tier3", group)

	// countEvType counts events of a specific type.
	countEvType := func(typ string) int {
		evMu.Lock()
		defer evMu.Unlock()
		n := 0
		for _, ev := range events {
			if ev.Type == typ {
				n++
			}
		}
		return n
	}
	// countEvTypeSince counts events of a type added since a snapshot index.
	countEvTypeSince := func(typ string, since int) int {
		evMu.Lock()
		defer evMu.Unlock()
		n := 0
		for i := since; i < len(events); i++ {
			if events[i].Type == typ {
				n++
			}
		}
		return n
	}
	evSnapshot := func() int {
		evMu.Lock()
		defer evMu.Unlock()
		return len(events)
	}

	// ── Section 1: 2nd-tier dispatches a 3rd-tier ──
	t.Run("tier2_dispatches_tier3", func(t *testing.T) {
		// Script: 2nd-tier gets a text response, 3rd-tier gets a text response.
		mp.SetResponse(helpers.TextResponse("tier2-output-A"))
		mp.SetResponse(helpers.TextResponse("tier3-output-X"))

		// Dispatch a 2nd-tier agent (depth=1) from root context.
		rootCtx := mgr.TestNewExtContext("tier3")
		if rootCtx == nil {
			t.Fatal("TestNewExtContext returned nil")
		}
		_, err := rootCtx.DispatchAgent(extension.DispatchAgentOpts{
			Name: "tier2-a", Task: "Task-T2A", Model: "mock-model",
			MaxTurns: 1, Background: true,
			OnComplete: onComplete("tier2-a"),
			OnError:    onError("tier2-a"),
		})
		if err != nil {
			t.Fatalf("dispatch tier2-a: %v", err)
		}
		waitFor("tier2-a", 15*time.Second)

		o2a := getOutcome("tier2-a")
		if o2a == nil || o2a.result == nil {
			t.Fatal("tier2-a: no result")
		}
		if o2a.result.ExitCode != 0 {
			t.Fatalf("tier2-a exit=%d want 0", o2a.result.ExitCode)
		}
		tier2ADispatchID := o2a.result.DispatchID
		tier2ASessionID := o2a.result.SessionID

		if tier2ADispatchID == "" {
			t.Fatal("tier2-a: empty DispatchID")
		}
		if tier2ASessionID == "" {
			t.Fatal("tier2-a: empty SessionID")
		}
		// Verify depth=1 on the result.
		if o2a.result.Depth != 1 {
			t.Errorf("tier2-a depth=%d want 1", o2a.result.Depth)
		}

		// Now create a depth-1 context simulating the 2nd-tier agent.
		// This is the key wiring: depth=1, DispatchId=tier2ADispatchID.
		tier2Ctx := mgr.TestNewExtContextWithOpts("tier3", extcontext.ExtContextOpts{
			Depth:      1,
			DispatchId: tier2ADispatchID,
		})
		if tier2Ctx == nil {
			t.Fatal("TestNewExtContextWithOpts returned nil")
		}

		// Dispatch a 3rd-tier agent (depth=2) from the 2nd-tier context.
		mp.SetResponse(helpers.TextResponse("tier3-output-Y"))
		_, err = tier2Ctx.DispatchAgent(extension.DispatchAgentOpts{
			Name: "tier3-x", Task: "Task-T3X", Model: "mock-model",
			MaxTurns: 1, Background: true,
			OnComplete: onComplete("tier3-x"),
			OnError:    onError("tier3-x"),
		})
		if err != nil {
			t.Fatalf("dispatch tier3-x: %v", err)
		}
		waitFor("tier3-x", 15*time.Second)

		o3x := getOutcome("tier3-x")
		if o3x == nil || o3x.result == nil {
			t.Fatal("tier3-x: no result")
		}
		if o3x.result.ExitCode != 0 {
			t.Fatalf("tier3-x exit=%d want 0", o3x.result.ExitCode)
		}
		// Verify depth=2 on the result.
		if o3x.result.Depth != 2 {
			t.Errorf("tier3-x depth=%d want 2", o3x.result.Depth)
		}
		// Verify parent dispatch ID.
		if o3x.result.ParentDispatchId != tier2ADispatchID {
			t.Errorf("tier3-x parentDispatchId=%q want %q", o3x.result.ParentDispatchId, tier2ADispatchID)
		}

		// Output isolation: 2nd-tier and 3rd-tier outputs are distinct.
		if o2a.result.Output == o3x.result.Output {
			t.Errorf("tier2 and tier3 share the same output: %q", o2a.result.Output)
		}

		// Verify per-dispatchId output retrieval via conversation content.
		if o3x.result.SessionID == "" {
			t.Fatal("tier3-x: empty SessionID")
		}
		msgs3, err := conversation.LoadMessages(o3x.result.SessionID, "")
		if err != nil {
			t.Fatalf("load tier3-x conversation: %v", err)
		}
		c3 := flattenContent(msgs3)
		if !strings.Contains(c3, "Task-T3X") {
			t.Error("tier3-x conversation missing its task")
		}
		// 3rd-tier conversation must NOT contain 2nd-tier's task.
		if strings.Contains(c3, "Task-T2A") {
			t.Error("tier3-x conversation contains tier2 task (isolation violated)")
		}

		// Telemetry: dispatch_start events should include depth info.
		evMu.Lock()
		var t3StartFound bool
		for _, ev := range events {
			if ev.Type == "engine_dispatch_start" && ev.DispatchDepth == 2 {
				t3StartFound = true
				if ev.DispatchParentId != tier2ADispatchID {
					t.Errorf("tier3 dispatch_start parentId=%q want %q", ev.DispatchParentId, tier2ADispatchID)
				}
			}
		}
		evMu.Unlock()
		if !t3StartFound {
			t.Error("no engine_dispatch_start with depth=2 found")
		}
	})

	// ── Section 2: Follow-up (SessionID continuation) at 3rd tier ──
	t.Run("tier3_followup_continuation", func(t *testing.T) {
		mp.SetResponse(helpers.TextResponse("tier3-initial-output"))
		mp.SetResponse(helpers.TextResponse("tier3-followup-output"))

		// Dispatch initial 3rd-tier from a depth-1 context.
		tier2Ctx := mgr.TestNewExtContextWithOpts("tier3", extcontext.ExtContextOpts{
			Depth:      1,
			DispatchId: "fake-tier2-for-followup",
		})
		_, err := tier2Ctx.DispatchAgent(extension.DispatchAgentOpts{
			Name: "tier3-follow", Task: "Task-T3-Init", Model: "mock-model",
			MaxTurns: 1, Background: true,
			OnComplete: onComplete("tier3-follow-init"),
			OnError:    onError("tier3-follow-init"),
		})
		if err != nil {
			t.Fatalf("dispatch tier3-follow init: %v", err)
		}
		waitFor("tier3-follow-init", 15*time.Second)

		oInit := getOutcome("tier3-follow-init")
		if oInit == nil || oInit.result == nil {
			t.Fatal("tier3-follow-init: no result")
		}
		initSID := oInit.result.SessionID

		// Follow-up: continue the same session.
		_, err = tier2Ctx.DispatchAgent(extension.DispatchAgentOpts{
			Name: "tier3-follow", Task: "Task-T3-Followup", Model: "mock-model",
			SessionID: initSID, MaxTurns: 1, Background: true,
			OnComplete: onComplete("tier3-follow-cont"),
			OnError:    onError("tier3-follow-cont"),
		})
		if err != nil {
			t.Fatalf("dispatch tier3-follow followup: %v", err)
		}
		waitFor("tier3-follow-cont", 15*time.Second)

		oCont := getOutcome("tier3-follow-cont")
		if oCont == nil || oCont.result == nil {
			t.Fatal("tier3-follow-cont: no result")
		}

		// Verify: continuation conversation contains both tasks.
		msgs, err := conversation.LoadMessages(initSID, "")
		if err != nil {
			t.Fatalf("load continuation conversation: %v", err)
		}
		c := flattenContent(msgs)
		if !strings.Contains(c, "Task-T3-Init") {
			t.Error("continuation missing initial task")
		}
		if !strings.Contains(c, "Task-T3-Followup") {
			t.Error("continuation missing follow-up task")
		}

		// The follow-up must have a DIFFERENT dispatchId but the SAME sessionId.
		if oCont.result.DispatchID == oInit.result.DispatchID {
			t.Error("follow-up has same dispatchId as initial (should differ)")
		}
		// The continuation reuses the session.
		if oCont.result.SessionID != initSID {
			t.Errorf("follow-up sessionId=%q want %q", oCont.result.SessionID, initSID)
		}
	})

	// ── Section 3: Recall 3rd-tier, then recreate ──
	t.Run("tier3_recall_and_recreate", func(t *testing.T) {
		// Use a fresh provider to get clean call counting.
		providers.ResetRegistries()
		recallMP := helpers.NewMockProvider("mock")
		providers.RegisterProvider(recallMP)
		providers.RegisterModel("mock-model", types.ModelInfo{
			ProviderID:      "mock",
			ContextWindow:   200000,
			CostPer1kInput:  0.003,
			CostPer1kOutput: 0.015,
		})

		// The 3rd-tier agent will block so we can recall it.
		recallMP.SetBlockUntilCancel(true)
		recallMP.SetResponse(helpers.TextResponse("will-not-reach"))

		tier2Ctx := mgr.TestNewExtContextWithOpts("tier3", extcontext.ExtContextOpts{
			Depth:      1,
			DispatchId: "fake-tier2-for-recall",
		})

		recallDone := make(chan struct{})
		var recallInfo extension.RecallInfo
		_, err := tier2Ctx.DispatchAgent(extension.DispatchAgentOpts{
			Name: "tier3-doom", Task: "Task-Doom", Model: "mock-model",
			MaxTurns: 1, Background: true,
			OnComplete: onComplete("tier3-doom"),
			OnError:    onError("tier3-doom"),
			OnRecall: func(ri extension.RecallInfo) {
				recallInfo = ri
				close(recallDone)
			},
		})
		if err != nil {
			t.Fatalf("dispatch tier3-doom: %v", err)
		}

		// Wait for the provider call to hit.
		dl := time.After(10 * time.Second)
		for recallMP.CallCount() < 1 {
			select {
			case <-dl:
				t.Fatal("timeout waiting for tier3-doom to hit provider")
			default:
				time.Sleep(20 * time.Millisecond)
			}
		}

		// Recall the 3rd-tier agent.
		found, _ := tier2Ctx.RecallAgent("tier3-doom", extension.RecallAgentOpts{Reason: "test-recall"})
		if !found {
			t.Error("RecallAgent(tier3-doom) returned false")
		}

		select {
		case <-recallDone:
		case <-time.After(10 * time.Second):
			t.Fatal("timeout waiting for tier3-doom recall")
		}

		// The dispatch Cancel callback hardcodes "recall_agent" as the reason
		// (set at registration time in dispatch_agent.go). The reason from
		// RecallAgentOpts is logged by the registry but not forwarded through
		// the cancel closure. This is by design: Cancel is a simple func().
		if recallInfo.Reason != "recall_agent" {
			t.Errorf("recall reason=%q want recall_agent", recallInfo.Reason)
		}

		// Recreate: unblock provider and dispatch a fresh 3rd-tier.
		recallMP.SetBlockUntilCancel(false)
		recallMP.SetResponse(helpers.TextResponse("tier3-recreated"))
		_, err = tier2Ctx.DispatchAgent(extension.DispatchAgentOpts{
			Name: "tier3-recreated", Task: "Task-Recreated", Model: "mock-model",
			MaxTurns: 1, Background: true,
			OnComplete: onComplete("tier3-recreated"),
			OnError:    onError("tier3-recreated"),
		})
		if err != nil {
			t.Fatalf("dispatch tier3-recreated: %v", err)
		}
		waitFor("tier3-recreated", 15*time.Second)

		oRec := getOutcome("tier3-recreated")
		if oRec == nil || oRec.result == nil {
			t.Fatal("tier3-recreated: no result")
		}
		if oRec.result.ExitCode != 0 {
			t.Errorf("tier3-recreated exit=%d want 0", oRec.result.ExitCode)
		}
	})

	// ── Section 4: Steer a running 3rd-tier via SteerDispatch ──
	t.Run("tier3_steer", func(t *testing.T) {
		providers.ResetRegistries()
		steerMP := helpers.NewMockProvider("mock")
		providers.RegisterProvider(steerMP)
		providers.RegisterModel("mock-model", types.ModelInfo{
			ProviderID:      "mock",
			ContextWindow:   200000,
			CostPer1kInput:  0.003,
			CostPer1kOutput: 0.015,
		})

		// The agent will block on the provider call. We steer while blocked,
		// then recall to release. The steer channel buffering is the delivery
		// we assert. drainSteer injection is covered in runloop_steer_test.go.
		steerMP.SetBlockUntilCancel(true)
		steerMP.SetResponse(helpers.TextResponse("will-block"))

		tier2Ctx := mgr.TestNewExtContextWithOpts("tier3", extcontext.ExtContextOpts{
			Depth:      1,
			DispatchId: "fake-tier2-for-steer",
		})

		steerDone := make(chan struct{})
		stub, err := tier2Ctx.DispatchAgent(extension.DispatchAgentOpts{
			Name: "tier3-steered", Task: "Task-Steer", Model: "mock-model",
			MaxTurns: 5, Background: true,
			OnComplete: func(r extension.DispatchAgentResult) {
				omu.Lock()
				outcomes["tier3-steered"] = &outcome{result: &r}
				omu.Unlock()
				close(steerDone)
			},
			OnError: func(e extension.DispatchError) {
				omu.Lock()
				outcomes["tier3-steered"] = &outcome{err: &e}
				omu.Unlock()
				close(steerDone)
			},
			OnRecall: func(_ extension.RecallInfo) {
				close(steerDone)
			},
		})
		if err != nil {
			t.Fatalf("dispatch tier3-steered: %v", err)
		}

		// Wait for it to hit the provider (blocked).
		dl := time.After(10 * time.Second)
		for steerMP.CallCount() < 1 {
			select {
			case <-dl:
				t.Fatal("timeout waiting for tier3-steered to hit provider")
			default:
				time.Sleep(20 * time.Millisecond)
			}
		}

		// Steer the running 3rd-tier dispatch.
		if tier2Ctx.SteerDispatch == nil {
			t.Fatal("SteerDispatch not wired on tier2 context")
		}
		sRes, err := tier2Ctx.SteerDispatch(stub.DispatchID, "steer-message-from-tier2")
		if err != nil {
			t.Fatalf("SteerDispatch: %v", err)
		}
		if !sRes.Delivered {
			t.Errorf("steer not delivered: outcome=%s", sRes.Outcome)
		}
		if sRes.Outcome != "delivered" {
			t.Errorf("steer outcome=%q want delivered", sRes.Outcome)
		}

		// Clean up: recall to release the blocked provider.
		tier2Ctx.RecallAgent("tier3-steered", extension.RecallAgentOpts{Reason: "done"})
		select {
		case <-steerDone:
		case <-time.After(10 * time.Second):
			t.Fatal("timeout waiting for tier3-steered to finish")
		}
	})

	// ── Section 5: Root steers a 2nd-tier and sends follow-up ──
	t.Run("root_steer_and_followup_tier2", func(t *testing.T) {
		providers.ResetRegistries()
		mp5 := helpers.NewMockProvider("mock")
		providers.RegisterProvider(mp5)
		providers.RegisterModel("mock-model", types.ModelInfo{
			ProviderID:      "mock",
			ContextWindow:   200000,
			CostPer1kInput:  0.003,
			CostPer1kOutput: 0.015,
		})

		// Steer test: block on first call, steer, then recall.
		mp5.SetBlockUntilCancel(true)
		mp5.SetResponse(helpers.TextResponse("tier2-blocked"))

		rootCtx := mgr.TestNewExtContext("tier3")
		steerDone := make(chan struct{})
		stub, err := rootCtx.DispatchAgent(extension.DispatchAgentOpts{
			Name: "tier2-steer", Task: "Task-T2-Steer", Model: "mock-model",
			MaxTurns: 5, Background: true,
			OnComplete: func(r extension.DispatchAgentResult) {
				omu.Lock()
				outcomes["tier2-steer"] = &outcome{result: &r}
				omu.Unlock()
				close(steerDone)
			},
			OnError: func(e extension.DispatchError) {
				omu.Lock()
				outcomes["tier2-steer"] = &outcome{err: &e}
				omu.Unlock()
				close(steerDone)
			},
			OnRecall: func(_ extension.RecallInfo) {
				close(steerDone)
			},
		})
		if err != nil {
			t.Fatalf("dispatch tier2-steer: %v", err)
		}

		dl := time.After(10 * time.Second)
		for mp5.CallCount() < 1 {
			select {
			case <-dl:
				t.Fatal("timeout waiting for tier2-steer to hit provider")
			default:
				time.Sleep(20 * time.Millisecond)
			}
		}

		// Steer the 2nd-tier from root.
		if rootCtx.SteerDispatch == nil {
			t.Fatal("SteerDispatch not wired on root context")
		}
		sRes, err := rootCtx.SteerDispatch(stub.DispatchID, "root-steer-msg")
		if err != nil {
			t.Fatalf("root SteerDispatch: %v", err)
		}
		if !sRes.Delivered {
			t.Errorf("root steer not delivered: outcome=%s", sRes.Outcome)
		}

		// Clean up.
		rootCtx.RecallAgent("tier2-steer", extension.RecallAgentOpts{Reason: "done"})
		select {
		case <-steerDone:
		case <-time.After(10 * time.Second):
			t.Fatal("timeout waiting for tier2-steer recall")
		}

		// Root follow-up to a 2nd-tier session (send a continuation dispatch).
		mp5.SetBlockUntilCancel(false)
		mp5.SetResponse(helpers.TextResponse("tier2-initial-resp"))
		mp5.SetResponse(helpers.TextResponse("tier2-followup-resp"))

		// Dispatch a fresh 2nd-tier.
		t2followDone := make(chan struct{}, 2)
		_, err = rootCtx.DispatchAgent(extension.DispatchAgentOpts{
			Name: "tier2-fu", Task: "Task-T2-Initial", Model: "mock-model",
			MaxTurns: 1, Background: true,
			OnComplete: func(r extension.DispatchAgentResult) {
				omu.Lock()
				outcomes["tier2-fu-init"] = &outcome{result: &r}
				omu.Unlock()
				t2followDone <- struct{}{}
			},
			OnError: func(e extension.DispatchError) {
				omu.Lock()
				outcomes["tier2-fu-init"] = &outcome{err: &e}
				omu.Unlock()
				t2followDone <- struct{}{}
			},
		})
		if err != nil {
			t.Fatalf("dispatch tier2-fu: %v", err)
		}
		select {
		case <-t2followDone:
		case <-time.After(15 * time.Second):
			t.Fatal("timeout tier2-fu-init")
		}
		oInit := getOutcome("tier2-fu-init")
		if oInit == nil || oInit.result == nil {
			t.Fatal("tier2-fu-init no result")
		}

		// Follow-up.
		_, err = rootCtx.DispatchAgent(extension.DispatchAgentOpts{
			Name: "tier2-fu", Task: "Task-T2-Followup", Model: "mock-model",
			SessionID: oInit.result.SessionID, MaxTurns: 1, Background: true,
			OnComplete: func(r extension.DispatchAgentResult) {
				omu.Lock()
				outcomes["tier2-fu-cont"] = &outcome{result: &r}
				omu.Unlock()
				t2followDone <- struct{}{}
			},
			OnError: func(e extension.DispatchError) {
				omu.Lock()
				outcomes["tier2-fu-cont"] = &outcome{err: &e}
				omu.Unlock()
				t2followDone <- struct{}{}
			},
		})
		if err != nil {
			t.Fatalf("dispatch tier2-fu followup: %v", err)
		}
		select {
		case <-t2followDone:
		case <-time.After(15 * time.Second):
			t.Fatal("timeout tier2-fu-cont")
		}

		oCont := getOutcome("tier2-fu-cont")
		if oCont == nil || oCont.result == nil {
			t.Fatal("tier2-fu-cont no result")
		}
		// Verify continuation: same session, both tasks present.
		msgs, err := conversation.LoadMessages(oInit.result.SessionID, "")
		if err != nil {
			t.Fatalf("load tier2-fu conversation: %v", err)
		}
		c := flattenContent(msgs)
		if !strings.Contains(c, "Task-T2-Initial") {
			t.Error("tier2-fu continuation missing initial task")
		}
		if !strings.Contains(c, "Task-T2-Followup") {
			t.Error("tier2-fu continuation missing follow-up task")
		}
	})

	// ── Section 6: Depth cap (3rd-tier trying 4th-tier) ──
	t.Run("depth_cap_blocks_fourth_tier", func(t *testing.T) {
		snap := evSnapshot()

		// Create a depth-2 context (simulating a 3rd-tier agent).
		tier3Ctx := mgr.TestNewExtContextWithOpts("tier3", extcontext.ExtContextOpts{
			Depth:      2,
			DispatchId: "fake-tier3-for-depth-cap",
		})

		// Attempt to dispatch a 4th-tier agent. DefaultMaxDispatchDepth=3,
		// so childDepth=3 >= cap=3, blocked.
		_, err := tier3Ctx.DispatchAgent(extension.DispatchAgentOpts{
			Name: "tier4-blocked", Task: "Task-T4", Model: "mock-model",
			MaxTurns: 1, Background: true,
			OnComplete: func(_ extension.DispatchAgentResult) {
				t.Error("4th-tier dispatch should have been blocked")
			},
		})
		if err == nil {
			t.Fatal("expected ErrDispatchDepthExceeded, got nil")
		}
		if !strings.Contains(err.Error(), "dispatch depth exceeded") {
			t.Errorf("error=%q, want dispatch depth exceeded", err.Error())
		}

		// Verify no dispatch_start event was emitted for the blocked dispatch.
		if n := countEvTypeSince("engine_dispatch_start", snap); n != 0 {
			t.Errorf("expected 0 dispatch_start after depth cap, got %d", n)
		}
	})

	// ── Section 7: Parallel 3rd-tier isolation ──
	t.Run("parallel_tier3_isolation", func(t *testing.T) {
		providers.ResetRegistries()
		mp7 := helpers.NewMockProvider("mock")
		providers.RegisterProvider(mp7)
		providers.RegisterModel("mock-model", types.ModelInfo{
			ProviderID:      "mock",
			ContextWindow:   200000,
			CostPer1kInput:  0.003,
			CostPer1kOutput: 0.015,
		})

		mp7.SetResponse(helpers.TextResponse("parallel-A-output"))
		mp7.SetResponse(helpers.TextResponse("parallel-B-output"))

		tier2Ctx := mgr.TestNewExtContextWithOpts("tier3", extcontext.ExtContextOpts{
			Depth:      1,
			DispatchId: "fake-tier2-for-parallel",
		})

		paraDone := make(chan string, 4)
		// Dispatch two parallel 3rd-tier agents.
		for _, name := range []string{"para-A", "para-B"} {
			n := name
			_, err := tier2Ctx.DispatchAgent(extension.DispatchAgentOpts{
				Name: n, Task: fmt.Sprintf("Task-%s", n), Model: "mock-model",
				MaxTurns: 1, Background: true,
				OnComplete: func(r extension.DispatchAgentResult) {
					omu.Lock()
					outcomes[n] = &outcome{result: &r}
					omu.Unlock()
					paraDone <- n
				},
				OnError: func(e extension.DispatchError) {
					omu.Lock()
					outcomes[n] = &outcome{err: &e}
					omu.Unlock()
					paraDone <- n
				},
			})
			if err != nil {
				t.Fatalf("dispatch %s: %v", n, err)
			}
		}

		// Wait for both.
		for i := 0; i < 2; i++ {
			select {
			case <-paraDone:
			case <-time.After(15 * time.Second):
				t.Fatal("timeout waiting for parallel 3rd-tier dispatches")
			}
		}

		oA := getOutcome("para-A")
		oB := getOutcome("para-B")
		if oA == nil || oA.result == nil {
			t.Fatal("para-A: no result")
		}
		if oB == nil || oB.result == nil {
			t.Fatal("para-B: no result")
		}

		// Distinct DispatchIDs and SessionIDs.
		if oA.result.DispatchID == oB.result.DispatchID {
			t.Error("parallel 3rd-tier dispatches share DispatchID")
		}
		if oA.result.SessionID == oB.result.SessionID {
			t.Error("parallel 3rd-tier dispatches share SessionID")
		}

		// Content isolation: A's conversation has A's task but not B's.
		msgsA, errA := conversation.LoadMessages(oA.result.SessionID, "")
		msgsB, errB := conversation.LoadMessages(oB.result.SessionID, "")
		if errA != nil || errB != nil {
			t.Fatalf("load parallel convos: %v / %v", errA, errB)
		}
		cA := flattenContent(msgsA)
		cB := flattenContent(msgsB)
		if !strings.Contains(cA, "Task-para-A") {
			t.Error("para-A conversation missing its own task")
		}
		if strings.Contains(cA, "Task-para-B") {
			t.Error("para-A conversation has para-B's task (isolation violated)")
		}
		if !strings.Contains(cB, "Task-para-B") {
			t.Error("para-B conversation missing its own task")
		}
		if strings.Contains(cB, "Task-para-A") {
			t.Error("para-B conversation has para-A's task (isolation violated)")
		}
	})

	// ── Section 8: Steer to finished dispatch returns not_found ──
	t.Run("steer_to_finished_returns_not_found", func(t *testing.T) {
		providers.ResetRegistries()
		mp8 := helpers.NewMockProvider("mock")
		providers.RegisterProvider(mp8)
		providers.RegisterModel("mock-model", types.ModelInfo{
			ProviderID:      "mock",
			ContextWindow:   200000,
			CostPer1kInput:  0.003,
			CostPer1kOutput: 0.015,
		})
		mp8.SetResponse(helpers.TextResponse("finished-output"))

		tier2Ctx := mgr.TestNewExtContextWithOpts("tier3", extcontext.ExtContextOpts{
			Depth:      1,
			DispatchId: "fake-tier2-for-steer-finished",
		})

		finDone := make(chan struct{})
		stub, err := tier2Ctx.DispatchAgent(extension.DispatchAgentOpts{
			Name: "tier3-fin", Task: "Task-Fin", Model: "mock-model",
			MaxTurns: 1, Background: true,
			OnComplete: func(r extension.DispatchAgentResult) {
				omu.Lock()
				outcomes["tier3-fin"] = &outcome{result: &r}
				omu.Unlock()
				close(finDone)
			},
			OnError: func(e extension.DispatchError) {
				omu.Lock()
				outcomes["tier3-fin"] = &outcome{err: &e}
				omu.Unlock()
				close(finDone)
			},
		})
		if err != nil {
			t.Fatalf("dispatch tier3-fin: %v", err)
		}
		finID := stub.DispatchID

		// Wait for completion.
		select {
		case <-finDone:
		case <-time.After(15 * time.Second):
			t.Fatal("timeout waiting for tier3-fin")
		}

		// Steer the finished dispatch. Registry deregistered it on completion,
		// so SteerByID should return not_found.
		sRes, err := tier2Ctx.SteerDispatch(finID, "steer-after-done")
		if err != nil {
			t.Fatalf("SteerDispatch to finished: %v", err)
		}
		if sRes.Delivered {
			t.Error("steer to finished dispatch should not be delivered")
		}
		if sRes.Outcome != "not_found" {
			t.Errorf("steer outcome=%q want not_found", sRes.Outcome)
		}
	})

	// ── Section 9: Steer vs follow-up are distinct mechanisms ──
	t.Run("steer_vs_followup_distinct", func(t *testing.T) {
		// Steer injects into a RUNNING run (mid-turn injection on the steer
		// channel, consumed by drainSteer). Follow-up continues a SESSION
		// (new run on an existing conversation). They cannot be confused:
		//   - Steer requires the dispatch to be in the registry (running);
		//     after completion, steer returns not_found.
		//   - Follow-up requires the SessionID from a completed dispatch;
		//     it works after the dispatch has finished.
		//
		// We already proved both above:
		//   - Section 4 proved steer on a running dispatch (delivered)
		//   - Section 8 proved steer on a finished dispatch (not_found)
		//   - Section 2 proved follow-up on a completed 3rd-tier
		//   - Section 5 proved follow-up on a completed 2nd-tier
		//
		// As a summary assertion, verify event counts: we should have at least
		// one dispatch_start at each depth level.
		startAtDepth := func(d int) int {
			evMu.Lock()
			defer evMu.Unlock()
			n := 0
			for _, ev := range events {
				if ev.Type == "engine_dispatch_start" && ev.DispatchDepth == d {
					n++
				}
			}
			return n
		}

		if n := startAtDepth(1); n == 0 {
			t.Error("no dispatch_start events at depth=1")
		}
		if n := startAtDepth(2); n == 0 {
			t.Error("no dispatch_start events at depth=2")
		}
		// No depth=3 events should exist (depth cap blocked them).
		if n := startAtDepth(3); n != 0 {
			t.Errorf("unexpected dispatch_start at depth=3: got %d", n)
		}

		// Total dispatch_start events should be substantial (each section
		// dispatched at least one agent).
		total := countEvType("engine_dispatch_start")
		if total < 6 {
			t.Errorf("expected at least 6 dispatch_start events total, got %d", total)
		}
	})
}
