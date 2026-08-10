package ion

import (
	"encoding/json"
	"io"
	"sync"
	"testing"
	"time"
)

// enginefake_test.go — an in-memory stand-in for the engine.
//
// Two pipes wired to an SDK's transport. The test writes frames the engine
// would send and reads the frames the SDK writes back, so every assertion is
// about real wire bytes rather than about internal calls. That is the point:
// the framing, the id numbering, the envelope split, and the response shapes
// are the contract, and only a byte-level harness can pin them.

// fakeEngine drives an SDK over in-memory pipes.
type fakeEngine struct {
	t *testing.T

	// toSDK is what the engine writes and the SDK reads.
	toSDK *io.PipeWriter
	// fromSDK yields the frames the SDK wrote.
	fromSDK *io.PipeReader

	sdk *SDK

	mu     sync.Mutex
	frames []map[string]any
	// waiters are per-predicate channels signalled as frames arrive.
	waiters []*frameWaiter

	readDone chan struct{}
	runDone  chan error
}

type frameWaiter struct {
	match func(map[string]any) bool
	ch    chan map[string]any
	once  sync.Once
}

// newFakeEngine wires an SDK to in-memory pipes and starts serving. The SDK is
// returned unstarted-but-serving: registration must happen through opts before
// this is called, or via the returned sdk before the init frame is sent.
func newFakeEngine(t *testing.T, opts ...Option) *fakeEngine {
	t.Helper()

	// io.Pipe returns (reader, writer). The engine writes to engineToSDK and
	// the SDK reads sdkReads; the SDK writes sdkWrites and the engine reads
	// engineReads.
	sdkReads, engineToSDK := io.Pipe()
	engineReads, sdkWrites := io.Pipe()

	fe := &fakeEngine{
		t:        t,
		toSDK:    engineToSDK,
		fromSDK:  engineReads,
		readDone: make(chan struct{}),
		runDone:  make(chan error, 1),
	}

	all := append([]Option{WithInput(sdkReads), WithOutput(sdkWrites)}, opts...)
	fe.sdk = New(all...)

	go fe.readFrames()

	t.Cleanup(func() {
		if err := engineToSDK.Close(); err != nil {
			t.Logf("closing engine->sdk pipe: %v", err)
		}
		select {
		case <-fe.runDone:
		case <-time.After(2 * time.Second):
			t.Log("SDK serve loop did not exit within 2s of pipe close")
		}
		if err := sdkWrites.Close(); err != nil {
			t.Logf("closing sdk->engine pipe: %v", err)
		}
	})

	return fe
}

// start begins the SDK's serve loop. Call after registering handlers.
func (fe *fakeEngine) start() {
	go func() { fe.runDone <- fe.sdk.transport.serve(fe.sdk.dispatch) }()
}

// readFrames consumes the SDK's output, recording each frame and waking any
// matching waiter.
func (fe *fakeEngine) readFrames() {
	defer close(fe.readDone)
	dec := json.NewDecoder(fe.fromSDK)
	for {
		var frame map[string]any
		if err := dec.Decode(&frame); err != nil {
			return
		}
		fe.mu.Lock()
		fe.frames = append(fe.frames, frame)
		waiters := fe.waiters
		fe.mu.Unlock()

		for _, w := range waiters {
			if w.match(frame) {
				f := frame
				w.once.Do(func() { w.ch <- f })
			}
		}
	}
}

// send writes a raw frame to the SDK.
func (fe *fakeEngine) send(frame map[string]any) {
	fe.t.Helper()
	data, err := json.Marshal(frame)
	if err != nil {
		fe.t.Fatalf("marshal frame: %v", err)
	}
	data = append(data, '\n')
	if _, err := fe.toSDK.Write(data); err != nil {
		fe.t.Fatalf("write frame to SDK: %v", err)
	}
}

// sendRaw writes arbitrary bytes, for framing tests that need control over
// where the writes are split.
func (fe *fakeEngine) sendRaw(b []byte) {
	fe.t.Helper()
	if _, err := fe.toSDK.Write(b); err != nil {
		fe.t.Fatalf("write raw bytes to SDK: %v", err)
	}
}

// request sends an inbound request with the given id.
func (fe *fakeEngine) request(id int64, method string, params any) {
	frame := map[string]any{"jsonrpc": "2.0", "id": id, "method": method}
	if params != nil {
		frame["params"] = params
	}
	fe.send(frame)
}

// notify sends an inbound notification.
func (fe *fakeEngine) notify(method string, params any) {
	frame := map[string]any{"jsonrpc": "2.0", "method": method}
	if params != nil {
		frame["params"] = params
	}
	fe.send(frame)
}

// respond answers an outbound SDK request.
func (fe *fakeEngine) respond(id float64, result any) {
	fe.send(map[string]any{"jsonrpc": "2.0", "id": id, "result": result})
}

// respondError answers an outbound SDK request with an error.
func (fe *fakeEngine) respondError(id float64, code int, message string) {
	fe.send(map[string]any{
		"jsonrpc": "2.0",
		"id":      id,
		"error":   map[string]any{"code": code, "message": message},
	})
}

// await blocks until a frame matching the predicate arrives, checking frames
// already received first so a fast SDK cannot lose the race.
func (fe *fakeEngine) await(match func(map[string]any) bool) map[string]any {
	fe.t.Helper()

	w := &frameWaiter{match: match, ch: make(chan map[string]any, 1)}

	fe.mu.Lock()
	for _, f := range fe.frames {
		if match(f) {
			fe.mu.Unlock()
			return f
		}
	}
	fe.waiters = append(fe.waiters, w)
	fe.mu.Unlock()

	select {
	case f := <-w.ch:
		return f
	case <-time.After(5 * time.Second):
		fe.mu.Lock()
		got := len(fe.frames)
		all := fe.frames
		fe.mu.Unlock()
		fe.t.Fatalf("timed out waiting for a matching frame after %d frames: %+v", got, all)
		return nil
	}
}

// awaitResponse waits for the SDK's response to a given request id.
func (fe *fakeEngine) awaitResponse(id int64) map[string]any {
	fe.t.Helper()
	return fe.await(func(f map[string]any) bool {
		fid, ok := f["id"].(float64)
		return ok && int64(fid) == id && f["method"] == nil
	})
}

// awaitMethod waits for an outbound request or notification naming method.
func (fe *fakeEngine) awaitMethod(method string) map[string]any {
	fe.t.Helper()
	return fe.await(func(f map[string]any) bool { return f["method"] == method })
}

// awaitLog waits for a log notification whose message contains substr.
func (fe *fakeEngine) awaitLog(substr string) map[string]any {
	fe.t.Helper()
	return fe.await(func(f map[string]any) bool {
		if f["method"] != methodLog {
			return false
		}
		params, ok := f["params"].(map[string]any)
		if !ok {
			return false
		}
		msg, _ := params["message"].(string)
		return contains(msg, substr)
	})
}

// doInit performs the handshake and returns the SDK's init result.
func (fe *fakeEngine) doInit(cfg ExtensionConfig) map[string]any {
	fe.t.Helper()
	fe.request(1, methodInit, cfg)
	resp := fe.awaitResponse(1)
	result, ok := resp["result"].(map[string]any)
	if !ok {
		fe.t.Fatalf("init result is not an object: %+v", resp)
	}
	return result
}

// allFrames returns a snapshot of every frame the SDK has written.
func (fe *fakeEngine) allFrames() []map[string]any {
	fe.mu.Lock()
	defer fe.mu.Unlock()
	out := make([]map[string]any, len(fe.frames))
	copy(out, fe.frames)
	return out
}

func contains(haystack, needle string) bool {
	return len(needle) == 0 || (len(haystack) >= len(needle) && indexOf(haystack, needle) >= 0)
}

func indexOf(haystack, needle string) int {
	for i := 0; i+len(needle) <= len(haystack); i++ {
		if haystack[i:i+len(needle)] == needle {
			return i
		}
	}
	return -1
}
