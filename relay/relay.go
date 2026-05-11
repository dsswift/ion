package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
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

	// Configurable timeouts and limits (set at construction, read-only after).
	WriteTimeout   time.Duration // forward write deadline (default 10s)
	PingInterval   time.Duration // keepalive ping interval (default 30s)
	PingTimeout    time.Duration // pong wait deadline (default 10s)
	MaxMessageSize int64         // read limit in bytes (default 1MB)
}

func NewHub() *Hub {
	return &Hub{
		channels:       make(map[string]*Channel),
		WriteTimeout:   10 * time.Second,
		PingInterval:   30 * time.Second,
		PingTimeout:    10 * time.Second,
		MaxMessageSize: 1024 * 1024,
	}
}

func (h *Hub) getOrCreateChannel(id string) *Channel {
	h.mu.Lock()
	defer h.mu.Unlock()
	ch, ok := h.channels[id]
	if !ok {
		ch = &Channel{}
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
			_ = ch.ion.CloseNow()
		}
		if ch.mobile != nil {
			_ = ch.mobile.CloseNow()
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

// controlMessage is a relay-originated control frame.
type controlMessage struct {
	Type string `json:"type"`
}

func sendControl(conn *websocket.Conn, msgType string, timeout time.Duration) {
	msg, _ := json.Marshal(controlMessage{Type: msgType})
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	if err := conn.Write(ctx, websocket.MessageText, msg); err != nil {
		log.Printf("sendControl(%s) error: %v", msgType, err)
	}
}

// relayMessage wraps a forwarded payload to check for push flags.
type relayMessage struct {
	Push      bool   `json:"push,omitempty"`
	PushTitle string `json:"pushTitle,omitempty"`
	PushBody  string `json:"pushBody,omitempty"`
}

func (h *Hub) HandleWebSocket(w http.ResponseWriter, r *http.Request, channelID, role string, pusher *APNsPusher) {
	// Reject connections with an Origin header. Native apps (Ion desktop,
	// iOS) don't send Origin; browsers do. This prevents browser-based
	// cross-site WebSocket hijacking attacks against the relay.
	if r.Header.Get("Origin") != "" {
		http.Error(w, "Forbidden", http.StatusForbidden)
		return
	}

	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		InsecureSkipVerify: true,
		CompressionMode:    websocket.CompressionContextTakeover,
	})
	if err != nil {
		log.Printf("accept error: %v", err)
		return
	}

	// Allow messages up to the configured max (default 1MB).
	conn.SetReadLimit(h.MaxMessageSize)

	ch := h.getOrCreateChannel(channelID)

	ch.mu.Lock()

	// Store connection by role, closing any previous connection for the same role.
	switch role {
	case "ion":
		if ch.ion != nil {
			_ = ch.ion.Close(websocket.StatusGoingAway, "replaced")
		}
		ch.ion = conn
	case "mobile":
		if ch.mobile != nil {
			_ = ch.mobile.Close(websocket.StatusGoingAway, "replaced")
		}
		ch.mobile = conn
	}

	// Capture the APNs token from mobile query param.
	if role == "mobile" {
		if token := r.URL.Query().Get("apns_token"); token != "" {
			ch.apnsToken = token
		}
	}

	// Notify peer that the other side connected.
	peer := ch.getPeerLocked(role)
	if peer != nil {
		sendControl(peer, "relay:peer-reconnected", h.WriteTimeout)
	}

	ch.mu.Unlock()

	log.Printf("channel=%s role=%s connected", channelID, role)

	// Start keepalive pings. Essential for public internet deployments where
	// NAT timeouts, load balancer idle limits, and mobile network switches
	// can silently kill connections.
	done := make(chan struct{})
	go ping(conn, done, h.PingInterval, h.PingTimeout)

	// Read loop: forward messages to the peer.
	for {
		msgType, data, err := conn.Read(context.Background())
		if err != nil {
			break
		}

		ch.mu.Lock()
		peer := ch.getPeerLocked(role)
		apnsToken := ch.apnsToken
		ch.mu.Unlock()

		if peer != nil {
			writeCtx, writeCancel := context.WithTimeout(context.Background(), h.WriteTimeout)
			if err := peer.Write(writeCtx, msgType, data); err != nil {
				log.Printf("channel=%s forward error: %v", channelID, err)
			}
			writeCancel()
		} else if role == "ion" && pusher != nil && apnsToken != "" {
			// Peer not connected. Check if this message requests a push notification.
			var msg relayMessage
			if json.Unmarshal(data, &msg) == nil && msg.Push {
				title := msg.PushTitle
				body := msg.PushBody
				if title == "" {
					title = "Ion needs your attention"
				}
				if body == "" {
					body = "Approval required"
				}
				pusher.Send(apnsToken, title, body)
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
		sendControl(peer, "relay:peer-disconnected", h.WriteTimeout)
	}

	log.Printf("channel=%s role=%s disconnected", channelID, role)
	h.removeIfEmpty(channelID)
	close(done)
	_ = conn.CloseNow()
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
func ping(conn *websocket.Conn, done <-chan struct{}, interval, pingTimeout time.Duration) {
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
				_ = conn.CloseNow()
				return
			}
		}
	}
}
