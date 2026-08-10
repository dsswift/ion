// transport.go — NDJSON JSON-RPC 2.0 framing over a stream pair.
//
// One JSON object per line, in both directions. The engine and the extension
// each originate requests, so this is a symmetric peer rather than a client:
// the read loop must route three shapes (inbound request, inbound
// notification, response to our own outbound request) and must keep serving
// inbound traffic while an outbound call is still pending.
//
// That last property is load-bearing, not incidental. Registering a webhook
// post-init is an ext/register_webhook call, and the engine fires the
// veto-capable webhook_registered hook *back at the extension* before it
// answers. An implementation that blocked the read loop on its own pending
// response would deadlock there.
package ion

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sync"
	"sync/atomic"
)

// extRequestIDBase is where extension-originated request ids start. The engine
// numbers its own requests from 1, so a shared low range would let a response
// be routed to the wrong pending call. Pinned by the engine's SDK contract
// manifest (wireConstants.extRequestIdBase).
const extRequestIDBase = 100000

// payloadWrapperKey is the key the engine wraps non-object hook payloads under,
// because a bare string cannot be merged into the params object alongside
// _ctx. Pinned by wireConstants.payloadWrapperKey.
const payloadWrapperKey = "_payload"

// ctxKey is where per-invocation context metadata rides on an inbound hook,
// tool, or command call. It is stripped before the payload reaches a handler.
// Pinned by wireConstants.ctxKey.
const ctxKey = "_ctx"

// maxFrameBytes caps a single NDJSON line. Hook payloads carrying conversation
// history are the large case; 32 MiB is far above any real frame and still
// bounds a runaway allocation from a malformed stream.
const maxFrameBytes = 32 << 20

// transport owns the byte-level protocol: framing, id allocation, the pending
// response table, and write serialisation.
type transport struct {
	in  io.Reader
	out interface{ Write([]byte) (int, error) }

	// writeMu serialises frame writes. Handlers run concurrently, so without
	// it two responses could interleave mid-line and produce unparseable
	// output.
	writeMu sync.Mutex

	nextID atomic.Int64

	pendMu  sync.Mutex
	pending map[int64]chan *rpcResponse

	closeOnce sync.Once
	done      chan struct{}
}

// rpcResponse is an inbound response to one of our outbound requests.
type rpcResponse struct {
	Result json.RawMessage `json:"result"`
	Error  *RPCError       `json:"error"`
}

// inboundMessage is the union of everything that can arrive on stdin. The
// combination of fields present determines which of the three shapes it is.
type inboundMessage struct {
	ID     *int64          `json:"id"`
	Method string          `json:"method"`
	Params json.RawMessage `json:"params"`
	Result json.RawMessage `json:"result"`
	Error  *RPCError       `json:"error"`
}

func newTransport(in io.Reader, out interface{ Write([]byte) (int, error) }) *transport {
	t := &transport{
		in:      in,
		out:     out,
		pending: make(map[int64]chan *rpcResponse),
		done:    make(chan struct{}),
	}
	t.nextID.Store(extRequestIDBase)
	return t
}

// writeFrame marshals v and writes it as one NDJSON line.
func (t *transport) writeFrame(v any) error {
	data, err := json.Marshal(v)
	if err != nil {
		return fmt.Errorf("marshal frame: %w", err)
	}
	data = append(data, '\n')
	t.writeMu.Lock()
	defer t.writeMu.Unlock()
	if _, err := t.out.Write(data); err != nil {
		return fmt.Errorf("write frame: %w", err)
	}
	return nil
}

// notify sends a fire-and-forget notification (no id, no response).
func (t *transport) notify(method string, params any) {
	// A notification failure has no reply to carry the error, so the only
	// way it becomes visible is a log line — and the logger itself is a
	// notification, so logging a log failure would recurse. Drop silently
	// for the log method, surface everything else on stderr, which the
	// engine drains into its own log.
	err := t.writeFrame(map[string]any{
		"jsonrpc": "2.0",
		"method":  method,
		"params":  params,
	})
	if err != nil && method != methodLog {
		t.notify(methodLog, logParams{
			Level:   "error",
			Message: "failed to write notification frame",
			Fields:  map[string]any{"method": method, "error": err.Error()},
		})
	}
}

// call sends a request and waits for its response, the caller's context, or
// the transport closing — whichever happens first.
//
// The engine applies no timeout of its own to an ext/* call, so the caller's
// context is the only bound. Cancelling it abandons the pending entry; a late
// response is then dropped by the read loop.
func (t *transport) call(c context.Context, method string, params any) (json.RawMessage, error) {
	id := t.nextID.Add(1) - 1
	ch := make(chan *rpcResponse, 1)

	t.pendMu.Lock()
	t.pending[id] = ch
	t.pendMu.Unlock()

	cleanup := func() {
		t.pendMu.Lock()
		delete(t.pending, id)
		t.pendMu.Unlock()
	}

	frame := map[string]any{
		"jsonrpc": "2.0",
		"id":      id,
		"method":  method,
	}
	if params != nil {
		frame["params"] = params
	}
	if err := t.writeFrame(frame); err != nil {
		cleanup()
		return nil, err
	}

	select {
	case resp := <-ch:
		cleanup()
		if resp.Error != nil {
			return nil, resp.Error
		}
		return resp.Result, nil
	case <-c.Done():
		cleanup()
		return nil, c.Err()
	case <-t.done:
		cleanup()
		return nil, ErrClosed
	}
}

// callWithID is call() with the request id surfaced to the caller. Only
// cancellable RPCs need it: ext/llm_call's cancellation notification is keyed
// by the in-flight request id.
func (t *transport) callWithID(c context.Context, method string, params any) (int64, <-chan *rpcResponse, func(), error) {
	id := t.nextID.Add(1) - 1
	ch := make(chan *rpcResponse, 1)

	t.pendMu.Lock()
	t.pending[id] = ch
	t.pendMu.Unlock()

	cleanup := func() {
		t.pendMu.Lock()
		delete(t.pending, id)
		t.pendMu.Unlock()
	}

	frame := map[string]any{"jsonrpc": "2.0", "id": id, "method": method}
	if params != nil {
		frame["params"] = params
	}
	if err := t.writeFrame(frame); err != nil {
		cleanup()
		return 0, nil, cleanup, err
	}
	return id, ch, cleanup, nil
}

// respond writes a successful response to an inbound request.
func (t *transport) respond(id int64, result any) {
	frame := map[string]any{"jsonrpc": "2.0", "id": id, "result": result}
	if err := t.writeFrame(frame); err != nil {
		t.notify(methodLog, logParams{
			Level:   "error",
			Message: "failed to write RPC response",
			Fields:  map[string]any{"id": id, "error": err.Error()},
		})
	}
}

// respondError writes an error response to an inbound request.
func (t *transport) respondError(id int64, code int, message string) {
	frame := map[string]any{
		"jsonrpc": "2.0",
		"id":      id,
		"error":   map[string]any{"code": code, "message": message},
	}
	if err := t.writeFrame(frame); err != nil {
		t.notify(methodLog, logParams{
			Level:   "error",
			Message: "failed to write RPC error response",
			Fields:  map[string]any{"id": id, "code": code, "error": err.Error()},
		})
	}
}

// serve reads frames until EOF, routing each to dispatch (inbound requests and
// notifications) or to the pending table (responses).
//
// Each inbound request runs on its own goroutine. That is what makes the
// reentrancy requirement fall out for free: a handler can issue its own
// outbound call and the read loop keeps servicing frames underneath it.
func (t *transport) serve(dispatch func(id *int64, method string, params json.RawMessage)) error {
	scanner := bufio.NewScanner(t.in)
	scanner.Buffer(make([]byte, 0, 64*1024), maxFrameBytes)

	for scanner.Scan() {
		line := scanner.Bytes()
		if len(line) == 0 {
			continue
		}
		// Copy: the scanner reuses its buffer, and the frame outlives this
		// iteration once it reaches a handler goroutine.
		frame := make([]byte, len(line))
		copy(frame, line)

		var msg inboundMessage
		if err := json.Unmarshal(frame, &msg); err != nil {
			// A malformed frame is the engine's problem, not ours, and
			// there is no id to answer on. Log so it is not silent.
			t.notify(methodLog, logParams{
				Level:   "warn",
				Message: "dropped unparseable inbound frame",
				Fields:  map[string]any{"error": err.Error(), "bytes": len(frame)},
			})
			continue
		}

		switch {
		case msg.ID != nil && msg.Method != "":
			// Inbound request. Own goroutine: see the reentrancy note above.
			id := *msg.ID
			method, params := msg.Method, msg.Params
			go dispatch(&id, method, params)
		case msg.ID != nil:
			// Response to one of ours.
			t.pendMu.Lock()
			ch, ok := t.pending[*msg.ID]
			t.pendMu.Unlock()
			if !ok {
				// Late response to an abandoned call (the caller's context
				// was cancelled). Expected; record at debug.
				t.notify(methodLog, logParams{
					Level:   "debug",
					Message: "response for unknown request id",
					Fields:  map[string]any{"id": *msg.ID},
				})
				continue
			}
			ch <- &rpcResponse{Result: msg.Result, Error: msg.Error}
		case msg.Method != "":
			// Inbound notification. Also its own goroutine so a handler
			// that calls back into the engine cannot stall the loop.
			method, params := msg.Method, msg.Params
			go dispatch(nil, method, params)
		}
	}

	t.close()

	if err := scanner.Err(); err != nil {
		if errors.Is(err, io.EOF) || errors.Is(err, io.ErrClosedPipe) {
			return nil
		}
		return fmt.Errorf("read loop: %w", err)
	}
	// Clean EOF: the engine closed the pipe, which is a normal shutdown.
	return nil
}

// close releases every pending caller and stops the serve loop.
func (t *transport) close() {
	t.closeOnce.Do(func() { close(t.done) })
}
