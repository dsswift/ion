package resource

import (
	"fmt"
	"sort"

	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// WildcardKind is the sentinel kind that subscribes to every resource kind.
const WildcardKind = "*"

// IsWildcard reports whether kind is the wildcard sentinel.
func IsWildcard(kind string) bool { return kind == WildcardKind }

// SubscribeWildcard registers a subscription for all kinds. It emits one
// merged replacement snapshot per kind, even when several producers own it.
func (b *Broker) SubscribeWildcard(filter types.ResourceFilter, deliver func(ResourceMessage)) *Subscription {
	subID := fmt.Sprintf("sub-%d", b.nextSubID.Add(1))
	sub := &Subscription{ID: subID, Kind: WildcardKind, Filter: filter, deliver: deliver}

	b.mu.Lock()
	b.subscribers[WildcardKind] = append(b.subscribers[WildcardKind], sub)
	b.subsByID[subID] = sub
	kinds := make([]string, 0, len(b.producers))
	for kind := range b.producers {
		kinds = append(kinds, kind)
	}
	b.mu.Unlock()
	sort.Strings(kinds)

	for _, kind := range kinds {
		items := b.snapshotForSubscription(kind, filter, subID, "subscribe_wildcard")
		// A producer filter that matches no producer has no kind snapshot.
		b.mu.RLock()
		hasProducer := len(b.entriesForKindLocked(kind, filter.Producer)) > 0
		b.mu.RUnlock()
		if !hasProducer {
			continue
		}
		deliver(ResourceMessage{Type: "snapshot", Kind: kind, SubID: subID, Items: items})
		utils.LogWithFields(utils.LevelDebug, "resource", "subscribe wildcard snapshot", map[string]any{"kind": kind, "producer": filter.Producer, "subscription_id": subID, "count": len(items)})
	}
	utils.LogWithFields(utils.LevelInfo, "resource", "subscribe wildcard", map[string]any{"subscription_id": subID, "producer": filter.Producer, "kind_count": len(kinds)})
	return sub
}

// SubscribeDirectWildcard registers a producerless global wildcard. It has no
// snapshot because global broker delivery does not own producer query handlers.
func (b *Broker) SubscribeDirectWildcard(filter types.ResourceFilter, deliver func(ResourceMessage)) *Subscription {
	subID := fmt.Sprintf("sub-%d", b.nextSubID.Add(1))
	sub := &Subscription{ID: subID, Kind: WildcardKind, Filter: filter, deliver: deliver}
	b.mu.Lock()
	b.subscribers[WildcardKind] = append(b.subscribers[WildcardKind], sub)
	b.subsByID[subID] = sub
	b.mu.Unlock()
	utils.LogWithFields(utils.LevelInfo, "resource", "subscribe direct wildcard", map[string]any{"subscription_id": subID, "producer": filter.Producer})
	return sub
}

// wildcardSubscribersLocked returns a copy of wildcard subscriptions. Caller
// must hold at least a read lock.
func (b *Broker) wildcardSubscribersLocked() []*Subscription {
	return copySubscriptions(b.subscribers[WildcardKind])
}
