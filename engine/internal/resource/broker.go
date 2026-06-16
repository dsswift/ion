package resource

import (
	"fmt"
	"sync"
	"sync/atomic"

	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// ProducerHost is implemented by any component that can answer resource
// queries for a specific kind.
type ProducerHost interface {
	HandleQuery(filter types.ResourceFilter) ([]types.ResourceItem, error)
}

// ResourceMessage is the delivery envelope sent to each subscriber.
type ResourceMessage struct {
	Type  string               `json:"type"`
	Kind  string               `json:"kind"`
	SubID string               `json:"subscriptionId"`
	Items []types.ResourceItem `json:"items,omitempty"`
	Delta *types.ResourceDelta `json:"delta,omitempty"`
}

// Subscription represents a single active subscriber.
type Subscription struct {
	ID      string
	Kind    string
	Filter  types.ResourceFilter
	deliver func(msg ResourceMessage)
}

type producerEntry struct {
	kind string
	host ProducerHost
	decl types.ResourceDeclaration
}

// Broker routes resource events between producers and subscribers.
// One producer per kind; many subscribers per kind.
type Broker struct {
	mu          sync.RWMutex
	producers   map[string]*producerEntry
	subscribers map[string][]*Subscription // keyed by kind
	subsByID    map[string]*Subscription   // keyed by sub ID
	nextSubID   atomic.Int64
}

// NewBroker returns a ready-to-use Broker.
func NewBroker() *Broker {
	return &Broker{
		producers:   make(map[string]*producerEntry),
		subscribers: make(map[string][]*Subscription),
		subsByID:    make(map[string]*Subscription),
	}
}

// RegisterProducer registers a producer for the given kind. Returns an error
// if kind is empty or a producer for that kind is already registered.
func (b *Broker) RegisterProducer(kind string, host ProducerHost, decl types.ResourceDeclaration) error {
	if kind == "" {
		return fmt.Errorf("resource broker: kind must not be empty")
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if _, exists := b.producers[kind]; exists {
		return fmt.Errorf("resource broker: producer for kind %q already registered", kind)
	}
	b.producers[kind] = &producerEntry{kind: kind, host: host, decl: decl}
	utils.Log("resource", fmt.Sprintf("producer registered kind=%s", kind))
	return nil
}

// DeregisterProducer removes the producer for kind and drops all subscriptions
// for that kind. No-op if no producer is registered.
func (b *Broker) DeregisterProducer(kind string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if _, exists := b.producers[kind]; !exists {
		return
	}
	delete(b.producers, kind)
	// Drop all subscriptions for this kind.
	subs := b.subscribers[kind]
	for _, s := range subs {
		delete(b.subsByID, s.ID)
	}
	delete(b.subscribers, kind)
	utils.Log("resource", fmt.Sprintf("producer deregistered kind=%s dropped=%d subscriptions", kind, len(subs)))
}

// Subscribe registers a new subscription for the given kind. It calls the
// producer's HandleQuery with the provided filter, delivers the snapshot to
// the caller's deliver function, then stores the subscription for future
// deltas. Returns an error if no producer is registered for kind.
func (b *Broker) Subscribe(kind string, filter types.ResourceFilter, deliver func(ResourceMessage)) (*Subscription, error) {
	b.mu.Lock()
	entry, ok := b.producers[kind]
	if !ok {
		b.mu.Unlock()
		return nil, fmt.Errorf("resource broker: no producer for kind %q", kind)
	}

	subID := fmt.Sprintf("sub-%d", b.nextSubID.Add(1))
	sub := &Subscription{
		ID:      subID,
		Kind:    kind,
		Filter:  filter,
		deliver: deliver,
	}
	b.subscribers[kind] = append(b.subscribers[kind], sub)
	b.subsByID[subID] = sub
	host := entry.host
	b.mu.Unlock()

	// Query the producer for the initial snapshot outside the lock.
	items, err := host.HandleQuery(filter)
	if err != nil {
		// Subscription is registered; snapshot failed. Log and deliver empty snapshot.
		utils.Log("resource", fmt.Sprintf("HandleQuery failed kind=%s sub=%s err=%v", kind, subID, err))
		items = nil
	}

	deliver(ResourceMessage{
		Type:  "snapshot",
		Kind:  kind,
		SubID: subID,
		Items: items,
	})
	utils.Debug("resource", fmt.Sprintf("subscribed kind=%s sub=%s items=%d", kind, subID, len(items)))
	return sub, nil
}

// Unsubscribe removes the subscription identified by subID. No-op if not found.
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
	utils.Debug("resource", fmt.Sprintf("unsubscribed sub=%s kind=%s", subID, sub.Kind))
}

// Publish fans a delta out to all subscribers of the given kind. Returns an
// error if no producer is registered for kind. Fan-out delivery happens
// outside the lock.
func (b *Broker) Publish(kind string, delta types.ResourceDelta) error {
	b.mu.RLock()
	if _, ok := b.producers[kind]; !ok {
		b.mu.RUnlock()
		return fmt.Errorf("resource broker: no producer for kind %q", kind)
	}
	// Snapshot the subscriber slice so we can release the lock before delivering.
	// Wildcard subscribers (kind="*") receive deltas for every kind, so they
	// are folded into the recipient set here.
	subs := make([]*Subscription, len(b.subscribers[kind]))
	copy(subs, b.subscribers[kind])
	subs = append(subs, b.wildcardSubscribersLocked()...)
	b.mu.RUnlock()

	utils.Debug("resource", fmt.Sprintf("publish kind=%s op=%s recipients=%d", kind, delta.Op, len(subs)))
	for _, s := range subs {
		// Filter by conversationId when the subscription has one set.
		// Workspace subscribers (empty filter) receive everything.
		// Conversation-scoped subscribers only receive matching items.
		if s.Filter.ConversationID != "" && delta.Item.ConversationID != s.Filter.ConversationID {
			continue
		}
		s.deliver(ResourceMessage{
			Type:  "delta",
			Kind:  kind,
			SubID: s.ID,
			Delta: &delta,
		})
	}
	return nil
}

// PublishDirect fans a delta out to all subscribers of the given kind
// WITHOUT requiring a registered producer. Used by client-side publishers
// (desktop, iOS) that publish resources via the resource_publish wire
// command. Producers are an extension concept (query handlers); clients
// don't need them.
func (b *Broker) PublishDirect(kind string, delta types.ResourceDelta) {
	b.mu.RLock()
	subs := make([]*Subscription, len(b.subscribers[kind]))
	copy(subs, b.subscribers[kind])
	subs = append(subs, b.wildcardSubscribersLocked()...)
	b.mu.RUnlock()

	utils.Debug("resource", fmt.Sprintf("publishDirect kind=%s op=%s recipients=%d", kind, delta.Op, len(subs)))
	for _, s := range subs {
		// Filter by conversationId when the subscription has one set.
		// Workspace subscribers (empty filter) receive everything.
		// Conversation-scoped subscribers only receive matching items.
		if s.Filter.ConversationID != "" && delta.Item.ConversationID != s.Filter.ConversationID {
			continue
		}
		s.deliver(ResourceMessage{
			Type:  "delta",
			Kind:  kind,
			SubID: s.ID,
			Delta: &delta,
		})
	}
}

// SubscribeDirect registers a subscription WITHOUT requiring a registered
// producer. No initial snapshot is delivered (there's no producer to query).
// Used by the global broker where clients subscribe to kinds that may not
// have a producer yet (e.g. a client-invented kind published by the desktop
// client, not by an extension).
func (b *Broker) SubscribeDirect(kind string, filter types.ResourceFilter, deliver func(ResourceMessage)) *Subscription {
	if kind == "" {
		utils.Warn("resource", "SubscribeDirect: empty kind, ignoring")
		return nil
	}
	subID := fmt.Sprintf("sub-%d", b.nextSubID.Add(1))
	sub := &Subscription{
		ID:      subID,
		Kind:    kind,
		Filter:  filter,
		deliver: deliver,
	}
	b.mu.Lock()
	b.subscribers[kind] = append(b.subscribers[kind], sub)
	b.subsByID[subID] = sub
	b.mu.Unlock()

	// Deliver empty snapshot so the subscriber has a consistent starting point.
	deliver(ResourceMessage{
		Type:  "snapshot",
		Kind:  kind,
		SubID: subID,
		Items: nil,
	})
	utils.Debug("resource", fmt.Sprintf("subscribeDirect kind=%s sub=%s", kind, subID))
	return sub
}

// FuncProducerHost wraps a query handler function as a ProducerHost.
// DeclareResource registers this type; SetQueryHandler sets the handler
// after the fact so extensions can declare and wire independently.
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

// SetQueryHandler updates the query handler for the given kind's producer.
// This allows extensions to register handlers after declaring a resource kind.
// No-op when no producer is registered for kind, or when the producer was
// not registered via DeclareResource (i.e. is not a FuncProducerHost).
func (b *Broker) SetQueryHandler(kind string, handler func(types.ResourceFilter) ([]types.ResourceItem, error)) {
	b.mu.RLock()
	entry, ok := b.producers[kind]
	b.mu.RUnlock()
	if !ok {
		utils.Log("resource", fmt.Sprintf("SetQueryHandler: no producer for kind=%s", kind))
		return
	}
	if fph, ok := entry.host.(*FuncProducerHost); ok {
		fph.mu.Lock()
		fph.handler = handler
		fph.mu.Unlock()
		utils.Debug("resource", fmt.Sprintf("query handler set kind=%s", kind))
	}
}

// RewireQueryHandlerAndResnapshot updates the query handler for the given
// kind and re-delivers a fresh snapshot to every existing subscriber. Used
// after an extension respawn: the new subprocess's query handler replaces the
// dead one, and all subscribers that previously received an empty snapshot
// (because the query failed during the first spawn) get a corrective snapshot
// with the real data.
//
// Each subscriber is queried individually using its own filter so
// conversation-scoped and workspace-scoped subscribers each get their correct
// view of the data.
func (b *Broker) RewireQueryHandlerAndResnapshot(kind string, handler func(types.ResourceFilter) ([]types.ResourceItem, error)) {
	// Update the handler first.
	b.SetQueryHandler(kind, handler)

	// Snapshot the subscriber list outside the lock so we can call the handler
	// (which may block for extension I/O) without holding b.mu.
	b.mu.RLock()
	subs := make([]*Subscription, len(b.subscribers[kind]))
	copy(subs, b.subscribers[kind])
	b.mu.RUnlock()

	if len(subs) == 0 {
		utils.Debug("resource", fmt.Sprintf("RewireQueryHandlerAndResnapshot: kind=%s no subscribers to resnapshot", kind))
		return
	}

	utils.Log("resource", fmt.Sprintf("RewireQueryHandlerAndResnapshot: kind=%s rewiring handler and resnapshot for %d subscribers", kind, len(subs)))

	for _, sub := range subs {
		items, err := handler(sub.Filter)
		if err != nil {
			utils.Log("resource", fmt.Sprintf("RewireQueryHandlerAndResnapshot: HandleQuery failed kind=%s sub=%s err=%v", kind, sub.ID, err))
			items = nil
		}
		sub.deliver(ResourceMessage{
			Type:  "snapshot",
			Kind:  kind,
			SubID: sub.ID,
			Items: items,
		})
		utils.Log("resource", fmt.Sprintf("RewireQueryHandlerAndResnapshot: delivered snapshot kind=%s sub=%s items=%d", kind, sub.ID, len(items)))
	}
}
