package extcontext

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/types"
)

// aliasProbingChildBackend runs a callback at the moment the child run starts —
// i.e. while the dispatch is registered and live — so a test can observe
// registry state that only exists during the dispatch.
type aliasProbingChildBackend struct {
	runOptsCapturingChildBackend
	onStart func()
}

func (c *aliasProbingChildBackend) StartRun(requestID string, opts types.RunOptions) {
	if c.onStart != nil {
		c.onStart()
	}
	c.runOptsCapturingChildBackend.StartRun(requestID, opts)
}

// TestDispatchAgent_WiresAgentStatusGetterForChild is the regression test for a
// production wiring gap that logged "has nil AgentStatus getter: AgentStatus
// tool will be unavailable" hundreds of times in a single session.
//
// The dispatch path wired childCfg.AgentSpawner but never childCfg.AgentStatus,
// so a dispatched agent could CREATE children while being unable to LOOK UP
// what it had created — the AgentStatus tool answered "not available" for every
// dispatched agent. A lead in that position has to poll blind or re-dispatch.
//
// Removing the childCfg.AgentStatus assignment in dispatch_agent.go turns this
// red.
func TestDispatchAgent_WiresAgentStatusGetterForChild(t *testing.T) {
	registry := NewDispatchRegistry()
	child := &configCapturingChildBackend{}
	accessor := &bumpCountingAccessor{child: child}

	dispatch := BuildDispatchAgentFunc(accessor, registry, 0, "")
	if _, err := dispatch(extension.DispatchAgentOpts{
		WaitForCompletion: true,
		Name:              "status-aware-child",
		Task:              "inspect its own children",
	}); err != nil {
		t.Fatalf("dispatch: %v", err)
	}

	cfg := child.capturedConfig()
	if cfg == nil {
		t.Fatal("child must receive RunConfig")
	}
	if cfg.AgentStatus == nil {
		t.Fatal("child RunConfig.AgentStatus is nil: the dispatched agent cannot inspect the dispatches it spawns")
	}
	// Prove it is a live view of the registry rather than merely non-nil: a
	// getter wired to the wrong registry (or a captured empty snapshot) would
	// satisfy a nil check while still reporting nothing.
	registry.RegisterWithID("dispatch-visible", "grandchild", func() {}, nil, "sess-1", "", 2)
	entries := cfg.AgentStatus()
	found := false
	for _, e := range entries {
		if e.DispatchID == "dispatch-visible" {
			found = true
			break
		}
	}
	if !found {
		t.Errorf("AgentStatus getter returned %d entries and none was the registered dispatch; it is not reading the live registry", len(entries))
	}
}

// TestDispatchAgent_NilRegistryLeavesAgentStatusUnwired pins the degraded path.
// A nil registry (tests, embedded callers) must leave the getter unset so the
// tool reports unavailable, rather than installing a getter that would
// nil-deref on the first call.
func TestDispatchAgent_NilRegistryLeavesAgentStatusUnwired(t *testing.T) {
	child := &configCapturingChildBackend{}
	accessor := &bumpCountingAccessor{child: child}

	dispatch := BuildDispatchAgentFunc(accessor, nil, 0, "")
	if _, err := dispatch(extension.DispatchAgentOpts{
		WaitForCompletion: true,
		Name:              "no-registry-child",
		Task:              "run without a registry",
	}); err != nil {
		t.Fatalf("dispatch: %v", err)
	}

	cfg := child.capturedConfig()
	if cfg == nil {
		t.Fatal("child must receive RunConfig")
	}
	if cfg.AgentStatus != nil {
		t.Error("AgentStatus must stay nil when there is no registry to read")
	}
}

// TestDispatchAgent_RegistersClientDispatchIDAlias pins the consumer-id alias
// at its real call site: supplying ClientDispatchID must make a steer addressed
// with the consumer's own key reach this dispatch. Without it the harness key
// misses and the engine answers not_found — indistinguishable from a finished
// dispatch, which is why the failure was silent in production.
//
// The assertion runs from inside the child's StartRunWithConfig, which executes
// while the dispatch is live. Checking after dispatch() returns would prove
// nothing: the entry and its alias are both gone by then, so a completely
// unwired alias would pass just as well.
func TestDispatchAgent_RegistersClientDispatchIDAlias(t *testing.T) {
	registry := NewDispatchRegistry()
	const consumerID = "local-1787795586436-47f66a"

	var resolvedWhileLive string
	var resolvedOK bool
	child := &aliasProbingChildBackend{
		onStart: func() {
			registry.mu.Lock()
			defer registry.mu.Unlock()
			resolvedWhileLive, _, resolvedOK = registry.resolveIDLocked(consumerID)
		},
	}
	accessor := &bumpCountingAccessor{child: child}

	dispatch := BuildDispatchAgentFunc(accessor, registry, 0, "")
	res, err := dispatch(extension.DispatchAgentOpts{
		WaitForCompletion: true,
		Name:              "aliased-child",
		Task:              "work",
		ClientDispatchID:  consumerID,
	})
	if err != nil {
		t.Fatalf("dispatch: %v", err)
	}
	if res == nil || res.DispatchID == "" {
		t.Fatal("dispatch returned no canonical dispatch id")
	}

	if !resolvedOK {
		t.Fatal("consumer dispatch id did not resolve to a live dispatch while the child was running")
	}
	if resolvedWhileLive != res.DispatchID {
		t.Errorf("consumer id resolved to %q, want the canonical dispatch id %q", resolvedWhileLive, res.DispatchID)
	}

	// The alias must not outlive the dispatch, or a consumer that reuses its
	// key would have a stale alias silently redirect a later steer onto a dead
	// entry — a failure that looks like success.
	registry.mu.Lock()
	remaining := len(registry.aliases)
	registry.mu.Unlock()
	if remaining != 0 {
		t.Errorf("alias map holds %d entries after the dispatch completed, want 0", remaining)
	}
}

// TestDispatchAgent_OmittedClientDispatchIDRegistersNoAlias pins that the field
// is genuinely optional: omitting it must leave the alias map untouched rather
// than registering an empty key that any later empty-string lookup could hit.
func TestDispatchAgent_OmittedClientDispatchIDRegistersNoAlias(t *testing.T) {
	registry := NewDispatchRegistry()
	child := &configCapturingChildBackend{}
	accessor := &bumpCountingAccessor{child: child}

	dispatch := BuildDispatchAgentFunc(accessor, registry, 0, "")
	if _, err := dispatch(extension.DispatchAgentOpts{
		WaitForCompletion: true,
		Name:              "plain-child",
		Task:              "work",
	}); err != nil {
		t.Fatalf("dispatch: %v", err)
	}

	registry.mu.Lock()
	aliasCount := len(registry.aliases)
	registry.mu.Unlock()
	if aliasCount != 0 {
		t.Errorf("alias map holds %d entries after a dispatch with no ClientDispatchID, want 0", aliasCount)
	}
}
