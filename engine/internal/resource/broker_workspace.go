package resource

import (
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// A workspace subscription on the Manager's global broker takes its initial
// snapshot from the producers live at that moment. A producer that comes
// online later (a session loading its extensions after the client subscribed,
// which is every session at engine or server boot) would otherwise reach that
// subscriber only through its future deltas, never with the items it already
// holds. AnnounceWorkspaceProducer closes that gap: each workspace subscriber
// gets one snapshot per producer, the first time any session offers it.

func coverageKey(kind, producer string) string { return kind + "\x00" + producer }

// markCovered records the (kind, producer) pairs an initial snapshot carried.
func (s *Subscription) markCovered(messages []ResourceMessage) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, msg := range messages {
		for _, producer := range msg.Producers {
			if s.covered == nil {
				s.covered = make(map[string]struct{})
			}
			s.covered[coverageKey(msg.Kind, producer)] = struct{}{}
		}
	}
}

// claimCoverage marks key covered and reports whether this call claimed it.
func (s *Subscription) claimCoverage(key string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.covered[key]; ok {
		return false
	}
	if s.covered == nil {
		s.covered = make(map[string]struct{})
	}
	s.covered[key] = struct{}{}
	return true
}

func (s *Subscription) releaseCoverage(key string) {
	s.mu.Lock()
	delete(s.covered, key)
	s.mu.Unlock()
}

// OnQueryHandlerSet registers the callback told when a producer on this broker
// can first answer queries. One callback per broker; a later call replaces it.
func (b *Broker) OnQueryHandlerSet(fn func(kind, producer string)) {
	b.mu.Lock()
	b.onQueryHandlerSet = fn
	b.mu.Unlock()
}

func (b *Broker) notifyQueryHandlerSet(kind, producer string) {
	b.mu.RLock()
	fn := b.onQueryHandlerSet
	b.mu.RUnlock()
	if fn != nil {
		fn(kind, producer)
	}
}

// AnnounceWorkspaceProducer delivers one snapshot of producer's workspace
// items for kind to every wildcard or kind subscriber on this broker that has
// not had one yet. query answers for the producer; only items with no
// conversation are delivered. Returns how many subscribers received one.
func (b *Broker) AnnounceWorkspaceProducer(kind, producer string, query func(types.ResourceFilter) ([]types.ResourceItem, error)) int {
	b.mu.RLock()
	subs := append(copySubscriptions(b.subscribers[kind]), b.wildcardSubscribersLocked()...)
	b.mu.RUnlock()
	key := coverageKey(kind, producer)
	delivered := 0
	for _, sub := range subs {
		if sub.Filter.Producer != "" && sub.Filter.Producer != producer {
			continue
		}
		if !sub.claimCoverage(key) {
			continue
		}
		items, err := query(types.ResourceFilter{Kind: kind, Producer: producer, ConversationID: sub.Filter.ConversationID})
		if err != nil {
			sub.releaseCoverage(key)
			utils.LogWithFields(utils.LevelWarn, "resource", "workspace producer announce query failed", map[string]any{
				"kind": kind, "producer": producer, "subscription_id": sub.ID, "error": err.Error(),
			})
			continue
		}
		workspace := make([]types.ResourceItem, 0, len(items))
		for _, item := range items {
			if item.ConversationID == "" {
				item.Producer = producer
				workspace = append(workspace, item)
			}
		}
		sub.deliverMessage(ResourceMessage{Type: "snapshot", Kind: kind, SubID: sub.ID, Items: workspace, Producers: []string{producer}})
		delivered++
	}
	utils.LogWithFields(utils.LevelInfo, "resource", "workspace producer announced", map[string]any{
		"kind": kind, "producer": producer, "subscribers": len(subs), "delivered": delivered,
	})
	return delivered
}
