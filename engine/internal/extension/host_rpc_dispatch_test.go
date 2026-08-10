package extension

import (
	"encoding/json"
	"testing"
	"time"
)

// TestRPCDispatchAgentExecutionMode pins omitted WaitForCompletion as the
// asynchronous default and true as the only foreground opt-in. The handler
// receives the decoded option, so this fails if the public wire field disappears
// or routing silently reverts to the historic Background flag.
func TestRPCDispatchAgentExecutionMode(t *testing.T) {
	for _, tc := range []struct {
		name              string
		params            map[string]any
		wantWaitForFinish bool
	}{
		{name: "asynchronous by default", params: map[string]any{"name": "worker", "task": "work"}},
		{name: "foreground opt-in", params: map[string]any{"name": "worker", "task": "work", "waitForCompletion": true}, wantWaitForFinish: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := NewHost()
			responses := attachStdout(h)
			called := make(chan DispatchAgentOpts, 1)
			ctx := &Context{DispatchAgent: func(opts DispatchAgentOpts) (*DispatchAgentResult, error) {
				called <- opts
				return &DispatchAgentResult{DispatchID: "dispatch-1"}, nil
			}}
			raw, err := json.Marshal(map[string]any{"params": tc.params})
			if err != nil {
				t.Fatalf("marshal request: %v", err)
			}

			h.rpcDispatchAgent(ctx, 1, raw)
			select {
			case opts := <-called:
				if opts.WaitForCompletion != tc.wantWaitForFinish {
					t.Errorf("WaitForCompletion = %t, want %t", opts.WaitForCompletion, tc.wantWaitForFinish)
				}
				if gotAsyncCallbacks := opts.OnComplete != nil && opts.OnError != nil && opts.OnRecall != nil; gotAsyncCallbacks == tc.wantWaitForFinish {
					t.Errorf("asynchronous callbacks present = %t, want %t", gotAsyncCallbacks, !tc.wantWaitForFinish)
				}
			case <-time.After(time.Second):
				t.Fatal("DispatchAgent was not called")
			}
			response := readResponse(t, responses, time.Second)
			if response["error"] != nil {
				t.Errorf("dispatch response error = %v", response["error"])
			}
		})
	}
}
