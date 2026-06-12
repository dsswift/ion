package types

// ResourceItem is the envelope for a single resource instance.
// The engine treats Content as an opaque blob — it never interprets
// the payload. Kind discrimination is the only schema the engine
// enforces on the envelope.
type ResourceItem struct {
	ID             string                 `json:"id"`
	Kind           string                 `json:"kind"`
	Title          string                 `json:"title,omitempty"`
	Content        string                 `json:"content"`
	CreatedAt      string                 `json:"createdAt"`
	ConversationID string                 `json:"conversationId,omitempty"`
	Metadata       map[string]interface{} `json:"metadata,omitempty"`
	UpdatedAt      string                 `json:"updatedAt,omitempty"`
	Read           bool                   `json:"read,omitempty"`
}

// ResourceDelta describes a single change to a resource collection.
type ResourceDelta struct {
	Op   string       `json:"op"`
	Item ResourceItem `json:"item"`
}

// ResourceFilter scopes a subscription or query.
type ResourceFilter struct {
	Kind           string `json:"kind"`
	ConversationID string `json:"conversationId,omitempty"`
	Since          string `json:"since,omitempty"`
	Limit          int    `json:"limit,omitempty"`
}

// ResourceDeclaration is what a producer registers with the broker.
type ResourceDeclaration struct {
	Kind string `json:"kind"`
}

// NotifyOpts configures a push notification sent through the engine's
// notification pipeline. Extensions call ctx.Notify and the engine
// routes the payload through the relay's push channel.
type NotifyOpts struct {
	Kind       string `json:"kind"`
	ResourceID string `json:"resourceId,omitempty"`
	Title      string `json:"title"`
	Body       string `json:"body"`
	Sound      string `json:"sound,omitempty"`
	// Scope controls delivery targeting: "user" (default), "device", "all".
	Scope string `json:"scope,omitempty"`
	// ConversationID identifies the session/conversation the notification
	// relates to. Clients use this to navigate to the correct tab when the
	// user acts on the notification. Empty for workspace-level notifications.
	ConversationID string `json:"conversationId,omitempty"`
	// TargetSessionKey, when set, causes the engine to emit the notification
	// on the target session's event stream instead of the caller's. The
	// target must exist; if it doesn't, the engine logs and no-ops.
	TargetSessionKey string `json:"targetSessionKey,omitempty"`
}
