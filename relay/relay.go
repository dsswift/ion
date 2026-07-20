package main

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"os"
	"sync"
	"time"

	"github.com/coder/websocket"
)

// Channel holds the two sides of a relay channel.
type Channel struct {
	mu     sync.Mutex
	ion    *websocket.Conn
	mobile *websocket.Conn

	// APNs device token for push notifications (set by mobile on connect).
	apnsToken string
}

// Hub manages all active channels.
type Hub struct {
	mu       sync.RWMutex
	channels map[string]*Channel

	// tokenStore persists APNs tokens per channel so they survive both
	// channel deletion (desktop restart while phone is away) and relay restarts.
	tokens *tokenStore

	// Configurable timeouts and limits (set at construction, read-only after).
	WriteTimeout   time.Duration // forward write deadline (default 10s)
	PingInterval   time.Duration // keepalive ping interval (default 30s)
	PingTimeout    time.Duration // pong wait deadline (default 10s)
	MaxMessageSize int64         // read limit in bytes (default 12MB)
}

func NewHub() *Hub {
	return &Hub{
		channels:       make(map[string]*Channel),
		tokens:         newTokenStore(os.Getenv("RELAY_STATE_DIR")),
		WriteTimeout:   10 * time.Second,
		PingInterval:   30 * time.Second,
		PingTimeout:    10 * time.Second,
		MaxMessageSize: 12 * 1024 * 1024,
	}
}

func (h *Hub) getOrCreateChannel(id string) *Channel {
	h.mu.Lock()
	defer h.mu.Unlock()
	ch, ok := h.channels[id]
	if !ok {
		// Restore the persisted APNs token so push works immediately even when
		// the channel struct is fresh (desktop restarted while phone was away).
		ch = &Channel{apnsToken: h.tokens.Get(id)}
		if ch.apnsToken != "" {
			logger.Debug("apns token restored from store", "tag", "relay.apns.token", "channel_id", id)
		}
		h.channels[id] = ch
	}
	return ch
}

func (h *Hub) removeIfEmpty(id string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	ch, ok := h.channels[id]
	if !ok {
		return
	}
	ch.mu.Lock()
	empty := ch.ion == nil && ch.mobile == nil
	ch.mu.Unlock()
	if empty {
		delete(h.channels, id)
	}
}

func (h *Hub) CloseAll() {
	h.mu.Lock()
	defer h.mu.Unlock()
	for _, ch := range h.channels {
		ch.mu.Lock()
		if ch.ion != nil {
			ch.ion.CloseNow() //nolint:errcheck // connection teardown
		}
		if ch.mobile != nil {
			ch.mobile.CloseNow() //nolint:errcheck // connection teardown
		}
		ch.mu.Unlock()
	}
	h.channels = make(map[string]*Channel)
}

// ChannelCount returns the number of active channels (used by tests).
func (h *Hub) ChannelCount() int {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return len(h.channels)
}

// ChannelStatus returns whether the ion and mobile roles are connected for a channel.
func (h *Hub) ChannelStatus(channelID string) (ionConnected, mobileConnected bool) {
	h.mu.RLock()
	ch, ok := h.channels[channelID]
	h.mu.RUnlock()
	if !ok {
		return false, false
	}
	ch.mu.Lock()
	defer ch.mu.Unlock()
	return ch.ion != nil, ch.mobile != nil
}

// controlMessage is a relay-originated control frame.
type controlMessage struct {
	Type string `json:"type"`
}

// pushFailedControl is the wire shape for a relay:push-failed control frame.
// It is emitted back to the ion peer when an APNs push fails at any stage.
type pushFailedControl struct {
	Type       string `json:"type"`                 // "relay:push-failed"
	Reason     string `json:"reason"`               // queue_full | invalid_token | transient | token | marshal | request | transport
	ResourceId string `json:"resourceId,omitempty"` // resource ID from the originating push message
}

func sendControl(conn *websocket.Conn, msgType string, timeout time.Duration, log *slog.Logger) {
	msg, _ := json.Marshal(controlMessage{Type: msgType}) //nolint:errcheck // marshal of a trivial fixed struct cannot fail
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	if err := conn.Write(ctx, websocket.MessageText, msg); err != nil {
		log.Warn("sendControl error", "tag", "relay.control_error", "msg_type", msgType, "err", err)
	}
}

// sendControlPayload writes an arbitrary JSON-marshallable control frame to conn.
func sendControlPayload(conn *websocket.Conn, payload any, timeout time.Duration, log *slog.Logger) {
	msg, err := json.Marshal(payload)
	if err != nil {
		log.Error("sendControlPayload marshal error", "tag", "relay.control_error", "err", err)
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	if err := conn.Write(ctx, websocket.MessageText, msg); err != nil {
		log.Warn("sendControlPayload write error", "tag", "relay.control_error", "err", err)
	}
}

// relayMessage wraps a forwarded payload to check for push flags.
type relayMessage struct {
	Push             bool   `json:"push,omitempty"`
	PushTitle        string `json:"pushTitle,omitempty"`
	PushBody         string `json:"pushBody,omitempty"`
	NotifyKind       string `json:"notifyKind,omitempty"`
	NotifyResourceId string `json:"notifyResourceId,omitempty"`
}

func (h *Hub) HandleWebSocket(w http.ResponseWriter, r *http.Request, channelID, role string, pusher *APNsPusher) {
	// Reject connections with an Origin header. Native apps (Ion desktop,
	// iOS) don't send Origin; browsers do. This prevents browser-based
	// cross-site WebSocket hijacking attacks against the relay.
	if r.Header.Get("Origin") != "" {
		http.Error(w, "Forbidden", http.StatusForbidden)
		return
	}

	sessionID := r.Header.Get("X-Ion-Session-Id")

	connLog := logger.With("channel_id", channelID, "role", role)
	if sessionID != "" {
		connLog = connLog.With("session_id", sessionID)
	}

	// Enable compression only for the desktop ("ion") role.  Apple's
	// URLSessionWebSocketTask offers permessage-deflate in the handshake
	// but its inflate implementation is broken for context-takeover mode,
	// causing immediate "Protocol error" disconnects on every received
	// frame.  Disabling compression for mobile avoids this.
	compressionMode := websocket.CompressionDisabled
	if role == "ion" {
		compressionMode = websocket.CompressionContextTakeover
	}

	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		InsecureSkipVerify: true,
		CompressionMode:    compressionMode,
	})
	if err != nil {
		connLog.Warn("accept error", "tag", "relay.forward_error", "err", err)
		return
	}

	// Allow messages up to the configured max (default 12MB).
	conn.SetReadLimit(h.MaxMessageSize)

	ch := h.getOrCreateChannel(channelID)

	ch.mu.Lock()

	// Store connection by role, closing any previous connection for the same role.
	switch role {
	case "ion":
		if ch.ion != nil {
			ch.ion.Close(websocket.StatusGoingAway, "replaced") //nolint:errcheck // closing a replaced connection
		}
		ch.ion = conn
	case "mobile":
		if ch.mobile != nil {
			ch.mobile.Close(websocket.StatusGoingAway, "replaced") //nolint:errcheck // closing a replaced connection
		}
		ch.mobile = conn
	}

	// Capture the APNs token from mobile query param and persist it so it
	// survives both channel deletion (desktop restart while phone is away) and
	// relay restarts. Without persistence the token only lives as long as the
	// in-memory Channel struct, which removeIfEmpty destroys when both peers
	// disconnect — defeating the primary purpose of APNs push (phone is away).
	if role == "mobile" {
		if token := r.URL.Query().Get("apns_token"); token != "" {
			ch.apnsToken = token
			h.tokens.Set(channelID, token)
			connLog.Debug("apns token captured", "tag", "relay.apns.token", "channel_id", channelID)
		}
	}

	// Notify peer that the other side connected.
	peer := ch.getPeerLocked(role)
	if peer != nil {
		sendControl(peer, "relay:peer-reconnected", h.WriteTimeout, connLog)
	}

	ch.mu.Unlock()

	connLog.Info("client connected", "tag", "relay.connect")

	// Start keepalive pings. Essential for public internet deployments where
	// NAT timeouts, load balancer idle limits, and mobile network switches
	// can silently kill connections.
	done := make(chan struct{})
	go ping(conn, done, h.PingInterval, h.PingTimeout, connLog)

	// Read loop: forward messages to the peer.
	for {
		msgType, data, err := conn.Read(context.Background())
		if err != nil {
			// Log the exit reason so a clean close is distinguishable from a
			// timeout or protocol error. websocket normal-closure is expected;
			// anything else explains an otherwise-mysterious disconnect.
			connLog.Info("read loop ended", "tag", "relay.disconnect", "role", role, "err", err)
			break
		}

		ch.mu.Lock()
		peer := ch.getPeerLocked(role)
		apnsToken := ch.apnsToken
		ch.mu.Unlock()

		if peer != nil {
			writeCtx, writeCancel := context.WithTimeout(context.Background(), h.WriteTimeout)
			if err := peer.Write(writeCtx, msgType, data); err != nil {
				connLog.Warn("forward error", "tag", "relay.forward_error", "err", err)
			}
			writeCancel()
		} else if role == "ion" && pusher != nil {
			// Mobile peer not connected; check if this message requests a push.
			var msg relayMessage
			if err := json.Unmarshal(data, &msg); err != nil {
				// A push-eligible frame that fails to unmarshal is silently
				// skipped otherwise — no push, no push-failed frame back to ion.
				connLog.Warn("push-eligible frame unmarshal failed",
					"tag", "relay.apns.error",
					"channel_id", channelID,
					"err", err)
			} else if msg.Push {
				if apnsToken == "" {
					// No token — log at ERROR so the skip is visible in log scanners
					// and operators can diagnose why notifications are not delivered
					// (e.g. desktop restarted before the fix was applied, or phone
					// never connected to this relay instance).
					connLog.Error("push skipped: no APNs token for channel",
						"tag", "relay.apns.skipped_no_token",
						"channel_id", channelID,
						"kind", msg.NotifyKind,
						"resource_id", msg.NotifyResourceId)
				} else {
					title := msg.PushTitle
					body := msg.PushBody
					if title == "" {
						title = "Ion needs your attention"
					}
					if body == "" {
						body = "Approval required"
					}

					resourceId := msg.NotifyResourceId

					// Build the failure callback before enqueuing so both the
					// queue-full path (Send return value) and the async worker path
					// (onFailure callback) funnel through the same closure.
					onFailure := func(reason string) {
						ch.mu.Lock()
						ionConn := ch.ion
						ch.mu.Unlock()
						if ionConn == nil {
							return
						}
						frame := pushFailedControl{
							Type:       "relay:push-failed",
							Reason:     reason,
							ResourceId: resourceId,
						}
						connLog.Info("emitting push-failed to ion peer",
							"tag", "relay.apns.push_failed",
							"reason", reason,
							"resource_id", resourceId)
						sendControlPayload(ionConn, frame, h.WriteTimeout, connLog)
					}

					if err := pusher.SendWithNotify(apnsToken, title, body, msg.NotifyKind, resourceId, onFailure); err != nil {
						// Queue was full — report back to the ion peer immediately.
						onFailure("queue_full")
					}
				}
			}
		} else if role == "ion" && pusher == nil {
			// No mobile peer and push disabled (relay booted without APNs). If
			// the frame actually wanted a push, log once so "why no
			// notification" is debuggable instead of a silent no-op.
			var msg relayMessage
			if err := json.Unmarshal(data, &msg); err == nil && msg.Push {
				connLog.Warn("push requested but push is unavailable (relay booted without APNs)",
					"tag", "relay.apns.unavailable",
					"channel_id", channelID,
					"kind", msg.NotifyKind,
					"resource_id", msg.NotifyResourceId)
			}
		}
	}

	// Cleanup on disconnect.
	ch.mu.Lock()
	switch role {
	case "ion":
		if ch.ion == conn {
			ch.ion = nil
		}
	case "mobile":
		if ch.mobile == conn {
			ch.mobile = nil
		}
	}
	peer = ch.getPeerLocked(role)
	ch.mu.Unlock()

	if peer != nil {
		sendControl(peer, "relay:peer-disconnected", h.WriteTimeout, connLog)
	}

	connLog.Info("client disconnected", "tag", "relay.disconnect")
	h.removeIfEmpty(channelID)
	close(done)
	conn.CloseNow() //nolint:errcheck // connection teardown
}

func (ch *Channel) getPeerLocked(myRole string) *websocket.Conn {
	if myRole == "ion" {
		return ch.mobile
	}
	return ch.ion
}

// ping sends WebSocket pings at the configured interval to detect dead connections.
// If a pong is not received within pingTimeout, the connection is closed,
// which causes the read loop to exit.
func ping(conn *websocket.Conn, done <-chan struct{}, interval, pingTimeout time.Duration, log *slog.Logger) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-done:
			return
		case <-ticker.C:
			ctx, cancel := context.WithTimeout(context.Background(), pingTimeout)
			err := conn.Ping(ctx)
			cancel()
			if err != nil {
				// A keepalive ping timeout tears the connection down. Log the
				// reason before closing — this is often the one signal that
				// explains an otherwise-mysterious disconnect.
				log.Warn("keepalive ping failed; closing connection", "tag", "relay.ping_failed", "err", err)
				if closeErr := conn.CloseNow(); closeErr != nil {
					log.Debug("close after ping failure errored", "tag", "relay.ping_failed", "err", closeErr)
				}
				return
			}
		}
	}
}
