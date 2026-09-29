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

	maxLabel   = 80
	maxIcon    = 40
	maxCommand = 200
)

var commandPattern = regexp.MustCompile(`^/[A-Za-z0-9_:-]+( .*)?$`)

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

type entry struct {
	action    ComposerAction
	createdAt string
}

// Composer manages an extension's composer + menu actions.
//
// Register is for start-up: it records actions and answers Studio's snapshot
// query with them, and publishes nothing, so it is safe before [ion.SDK.Run].
// AddAction and RemoveAction are for a running extension: they also push the
// change to every connected Studio at once.
type Composer struct {
	mu        sync.Mutex
	publisher Publisher
	actions   map[string]entry
	now       func() time.Time
}

// NewComposer declares the composer-action kind and installs its snapshot
// query. Call it once per extension, before or after Run.
func NewComposer(c context.Context, host Host) (*Composer, error) {
	composer := &Composer{actions: map[string]entry{}, now: time.Now}
	host.OnQuery(ComposerActionKind, composer.query)
	publisher, err := host.Declare(c, ComposerActionKind)
	if err != nil {
		return nil, fmt.Errorf("studio: declare %s: %w", ComposerActionKind, err)
	}
	composer.publisher = publisher
	return composer, nil
}

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

// record stores the action and returns its item and whether it replaced one.
func (c *Composer) record(action ComposerAction) (ion.ResourceItem, bool, error) {
	if err := action.Validate(); err != nil {
		return ion.ResourceItem{}, false, err
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	previous, replaced := c.actions[action.ID]
	createdAt := previous.createdAt
	if !replaced {
		createdAt = c.now().UTC().Format(time.RFC3339)
	}
	item, err := action.Item(createdAt)
	if err != nil {
		return ion.ResourceItem{}, false, err
	}
	c.actions[action.ID] = entry{action: action, createdAt: createdAt}
	return item, replaced, nil
}

// Register records start-up actions without publishing. The first invalid
// action is returned as an error and nothing after it is recorded.
func (c *Composer) Register(actions ...ComposerAction) error {
	for _, action := range actions {
		if _, _, err := c.record(action); err != nil {
			return err
		}
	}
	return nil
}

// AddAction adds or replaces one action and pushes it to Studio now.
func (c *Composer) AddAction(ctx context.Context, action ComposerAction) error {
	item, replaced, err := c.record(action)
	if err != nil {
		return err
	}
	op := ion.ResourceOpCreate
	if replaced {
		op = ion.ResourceOpUpdate
	}
	return c.publisher.Publish(ctx, op, item)
}

// RemoveAction removes an action and tells Studio. Removing an unknown id is a
// no-op.
func (c *Composer) RemoveAction(ctx context.Context, id string) error {
	c.mu.Lock()
	previous, ok := c.actions[id]
	delete(c.actions, id)
	c.mu.Unlock()
	if !ok {
		return nil
	}
	item, err := previous.action.Item(previous.createdAt)
	if err != nil {
		return err
	}
	return c.publisher.Publish(ctx, ion.ResourceOpDelete, item)
}

// query answers the snapshot a client asks for when it subscribes.
func (c *Composer) query(_ context.Context, filter ion.ResourceFilter) ([]ion.ResourceItem, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	items := make([]ion.ResourceItem, 0, len(c.actions))
	for _, e := range c.actions {
		if filter.ID != "" && e.action.ID != filter.ID {
			continue
		}
		if filter.ConversationID != "" && e.action.ConversationID != "" && e.action.ConversationID != filter.ConversationID {
			continue
		}
		item, err := e.action.Item(e.createdAt)
		if err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	sort.Slice(items, func(i, j int) bool { return items[i].ID < items[j].ID })
	return items, nil
}
