package appconfig

import (
	"context"
	"sync"

	"github.com/dsswift/ion/engine/internal/utils"
)

// The process-wide store and transition subscribers. Subscribers register
// independently of the store so a consumer wired before configuration is
// loaded still sees every transition once a store is installed.
var (
	registryMu     sync.RWMutex
	installed      *Store
	subscribers    = make(map[uint64]func(Snapshot))
	nextSubscriber uint64
)

// Install makes store the process-wide application config store. Nil
// uninstalls it, returning every reader to the disabled state.
func Install(store *Store) {
	registryMu.Lock()
	installed = store
	registryMu.Unlock()
	utils.LogWithFields(utils.LevelInfo, "appconfig", "application config store installed", map[string]any{"configured": store != nil})
}

// Current returns the installed store, or nil when the subsystem is inert.
func Current() *Store {
	registryMu.RLock()
	defer registryMu.RUnlock()
	return installed
}

// Read returns the view subject may see. With no store installed it
// returns the disabled state, so an unconfigured engine is distinguishable
// from one still waiting for a principal.
func Read(subject string) Snapshot {
	store := Current()
	if store == nil {
		return Snapshot{State: StateDisabled}
	}
	return store.Snapshot().For(subject)
}

// Await waits for subject's view to settle. With no store installed it
// returns the disabled state at once.
func Await(ctx context.Context, subject string) (Snapshot, error) {
	store := Current()
	if store == nil {
		return Snapshot{State: StateDisabled}, nil
	}
	return store.Await(ctx, subject)
}

// Subscribe receives every transition of the installed store, in order, as
// a complete process-level snapshot. Callbacks run on the store's delivery
// goroutine, never under a store lock; a consumer scopes a snapshot to a
// reader with Snapshot.For.
func Subscribe(fn func(Snapshot)) (unsubscribe func()) {
	registryMu.Lock()
	id := nextSubscriber
	nextSubscriber++
	subscribers[id] = fn
	registryMu.Unlock()
	return func() {
		registryMu.Lock()
		delete(subscribers, id)
		registryMu.Unlock()
	}
}

func deliver(snapshot Snapshot) {
	registryMu.RLock()
	callbacks := make([]func(Snapshot), 0, len(subscribers))
	for _, callback := range subscribers {
		callbacks = append(callbacks, callback)
	}
	registryMu.RUnlock()
	for _, callback := range callbacks {
		callback(snapshot.clone())
	}
}

// notifier delivers transitions to subscribers in the order they happened
// without ever blocking the transition itself: the queue is unbounded and
// drained by one goroutine.
type notifier struct {
	mu     sync.Mutex
	cond   *sync.Cond
	queue  []Snapshot
	closed bool
	done   chan struct{}
}

func newNotifier() *notifier {
	n := &notifier{done: make(chan struct{})}
	n.cond = sync.NewCond(&n.mu)
	go n.loop()
	return n
}

func (n *notifier) enqueue(snapshot Snapshot) {
	n.mu.Lock()
	if !n.closed {
		n.queue = append(n.queue, snapshot)
		n.cond.Signal()
	}
	n.mu.Unlock()
}

// close stops delivery after the queued transitions drain.
func (n *notifier) close() {
	n.mu.Lock()
	n.closed = true
	n.cond.Signal()
	n.mu.Unlock()
	<-n.done
}

func (n *notifier) loop() {
	defer close(n.done)
	for {
		n.mu.Lock()
		for len(n.queue) == 0 && !n.closed {
			n.cond.Wait()
		}
		if len(n.queue) == 0 {
			n.mu.Unlock()
			return
		}
		next := n.queue[0]
		n.queue = n.queue[1:]
		n.mu.Unlock()
		deliver(next)
	}
}
