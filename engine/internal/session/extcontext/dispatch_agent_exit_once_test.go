package extcontext

import (
	"sync"
	"testing"

	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/types"
)

// doubleExitChildBackend deterministically fires its OnExit callback twice for
// a single run, simulating the double-emitExit scenario (error path + cancel
// path). It drives the real production OnExit closure in dispatch_agent.go so
// the sync.Once guard around childDone.Done() is exercised end to end: without
// the guard, the second Done() drives the WaitGroup counter negative and Go
// panics fatally.
type doubleExitChildBackend struct {
	mu     sync.Mutex
	onNorm func(string, types.NormalizedEvent)
	onExit func(string, *int, *string, string)
}

func (d *doubleExitChildBackend) OnNormalized(fn func(string, types.NormalizedEvent)) {
	d.mu.Lock()
	d.onNorm = fn
	d.mu.Unlock()
}

func (d *doubleExitChildBackend) OnExit(fn func(string, *int, *string, string)) {
	d.mu.Lock()
	d.onExit = fn
	d.mu.Unlock()
}

func (d *doubleExitChildBackend) OnError(func(string, error))            {}
func (d *doubleExitChildBackend) Cancel(string) bool                     { return false }
func (d *doubleExitChildBackend) IsRunning(string) bool                  { return false }
func (d *doubleExitChildBackend) WriteToStdin(string, interface{}) error { return nil }
func (d *doubleExitChildBackend) FlushConversations()                    {}
func (d *doubleExitChildBackend) Capabilities() backend.BackendCapabilities {
	return backend.BackendCapabilities{
		Kind:         "mock",
		ContextModel: backend.ContextModelEngineOwned,
		PlanMode:     true,
		Steering:     true,
	}
}

func (d *doubleExitChildBackend) StartRun(requestID string, _ types.RunOptions) {
	d.mu.Lock()
	onNorm, onExit := d.onNorm, d.onExit
	d.mu.Unlock()
	go func() {
		if onNorm != nil {
			onNorm(requestID, types.NormalizedEvent{Data: &types.SessionInitEvent{SessionID: "conv-exit-once"}})
			onNorm(requestID, types.NormalizedEvent{Data: &types.TaskCompleteEvent{Result: "done", SessionID: "conv-exit-once"}})
		}
		if onExit != nil {
			zero := 0
			// Fire twice: this is the double-emitExit scenario the sync.Once
			// guard exists to survive.
			onExit(requestID, &zero, nil, "conv-exit-once")
			onExit(requestID, &zero, nil, "conv-exit-once")
		}
	}()
}

// TestDispatchExitOnce_DoubleFireNoPanic asserts that a child backend firing
// OnExit twice does not panic the dispatch. The childDoneOnce sync.Once guard
// in dispatch_agent.go absorbs the second Done() call.
//
// Revert-red: removing the sync.Once guard (calling childDone.Done() directly
// in the OnExit closure) drives the WaitGroup counter negative on the second
// fire, which is a fatal panic under -race and crashes this test.
func TestDispatchExitOnce_DoubleFireNoPanic(t *testing.T) {
	child := &doubleExitChildBackend{}
	acc := &idTestAccessor{child: child}

	dispatchFn := BuildDispatchAgentFunc(acc, nil, 0, "")

	result, err := dispatchFn(extension.DispatchAgentOpts{
		Name: "exit-once-agent",
		Task: "trigger double exit",
	})
	if err != nil {
		t.Fatalf("dispatch error: %v", err)
	}
	if result == nil {
		t.Fatal("expected non-nil dispatch result")
	}
}
