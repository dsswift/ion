package extcontext

import "github.com/dsswift/ion/engine/internal/extension"

// RootDispatchResultDelivery is implemented by a session accessor that can
// route a root-owned child completion through its durable prompt queue.
type RootDispatchResultDelivery interface {
	DeliverRootDispatchResult(result extension.DispatchAgentResult)
}
