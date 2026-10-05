// Package studio is the Ion Studio SDK for Go extensions.
//
// The Ion Engine has no concept of a user interface, and its SDK must not gain
// one. This module is where Studio vocabulary lives instead. An extension that
// wants to extend Ion Studio imports it alongside the engine SDK; an extension
// that never runs under Studio never needs it.
//
// It works through one generic engine mechanism, the resource subsystem. A
// request to Studio is a resource whose kind starts with "ion-studio.". The
// engine forwards it as opaque content. Studio recognises the kind and acts. A
// client that is not Studio ignores a kind it does not know.
//
// The shapes here are fixed by ../contract.json, which the TypeScript flavor
// of this SDK and Studio's own parser are pinned to as well.
package studio

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"sort"
	"sync"
	"time"

	ion "github.com/dsswift/ion/sdk/go"
)

const (
	// ControlKindPrefix marks a resource kind as a message to Studio.
	ControlKindPrefix = "ion-studio."
	// ComposerActionKind is the resource kind of a composer + menu action.
	ComposerActionKind = "ion-studio.composer-action"
	// LinkRouteKind is the resource kind of a named deep-link route.
	LinkRouteKind = "ion-studio.link-route"

	maxLabel   = 80
	maxIcon    = 40
	maxCommand = 200
)

var (
	commandPattern = regexp.MustCompile(`^/[A-Za-z0-9_:-]+( .*)?$`)
	// routeIDPattern keeps a route id safe as one URL path segment.
	routeIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)
)

// ComposerAction is one row an extension adds to the composer's + menu.
type ComposerAction struct {
	// ID is unique within the extension.
	ID string
	// Label is the row's text.
	Label string
	// Icon is a Phosphor icon name. Studio falls back to a default for a name
	// it does not have.
	Icon string
	// Command is the slash command Studio sends, through the normal prompt
	// pipeline, when the row is chosen.
	Command string
	// ConversationID offers the action in one conversation only. Empty offers
	// it in every conversation that runs this extension: Studio shows the row
	// only where the conversation's command registry owns Command.
	ConversationID string
}

// Publisher pushes a resource delta. ion.ResourceHandle satisfies it.
type Publisher interface {
	Publish(c context.Context, op ion.ResourceOp, item ion.ResourceItem) error
}

// Host is the slice of the engine SDK this package uses. [FromSDK] adapts a
// real *ion.SDK; a test supplies its own.
type Host interface {
	Declare(c context.Context, kind string) (Publisher, error)
	OnQuery(kind string, handler ion.ResourceQueryHandler)
}

type sdkHost struct{ api *ion.ResourcesAPI }

func (h sdkHost) Declare(c context.Context, kind string) (Publisher, error) {
	return h.api.Declare(c, kind)
}

func (h sdkHost) OnQuery(kind string, handler ion.ResourceQueryHandler) {
	h.api.OnQuery(kind, handler)
}

// FromSDK adapts the engine SDK to [Host].
func FromSDK(sdk *ion.SDK) Host { return sdkHost{api: sdk.Resources()} }

// spec is one thing an extension publishes under a Studio control kind.
type spec interface {
	key() string
	conversation() string
	Validate() error
	Item(createdAt string) (ion.ResourceItem, error)
}

type entry[S spec] struct {
	spec      S
	createdAt string
}

// registry holds the specs an extension publishes under one kind. The
// producer owns persistence (the engine stores nothing), so the registry
// answers the snapshot query a client makes on subscribe.
type registry[S spec] struct {
	mu        sync.Mutex
	publisher Publisher
	entries   map[string]entry[S]
	now       func() time.Time
}

// newRegistry declares kind and installs its snapshot query.
func newRegistry[S spec](c context.Context, host Host, kind string) (*registry[S], error) {
	r := &registry[S]{entries: map[string]entry[S]{}, now: time.Now}
	host.OnQuery(kind, r.query)
	publisher, err := host.Declare(c, kind)
	if err != nil {
		return nil, fmt.Errorf("studio: declare %s: %w", kind, err)
	}
	r.publisher = publisher
	return r, nil
}

// record stores the spec and returns its item and whether it replaced one.
func (r *registry[S]) record(s S) (ion.ResourceItem, bool, error) {
	if err := s.Validate(); err != nil {
		return ion.ResourceItem{}, false, err
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	previous, replaced := r.entries[s.key()]
	createdAt := previous.createdAt
	if !replaced {
		createdAt = r.now().UTC().Format(time.RFC3339)
	}
	item, err := s.Item(createdAt)
	if err != nil {
		return ion.ResourceItem{}, false, err
	}
	r.entries[s.key()] = entry[S]{spec: s, createdAt: createdAt}
	return item, replaced, nil
}

func (r *registry[S]) register(specs ...S) error {
	for _, s := range specs {
		if _, _, err := r.record(s); err != nil {
			return err
		}
	}
	return nil
}

func (r *registry[S]) add(ctx context.Context, s S) error {
	item, replaced, err := r.record(s)
	if err != nil {
		return err
	}
	op := ion.ResourceOpCreate
	if replaced {
		op = ion.ResourceOpUpdate
	}
	return r.publisher.Publish(ctx, op, item)
}

func (r *registry[S]) remove(ctx context.Context, id string) error {
	r.mu.Lock()
	previous, ok := r.entries[id]
	delete(r.entries, id)
	r.mu.Unlock()
	if !ok {
		return nil
	}
	item, err := previous.spec.Item(previous.createdAt)
	if err != nil {
		return err
	}
	return r.publisher.Publish(ctx, ion.ResourceOpDelete, item)
}

// query answers the snapshot a client asks for when it subscribes.
func (r *registry[S]) query(_ context.Context, filter ion.ResourceFilter) ([]ion.ResourceItem, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	items := make([]ion.ResourceItem, 0, len(r.entries))
	for _, e := range r.entries {
		if filter.ID != "" && e.spec.key() != filter.ID {
			continue
		}
		if conv := e.spec.conversation(); filter.ConversationID != "" && conv != "" && conv != filter.ConversationID {
			continue
		}
		item, err := e.spec.Item(e.createdAt)
		if err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	sort.Slice(items, func(i, j int) bool { return items[i].ID < items[j].ID })
	return items, nil
}

// Composer manages an extension's composer + menu actions.
//
// Register is for start-up: it records actions and answers Studio's snapshot
// query with them, and publishes nothing, so it is safe before [ion.SDK.Run].
// AddAction and RemoveAction are for a running extension: they also push the
// change to every connected Studio at once.
type Composer struct {
	*registry[ComposerAction]
}

// NewComposer declares the composer-action kind and installs its snapshot
// query. Call it once per extension, before or after Run.
func NewComposer(c context.Context, host Host) (*Composer, error) {
	r, err := newRegistry[ComposerAction](c, host, ComposerActionKind)
	if err != nil {
		return nil, err
	}
	return &Composer{registry: r}, nil
}

func (a ComposerAction) key() string          { return a.ID }
func (a ComposerAction) conversation() string { return a.ConversationID }

// Validate reports why an action would be refused, or nil.
func (a ComposerAction) Validate() error {
	switch {
	case a.ID == "":
		return errors.New("studio: composer action id is required")
	case a.Label == "" || len(a.Label) > maxLabel:
		return fmt.Errorf("studio: composer action label must be 1-%d characters", maxLabel)
	case len(a.Icon) > maxIcon:
		return fmt.Errorf("studio: composer action icon must be at most %d characters", maxIcon)
	case len(a.Command) > maxCommand || !commandPattern.MatchString(a.Command):
		return errors.New(`studio: composer action command must be a slash command, e.g. "/briefing"`)
	}
	return nil
}

// Item is the resource item an action is published as.
func (a ComposerAction) Item(createdAt string) (ion.ResourceItem, error) {
	content := map[string]string{"label": a.Label, "command": a.Command}
	if a.Icon != "" {
		content["icon"] = a.Icon
	}
	raw, err := json.Marshal(content)
	if err != nil {
		return ion.ResourceItem{}, fmt.Errorf("studio: encode composer action %q: %w", a.ID, err)
	}
	return ion.ResourceItem{
		ID:             a.ID,
		Kind:           ComposerActionKind,
		Title:          a.Label,
		Content:        string(raw),
		CreatedAt:      createdAt,
		ConversationID: a.ConversationID,
	}, nil
}

// Register records start-up actions without publishing. The first invalid
// action is returned as an error and nothing after it is recorded.
func (c *Composer) Register(actions ...ComposerAction) error { return c.register(actions...) }

// AddAction adds or replaces one action and pushes it to Studio now.
func (c *Composer) AddAction(ctx context.Context, action ComposerAction) error {
	return c.add(ctx, action)
}

// RemoveAction removes an action and tells Studio. Removing an unknown id is a
// no-op.
func (c *Composer) RemoveAction(ctx context.Context, id string) error { return c.remove(ctx, id) }

// LinkRoute is a named deep-link route. A link ion://ext/<ID>?args=<text>
// resolves to the route and runs Command, with the link's args appended.
type LinkRoute struct {
	// ID names the route in the link's path. Letters, digits, "_" and "-",
	// up to 64 characters.
	ID string
	// Label is how Studio names the route to the operator, for example when it
	// asks before running an untrusted link.
	Label string
	// Command is the slash command the route runs.
	Command string
	// ConversationID offers the route in one conversation only. Empty offers
	// it wherever the conversation's command registry owns Command.
	ConversationID string
}

func (r LinkRoute) key() string          { return r.ID }
func (r LinkRoute) conversation() string { return r.ConversationID }

// Validate reports why a route would be refused, or nil.
func (r LinkRoute) Validate() error {
	switch {
	case !routeIDPattern.MatchString(r.ID):
		return errors.New("studio: link route id must be 1-64 letters, digits, '_' or '-'")
	case r.Label == "" || len(r.Label) > maxLabel:
		return fmt.Errorf("studio: link route label must be 1-%d characters", maxLabel)
	case len(r.Command) > maxCommand || !commandPattern.MatchString(r.Command):
		return errors.New(`studio: link route command must be a slash command, e.g. "/briefing"`)
	}
	return nil
}

// Item is the resource item a route is published as.
func (r LinkRoute) Item(createdAt string) (ion.ResourceItem, error) {
	raw, err := json.Marshal(map[string]string{"label": r.Label, "command": r.Command})
	if err != nil {
		return ion.ResourceItem{}, fmt.Errorf("studio: encode link route %q: %w", r.ID, err)
	}
	return ion.ResourceItem{
		ID:             r.ID,
		Kind:           LinkRouteKind,
		Title:          r.Label,
		Content:        string(raw),
		CreatedAt:      createdAt,
		ConversationID: r.ConversationID,
	}, nil
}

// Links manages an extension's deep-link routes, with the same start-up and
// running-extension split as [Composer].
type Links struct {
	*registry[LinkRoute]
}

// NewLinks declares the link-route kind and installs its snapshot query. Call
// it once per extension, before or after Run.
func NewLinks(c context.Context, host Host) (*Links, error) {
	r, err := newRegistry[LinkRoute](c, host, LinkRouteKind)
	if err != nil {
		return nil, err
	}
	return &Links{registry: r}, nil
}

// Register records start-up routes without publishing. The first invalid
// route is returned as an error and nothing after it is recorded.
func (l *Links) Register(routes ...LinkRoute) error { return l.register(routes...) }

// AddRoute adds or replaces one route and pushes it to Studio now.
func (l *Links) AddRoute(ctx context.Context, route LinkRoute) error { return l.add(ctx, route) }

// RemoveRoute removes a route and tells Studio. Removing an unknown id is a
// no-op.
func (l *Links) RemoveRoute(ctx context.Context, id string) error { return l.remove(ctx, id) }
