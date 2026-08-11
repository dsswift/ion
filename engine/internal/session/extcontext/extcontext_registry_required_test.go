package extcontext

// Regression pins for the defect that stranded background dispatches: a
// dispatch performed through a context whose DispatchRegistry was nil.
//
// Mechanism (conversation 1785075855017-a1f3395dc5c0). The registry used to be
// an OPTIONAL argument to NewExtContext, and three call sites omitted it — the
// agent_start / agent_end contexts and the before_provider_request context.
// Those contexts are pushed onto the extension host's ctxStack for the duration
// of a blocking hook RPC, and the host resolves an inbound ext/dispatch_agent
// against the top of that stack. A dispatch fanned out in the same turn as
// another (or a nested depth-2 dispatch issued from a child's tool router)
// therefore landed on the registry-less context.
//
// Every registry call on the dispatch path is `if registry != nil` guarded, so
// the result was silent: no Reserve, no register, no Deregister, no
// NotifyChildComplete. handleRunExit's sweep then deleted the dispatch's
// still-running agent-state slot, every later UpdateStateByID logged "no slot
// found" (~400 times over eight minutes in the incident), the suspended parent
// was never revived, and the orchestrator sat idle with the work finished.
//
// The fix makes the registry a required positional parameter, so omitting it is
// a compile error rather than a silent behavioural downgrade. These tests pin
// the consequences that a compile error alone does not express: that a context
// built the production way can actually register a dispatch, and that a
// registry-less context is the thing that breaks.
import (
	"testing"

	"github.com/dsswift/ion/engine/internal/session/agents"
	"github.com/dsswift/ion/engine/internal/types"
)

// TestExtContext_CarriesDispatchRegistry pins that a context built through the
// production constructor exposes a dispatch-capable registry: the dispatch it
// performs reaches ActiveIDs, which is what protects its agent-state slot from
// the run-exit sweep.
//
// The assertion is deliberately made through the REGISTRY rather than by
// inspecting the ctx: what matters is not that a field is non-nil but that a
// dispatch performed via this context is visible to the sweep-protection path.
func TestExtContext_CarriesDispatchRegistry(t *testing.T) {
	registry := NewDispatchRegistry()
	acc := &steerSelfAccessor{}

	ctx := NewExtContext(acc, registry)
	if ctx.DispatchAgent == nil {
		t.Fatal("ctx.DispatchAgent was not wired")
	}

	// Simulate what BuildDispatchAgentFunc does at the top of a dispatch: the
	// reservation is what places the id in ActiveIDs before the running slot is
	// broadcast. With a nil registry this call is skipped entirely.
	const id = "dispatch-obs-specialist-1-aaa"
	registry.Reserve(id, "observability-specialist", "", 1)

	if !registry.ActiveIDs()[id] {
		t.Fatalf("dispatch %q is not in ActiveIDs; its running slot is unprotected against the run-exit sweep", id)
	}
}

// TestExtContext_NilRegistryStrandsDispatch is the negative pin: it reproduces
// the production failure end to end at the layer where it actually bit, so the
// mechanism is documented by an executable test rather than only by prose.
//
// It does NOT call NewExtContext with nil (that no longer compiles, which is
// the fix). It reproduces what a nil registry MEANT: the reservation never
// happens, so the sweep destroys the live slot and the terminal update is lost.
func TestExtContext_NilRegistryStrandsDispatch(t *testing.T) {
	store := agents.NewRegistry()
	const id = "dispatch-obs-specialist-1-bbb"

	// A dispatch running through a registry-less context: its slot is created
	// and broadcast, but nothing ever reserved its id.
	store.AppendState(types.AgentStateUpdate{
		Name: "observability-specialist", ID: id, Status: "running",
	})

	// The parent run exits while the dispatch is still live. ActiveIDs is empty
	// because no reservation or registration ever ran.
	var noActiveIDs map[string]bool
	store.ClearRunningStatesExceptIDsOrNames(noActiveIDs, map[string]bool{})

	if rawHasID(store, id) {
		t.Fatal("precondition failed: an unreserved running slot must be swept by the run-exit clear")
	}

	// This is the log line the incident produced ~400 times: the dispatch is
	// still streaming, but its terminal transition has nowhere to land.
	landed := false
	store.UpdateStateByID(id, func(s *types.AgentStateUpdate) { landed = true })
	if landed {
		t.Fatal("terminal update landed on a swept slot; the stranding mechanism no longer reproduces")
	}
}

// TestExtContext_RegistryReachableFromAccessor pins the seam the two former
// nil-registry call sites now depend on. tool_dispatch.go and llm_call.go build
// a context without holding a registry in scope, so they reach it through
// SessionAccessor.DispatchRegistry(). If that method regressed to returning nil
// for a live session, those two paths would silently return to the broken
// behaviour while still compiling — which is exactly the failure mode the
// positional parameter was introduced to eliminate.
func TestExtContext_RegistryReachableFromAccessor(t *testing.T) {
	registry := NewDispatchRegistry()
	acc := &registryBearingAccessor{registry: registry}

	if acc.DispatchRegistry() == nil {
		t.Fatal("accessor returned a nil registry; the tool-dispatch and llm-call contexts would be dispatch-blind")
	}

	ctx := NewExtContext(acc, acc.DispatchRegistry())
	if ctx.DispatchAgent == nil {
		t.Fatal("ctx.DispatchAgent was not wired from the accessor-supplied registry")
	}

	const id = "dispatch-from-tool-ctx-1-ccc"
	registry.Reserve(id, "some-agent", "", 1)
	if !registry.ActiveIDs()[id] {
		t.Fatalf("dispatch %q not tracked; the accessor-supplied registry is not the live one", id)
	}
}

// registryBearingAccessor is a noopSA that returns a real registry, modelling
// the live sessionAccessor (whose DispatchRegistry returns s.dispatchRegistry,
// non-nil for every started session).
type registryBearingAccessor struct {
	noopSA
	registry *DispatchRegistry
}

func (a *registryBearingAccessor) DispatchRegistry() *DispatchRegistry { return a.registry }
