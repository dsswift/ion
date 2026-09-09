package extcontext

import "github.com/dsswift/ion/engine/internal/extension"

// RootDispatchResultDelivery is implemented by a session accessor that can
// route a root-owned child completion through its durable prompt queue.
type RootDispatchResultDelivery interface {
	DeliverRootDispatchResult(result extension.DispatchAgentResult)
}

// RootDispatchTracker is implemented by a session accessor that keeps the
// dispatch identity live until its terminal root callback is handled. The
// registry deregisters before that callback, so a full session stop needs this
// second identity record to fence the otherwise-racy late delivery.
type RootDispatchTracker interface {
	TrackRootDispatch(dispatchID string)
}
