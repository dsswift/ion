package resource

import (
	"fmt"

	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// WildcardKind is the sentinel kind that subscribes to every resource kind
// on a broker — every kind that has a registered producer now, plus every
// kind registered or published in the future. It is pure data routing: a
// wildcard subscriber receives the same snapshot/delta envelopes an
// exact-kind subscriber would, with ResourceMessage.Kind always carrying the
// real item kind (never "*"), so consumers bucket by the true kind.
//
// This exists because "subscribe to everything" cannot be expressed by a
// consumer without a primitive, and a hardcoded kind list in the consumer is
// exactly the baked-in opinion the resource subsystem is designed to avoid.
// The broker already routes by kind; the wildcard is a routing addition with
// no render/UI policy.
const WildcardKind = "*"

// IsWildcard reports whether kind is the wildcard sentinel.
func IsWildcard(kind string) bool { return kind == WildcardKind }

// SubscribeWildcard registers a subscription that receives events for every
// kind on the broker. It aggregates an initial snapshot by querying every
// registered producer with the subscription's filter, delivers one snapshot
// per producing kind (each carrying that kind), then stores the subscription
// under the wildcard key so the publish paths fan subsequent deltas to it.
//
// Unlike Subscribe, this never errors on "no producer" — a broker with zero
// producers yields zero snapshot messages, and the subscriber still receives
// every future kind's deltas once producers register and publish.
func (b *Broker) SubscribeWildcard(filter types.ResourceFilter, deliver func(ResourceMessage)) *Subscription {
	subID := fmt.Sprintf("sub-%d", b.nextSubID.Add(1))
	sub := &Subscription{
		ID:      subID,
		Kind:    WildcardKind,
		Filter:  filter,
		deliver: deliver,
	}

	// Snapshot the producer set under the lock, register the subscription,
	// then query producers outside the lock (HandleQuery may block on
	// extension I/O).
	b.mu.Lock()
	b.subscribers[WildcardKind] = append(b.subscribers[WildcardKind], sub)
	b.subsByID[subID] = sub
	producers := make([]*producerEntry, 0, len(b.producers))
	for _, entry := range b.producers {
		producers = append(producers, entry)
	}
	b.mu.Unlock()

	utils.Log("resource", fmt.Sprintf("subscribeWildcard sub=%s producers=%d", subID, len(producers)))

	// Deliver one snapshot per registered kind, each carrying the real kind.
	for _, entry := range producers {
		kindFilter := filter
		kindFilter.Kind = entry.kind
		items, err := entry.host.HandleQuery(kindFilter)
		if err != nil {
			utils.Log("resource", fmt.Sprintf("subscribeWildcard HandleQuery failed kind=%s sub=%s err=%v", entry.kind, subID, err))
			items = nil
		}
		deliver(ResourceMessage{
			Type:  "snapshot",
			Kind:  entry.kind,
			SubID: subID,
			Items: items,
		})
		utils.Debug("resource", fmt.Sprintf("subscribeWildcard snapshot kind=%s sub=%s items=%d", entry.kind, subID, len(items)))
	}
	return sub
}

// SubscribeDirectWildcard registers a wildcard subscription WITHOUT querying
// producers for an initial snapshot. Used by the global broker, where kinds
// may have no producer (client-published workspace resources) and the
// subscriber is interested purely in the live delta stream across all kinds.
func (b *Broker) SubscribeDirectWildcard(filter types.ResourceFilter, deliver func(ResourceMessage)) *Subscription {
	subID := fmt.Sprintf("sub-%d", b.nextSubID.Add(1))
	sub := &Subscription{
		ID:      subID,
		Kind:    WildcardKind,
		Filter:  filter,
		deliver: deliver,
	}
	b.mu.Lock()
	b.subscribers[WildcardKind] = append(b.subscribers[WildcardKind], sub)
	b.subsByID[subID] = sub
	b.mu.Unlock()
	utils.Log("resource", fmt.Sprintf("subscribeDirectWildcard sub=%s", subID))
	return sub
}

// wildcardSubscribersLocked returns a copy of the wildcard subscriber slice.
// Caller must hold at least a read lock on b.mu. Returns nil when there are
// no wildcard subscribers (the common case), so the publish hot path does no
// allocation in that case.
func (b *Broker) wildcardSubscribersLocked() []*Subscription {
	ws := b.subscribers[WildcardKind]
	if len(ws) == 0 {
		return nil
	}
	out := make([]*Subscription, len(ws))
	copy(out, ws)
	return out
}
