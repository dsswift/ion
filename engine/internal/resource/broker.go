package resource

import (
	"fmt"
	"sort"
	"sync"
	"sync/atomic"

	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// ProducerHost answers resource queries for one extension and resource kind.
type ProducerHost interface {
	HandleQuery(filter types.ResourceFilter) ([]types.ResourceItem, error)
}

// ResourceMessage is the delivery envelope sent to each subscriber.
type ResourceMessage struct {
	Type      string               `json:"type"`
	Kind      string               `json:"kind"`
	SubID     string               `json:"subscriptionId"`
	Items     []types.ResourceItem `json:"items,omitempty"`
	Delta     *types.ResourceDelta `json:"delta,omitempty"`
	Producers []string             `json:"producers,omitempty"`
}

// Subscription represents a single active subscriber.
type Subscription struct {
	ID         string
	Kind       string
	Filter     types.ResourceFilter
	deliver    func(msg ResourceMessage)
	mu         sync.Mutex
	pending    bool
	delivering bool
	queued     []ResourceMessage
}

func (s *Subscription) deliverMessage(msg ResourceMessage) {
	s.mu.Lock()
	s.queued = append(s.queued, msg)
	if s.pending || s.delivering {
		s.mu.Unlock()
		return
	}
	s.delivering = true
	s.mu.Unlock()
	s.drainMessages()
}

func (s *Subscription) finishInitialSnapshot(messages []ResourceMessage) {
	s.mu.Lock()
	queued := append(messages, s.queued...)
	s.queued = queued
	s.pending = false
	if s.delivering {
		s.mu.Unlock()
		return
	}
	s.delivering = true
	s.mu.Unlock()
	s.drainMessages()
}

func (s *Subscription) drainMessages() {
	for {
		s.mu.Lock()
		if len(s.queued) == 0 {
			s.delivering = false
			s.mu.Unlock()
			return
		}
		msg := s.queued[0]
		s.queued = s.queued[1:]
		s.mu.Unlock()
		s.deliver(msg)
	}
}

type producerEntry struct {
	kind     string
	producer string
	host     ProducerHost
	decl     types.ResourceDeclaration
}

// Broker routes resource events between producers and subscribers. A resource
// kind can have many producers. An item's identity is (kind, producer, id);
// producerless client-published items retain the legacy (kind, id) identity.
type Broker struct {
	mu          sync.RWMutex
	producers   map[string]map[string]*producerEntry // kind -> producer -> entry
	subscribers map[string][]*Subscription           // keyed by kind
	subsByID    map[string]*Subscription
	nextSubID   atomic.Int64
}

// NewBroker returns a ready-to-use Broker.
func NewBroker() *Broker {
	return &Broker{
		producers:   make(map[string]map[string]*producerEntry),
		subscribers: make(map[string][]*Subscription),
		subsByID:    make(map[string]*Subscription),
	}
}

// RegisterProducer keeps the legacy single-producer test seam. Production
// extension hosts use RegisterProducerFor with their trusted identity.
func (b *Broker) RegisterProducer(kind string, host ProducerHost, decl types.ResourceDeclaration) error {
	return b.RegisterProducerFor(kind, "legacy", host, decl)
}

// RegisterProducerFor registers one trusted extension producer for kind.
func (b *Broker) RegisterProducerFor(kind, producer string, host ProducerHost, decl types.ResourceDeclaration) error {
	if kind == "" {
		return fmt.Errorf("resource broker: kind must not be empty")
	}
	if producer == "" {
		return fmt.Errorf("resource broker: producer must not be empty")
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	entries := b.producers[kind]
	if entries == nil {
		entries = make(map[string]*producerEntry)
		b.producers[kind] = entries
	}
	if _, exists := entries[producer]; exists {
		return fmt.Errorf("resource broker: producer %q for kind %q already registered", producer, kind)
	}
	entries[producer] = &producerEntry{kind: kind, producer: producer, host: host, decl: decl}
	utils.LogWithFields(utils.LevelInfo, "resource", "producer registered", map[string]any{"kind": kind, "producer": producer})
	return nil
}

// DeregisterProducer keeps the legacy producer seam.
func (b *Broker) DeregisterProducer(kind string) { b.DeregisterProducerFor(kind, "legacy") }

// DeregisterProducerFor removes one producer.
func (b *Broker) DeregisterProducerFor(kind, producer string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	entries := b.producers[kind]
	if entries == nil {
		return
	}
	if _, exists := entries[producer]; !exists {
		return
	}
	delete(entries, producer)
	if len(entries) == 0 {
		delete(b.producers, kind)
	}
	utils.LogWithFields(utils.LevelInfo, "resource", "producer deregistered", map[string]any{"kind": kind, "producer": producer, "remaining_producers": len(entries)})
}

// Subscribe registers a kind subscription and emits one complete merged
// snapshot. The snapshot contains every matching producer's items.
func (b *Broker) Subscribe(kind string, filter types.ResourceFilter, deliver func(ResourceMessage)) (*Subscription, error) {
	b.mu.Lock()
	entries := b.entriesForKindLocked(kind, filter.Producer)
	if len(entries) == 0 {
		b.mu.Unlock()
		return nil, fmt.Errorf("resource broker: no producer for kind %q", kind)
	}
	subID := fmt.Sprintf("sub-%d", b.nextSubID.Add(1))
	sub := &Subscription{ID: subID, Kind: kind, Filter: filter, deliver: deliver}
	b.subscribers[kind] = append(b.subscribers[kind], sub)
	b.subsByID[subID] = sub
	b.mu.Unlock()

	items, producers := b.queryEntries(entries, kind, filter, subID, "subscribe")
	deliver(ResourceMessage{Type: "snapshot", Kind: kind, SubID: subID, Items: items, Producers: producers})
	utils.LogWithFields(utils.LevelDebug, "resource", "subscribed", map[string]any{"kind": kind, "producer": filter.Producer, "subscription_id": subID, "count": len(items)})
	return sub, nil
}

// GetItem keeps the legacy unqualified lookup. It succeeds only when one
// producer returns the requested ID.
func (b *Broker) GetItem(kind, id string) (*types.ResourceItem, error) {
	return b.GetItemFrom(kind, "", id)
}

// GetItemFrom gets one Resource by its full identity.
func (b *Broker) GetItemFrom(kind, producer, id string) (*types.ResourceItem, error) {
	return b.getItemFrom(kind, producer, id, false)
}

// GetWorkspaceItemFrom gets one workspace-scoped Resource by its full identity.
func (b *Broker) GetWorkspaceItemFrom(kind, producer, id string) (*types.ResourceItem, error) {
	return b.getItemFrom(kind, producer, id, true)
}

func (b *Broker) getItemFrom(kind, producer, id string, workspaceOnly bool) (*types.ResourceItem, error) {
	b.mu.RLock()
	entries := b.entriesForKindLocked(kind, producer)
	b.mu.RUnlock()
	if len(entries) == 0 {
		return nil, fmt.Errorf("resource broker: no producer for kind %q producer %q", kind, producer)
	}

	var matches []types.ResourceItem
	for _, entry := range entries {
		filter := types.ResourceFilter{Kind: kind, Producer: entry.producer, ID: id}
		items, err := entry.host.HandleQuery(filter)
		if err != nil {
			return nil, fmt.Errorf("resource broker: query failed for kind %q producer %q id %q: %w", kind, entry.producer, id, err)
		}
		for _, item := range items {
			if item.ID == id && (!workspaceOnly || item.ConversationID == "") {
				item.Producer = entry.producer
				matches = append(matches, item)
			}
		}
	}
	if len(matches) == 0 {
		return nil, nil
	}
	if producer == "" && len(matches) > 1 {
		return nil, fmt.Errorf("resource broker: item %q in kind %q is ambiguous; specify producer", id, kind)
	}
	return &matches[0], nil
}

// Unsubscribe removes the subscription identified by subID. No-op if missing.
func (b *Broker) Unsubscribe(subID string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	sub, ok := b.subsByID[subID]
	if !ok {
		return
	}
	delete(b.subsByID, subID)
	subs := b.subscribers[sub.Kind]
	updated := subs[:0]
	for _, s := range subs {
		if s.ID != subID {
			updated = append(updated, s)
		}
	}
	b.subscribers[sub.Kind] = updated
	utils.LogWithFields(utils.LevelDebug, "resource", "unsubscribed", map[string]any{"subscription_id": subID, "kind": sub.Kind})
}

// Publish keeps the legacy producer seam.
func (b *Broker) Publish(kind string, delta types.ResourceDelta) error {
	return b.PublishFrom(kind, "legacy", delta)
}

// PublishFrom stamps a delta with its trusted producer and fans it out.
func (b *Broker) PublishFrom(kind, producer string, delta types.ResourceDelta) error {
	b.mu.RLock()
	entries := b.producers[kind]
	_, ok := entries[producer]
	b.mu.RUnlock()
	if !ok {
		return fmt.Errorf("resource broker: no producer %q for kind %q", producer, kind)
	}
	delta.Item.Producer = producer
	b.publishDelta(kind, delta)
	return nil
}

// PublishDirect fans a delta out without requiring a registered producer. It
// preserves producer attribution already stamped by a trusted extension host.
func (b *Broker) PublishDirect(kind string, delta types.ResourceDelta) {
	b.publishDelta(kind, delta)
}

func (b *Broker) publishDelta(kind string, delta types.ResourceDelta) {
	b.mu.RLock()
	subs := append(copySubscriptions(b.subscribers[kind]), b.wildcardSubscribersLocked()...)
	b.mu.RUnlock()
	utils.LogWithFields(utils.LevelDebug, "resource", "publish", map[string]any{"kind": kind, "producer": delta.Item.Producer, "status": delta.Op, "item_id": delta.Item.ID, "count": len(subs)})
	for _, sub := range subs {
		if !matchesFilter(sub.Filter, delta.Item) {
			continue
		}
		deltaCopy := delta
		sub.deliverMessage(ResourceMessage{Type: "delta", Kind: kind, SubID: sub.ID, Delta: &deltaCopy})
	}
}

// SubscribeDirect registers a producerless direct subscription. The global
// broker uses this for client-created resources that have no producer query.
func (b *Broker) SubscribeDirect(kind string, filter types.ResourceFilter, deliver func(ResourceMessage)) *Subscription {
	return b.SubscribeDirectWithSnapshot(kind, filter, deliver, func(subID string) []ResourceMessage {
		return []ResourceMessage{{Type: "snapshot", Kind: kind, SubID: subID}}
	})
}

// SubscribeDirectWithSnapshot registers a direct subscription before building
// its initial snapshot. Matching deltas queue until the snapshot is delivered.
func (b *Broker) SubscribeDirectWithSnapshot(
	kind string,
	filter types.ResourceFilter,
	deliver func(ResourceMessage),
	buildSnapshot func(subscriptionID string) []ResourceMessage,
) *Subscription {
	if kind == "" {
		utils.Warn("resource", "SubscribeDirectWithSnapshot: empty kind, ignoring")
		return nil
	}
	subID := fmt.Sprintf("sub-%d", b.nextSubID.Add(1))
	sub := &Subscription{
		ID: subID, Kind: kind, Filter: filter, deliver: deliver,
		pending: buildSnapshot != nil,
	}
	b.mu.Lock()
	b.subscribers[kind] = append(b.subscribers[kind], sub)
	b.subsByID[subID] = sub
	b.mu.Unlock()
	if buildSnapshot != nil {
		sub.finishInitialSnapshot(buildSnapshot(subID))
	}
	utils.LogWithFields(utils.LevelDebug, "resource", "subscribe direct", map[string]any{
		"kind": kind, "producer": filter.Producer, "subscription_id": subID, "snapshot": buildSnapshot != nil,
	})
	return sub
}

// FuncProducerHost wraps a query handler function as a ProducerHost.
type FuncProducerHost struct {
	mu      sync.RWMutex
	handler func(types.ResourceFilter) ([]types.ResourceItem, error)
}

func (f *FuncProducerHost) HandleQuery(filter types.ResourceFilter) ([]types.ResourceItem, error) {
	f.mu.RLock()
	h := f.handler
	f.mu.RUnlock()
	if h == nil {
		return nil, nil
	}
	return h(filter)
}

// SetQueryHandler keeps the legacy producer seam.
func (b *Broker) SetQueryHandler(kind string, handler func(types.ResourceFilter) ([]types.ResourceItem, error)) {
	b.SetQueryHandlerFor(kind, "legacy", handler)
}

// SetQueryHandlerFor updates a trusted producer query handler.
func (b *Broker) SetQueryHandlerFor(kind, producer string, handler func(types.ResourceFilter) ([]types.ResourceItem, error)) {
	b.mu.RLock()
	entry := b.producers[kind][producer]
	b.mu.RUnlock()
	if entry == nil {
		utils.LogWithFields(utils.LevelInfo, "resource", "set query handler no producer", map[string]any{"kind": kind, "producer": producer})
		return
	}
	if fph, ok := entry.host.(*FuncProducerHost); ok {
		fph.mu.Lock()
		fph.handler = handler
		fph.mu.Unlock()
		utils.LogWithFields(utils.LevelDebug, "resource", "query handler set", map[string]any{"kind": kind, "producer": producer})
	}
}

// RewireQueryHandlerAndResnapshot keeps the legacy producer seam.
func (b *Broker) RewireQueryHandlerAndResnapshot(kind string, handler func(types.ResourceFilter) ([]types.ResourceItem, error)) {
	b.RewireQueryHandlerAndResnapshotFor(kind, "legacy", handler)
}

// RewireQueryHandlerAndResnapshotFor rewires one trusted producer.
func (b *Broker) RewireQueryHandlerAndResnapshotFor(kind, producer string, handler func(types.ResourceFilter) ([]types.ResourceItem, error)) {
	b.SetQueryHandlerFor(kind, producer, handler)
	b.mu.RLock()
	subs := copySubscriptions(b.subscribers[kind])
	b.mu.RUnlock()
	for _, sub := range subs {
		items, producers := b.snapshotForSubscription(kind, sub.Filter, sub.ID, "rewire")
		sub.deliverMessage(ResourceMessage{Type: "snapshot", Kind: kind, SubID: sub.ID, Items: items, Producers: producers})
	}
	utils.LogWithFields(utils.LevelInfo, "resource", "rewire query handler and resnapshot", map[string]any{"kind": kind, "producer": producer, "count": len(subs)})
}

func (b *Broker) snapshotForSubscription(kind string, filter types.ResourceFilter, subID, operation string) ([]types.ResourceItem, []string) {
	b.mu.RLock()
	entries := b.entriesForKindLocked(kind, filter.Producer)
	b.mu.RUnlock()
	return b.queryEntries(entries, kind, filter, subID, operation)
}

func (b *Broker) queryEntries(entries []*producerEntry, kind string, filter types.ResourceFilter, subID, operation string) ([]types.ResourceItem, []string) {
	var merged []types.ResourceItem
	var producers []string
	for _, entry := range entries {
		entryFilter := filter
		entryFilter.Kind = kind
		entryFilter.Producer = entry.producer
		items, err := entry.host.HandleQuery(entryFilter)
		if err != nil {
			utils.LogWithFields(utils.LevelInfo, "resource", "resource query failed", map[string]any{"operation": operation, "kind": kind, "producer": entry.producer, "subscription_id": subID, "error": err.Error()})
			continue
		}
		producers = append(producers, entry.producer)
		for index := range items {
			items[index].Producer = entry.producer
		}
		merged = append(merged, items...)
	}
	return merged, producers
}

func (b *Broker) ProducerNames(kind string) []string {
	b.mu.RLock()
	defer b.mu.RUnlock()
	entries := b.entriesForKindLocked(kind, "")
	names := make([]string, 0, len(entries))
	for _, entry := range entries {
		names = append(names, entry.producer)
	}
	return names
}

// Kinds returns every declared resource kind in stable order.
func (b *Broker) Kinds() []string {
	b.mu.RLock()
	defer b.mu.RUnlock()
	kinds := make([]string, 0, len(b.producers))
	for kind := range b.producers {
		kinds = append(kinds, kind)
	}
	sort.Strings(kinds)
	return kinds
}

// QueryProducer obtains one producer's current items and stamps the trusted
// producer identity onto every returned item.
func (b *Broker) QueryProducer(kind, producer string, filter types.ResourceFilter) ([]types.ResourceItem, error) {
	b.mu.RLock()
	entries := b.entriesForKindLocked(kind, producer)
	b.mu.RUnlock()
	if len(entries) == 0 {
		return nil, fmt.Errorf("resource broker: no producer for kind %q producer %q", kind, producer)
	}
	filter.Kind = kind
	filter.Producer = producer
	items, err := entries[0].host.HandleQuery(filter)
	if err != nil {
		return nil, err
	}
	for index := range items {
		items[index].Producer = producer
	}
	return items, nil
}

func (b *Broker) entriesForKindLocked(kind, producer string) []*producerEntry {
	entries := b.producers[kind]
	if len(entries) == 0 {
		return nil
	}
	if producer != "" {
		if entry := entries[producer]; entry != nil {
			return []*producerEntry{entry}
		}
		return nil
	}
	keys := make([]string, 0, len(entries))
	for name := range entries {
		keys = append(keys, name)
	}
	sort.Strings(keys)
	out := make([]*producerEntry, 0, len(keys))
	for _, name := range keys {
		out = append(out, entries[name])
	}
	return out
}

func matchesFilter(filter types.ResourceFilter, item types.ResourceItem) bool {
	return (filter.ConversationID == "" || filter.ConversationID == item.ConversationID) &&
		(filter.Producer == "" || filter.Producer == item.Producer)
}

func copySubscriptions(subs []*Subscription) []*Subscription {
	if len(subs) == 0 {
		return nil
	}
	out := make([]*Subscription, len(subs))
	copy(out, subs)
	return out
}
