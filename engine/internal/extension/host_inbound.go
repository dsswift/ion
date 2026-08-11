package extension

import (
	"sync"

	"github.com/dsswift/ion/engine/internal/utils"
)

// inboundMsg is one extension-initiated JSON-RPC message (request or
// notification) captured off the wire, ready for dispatch.
//
// raw is a copy: bufio.Scanner reuses its token buffer on the next Scan, so a
// message handed to another goroutine must own its bytes.
//
// reqCtx is the ctxStack top as it stood when the readLoop *read* the frame,
// not when the dispatcher gets to it. Capturing at read time keeps the
// dispatch context identical to the synchronous behaviour this queue replaced.
type inboundMsg struct {
	method string
	id     int64
	isReq  bool
	reqCtx *Context
	raw    []byte
}

// inboundDispatcher serialises extension-initiated dispatch on a goroutine of
// its own, so the readLoop only ever reads and routes.
//
// Why this exists: the readLoop is the sole reader of a host's stdout, so it is
// also the sole deliverer of responses to engine→extension calls. Dispatching
// an inbound message inline meant any handler that blocked — on the session
// manager lock, on a network call, on another extension — stopped responses
// from being read at all. That produced a hard deadlock cycle: SendPrompt held
// the manager write lock while awaiting a context_inject hook, the same host's
// readLoop sat in an ext/emit notification waiting for a manager read lock, and
// the hook's response was stuck unread in the pipe. The engine wedged with no
// timeout to break it (extension calls wait indefinitely by contract).
//
// Two earlier point fixes made individual handlers async (the steer RPCs; see
// TestSteerRPC_DoesNotDeadlockReadLoop). Those left every other handler exposed,
// which is how ext/emit reproduced the same deadlock. This queue is the general
// form: no inbound handler runs on the readLoop, whatever it does.
//
// The queue is unbounded and FIFO. Unbounded because a bounded one would block
// the readLoop when full, reintroducing the bug it exists to prevent. FIFO on a
// single worker because dispatch order is observable — ext/emit carries engine
// events whose order consumers depend on — and because it preserves exactly the
// serialisation handlers had when they ran inline.
type inboundDispatcher struct {
	mu     sync.Mutex
	cond   *sync.Cond
	queue  []inboundMsg
	closed bool

	// depthWarnAt is the next queue depth that warrants a WARN. It doubles on
	// each report so a persistently stalled handler logs a few times instead of
	// once per message.
	depthWarnAt int
}

// inboundDepthWarnStart is the queue depth at which a backlog first warns. A
// healthy host holds at most a couple of messages; hundreds means a handler is
// stalled or the extension is flooding.
const inboundDepthWarnStart = 128

// startInboundDispatcher creates the queue and its worker. The caller owns the
// returned dispatcher and must close() it when the readLoop exits.
func startInboundDispatcher(h *Host) *inboundDispatcher {
	d := &inboundDispatcher{depthWarnAt: inboundDepthWarnStart}
	d.cond = sync.NewCond(&d.mu)
	utils.LogWithFields(utils.LevelDebug, "extension", "inbound dispatcher started", map[string]any{"model": h.name_()})
	go d.run(h)
	return d
}

// enqueue appends a message. It never blocks on a handler, which is the whole
// point: the readLoop must return to Scan() immediately.
func (d *inboundDispatcher) enqueue(h *Host, m inboundMsg) {
	d.mu.Lock()
	if d.closed {
		d.mu.Unlock()
		utils.LogWithFields(utils.LevelInfo, "extension", "inbound message dropped: dispatcher closed", map[string]any{"model": h.name_(), "method": m.method})
		return
	}
	d.queue = append(d.queue, m)
	depth := len(d.queue)
	warn := depth >= d.depthWarnAt
	if warn {
		d.depthWarnAt *= 2
	}
	d.cond.Signal()
	d.mu.Unlock()

	if warn {
		utils.LogWithFields(utils.LevelWarn, "extension", "inbound dispatch backlog growing; a handler is slow or stalled", map[string]any{
			"model": h.name_(), "count": depth, "method": m.method,
		})
	}
}

// close stops the worker once the queue drains. Messages already read off the
// wire are still dispatched — they were delivered, so they are handled.
func (d *inboundDispatcher) close() {
	d.mu.Lock()
	d.closed = true
	d.cond.Broadcast()
	d.mu.Unlock()
}

// run is the worker: pop one message, dispatch it to completion, repeat.
func (d *inboundDispatcher) run(h *Host) {
	for {
		d.mu.Lock()
		for len(d.queue) == 0 && !d.closed {
			d.cond.Wait()
		}
		if len(d.queue) == 0 && d.closed {
			d.mu.Unlock()
			utils.LogWithFields(utils.LevelDebug, "extension", "inbound dispatcher stopped", map[string]any{"model": h.name_()})
			return
		}
		m := d.queue[0]
		d.queue = d.queue[1:]
		d.mu.Unlock()

		if m.isReq {
			h.handleExtRequestWithContext(m.method, m.id, m.reqCtx, m.raw)
		} else {
			h.handleExtNotification(m.method, m.raw)
		}
	}
}
