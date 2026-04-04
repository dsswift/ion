package main

import (
	"encoding/json"
	"log"
	"net/http"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

var upgrader = websocket.Upgrader{
	ReadBufferSize:  64 * 1024,
	WriteBufferSize: 256 * 1024,
	// Reject connections with an Origin header. Native apps (CODA desktop,
	// iOS) don't send Origin; browsers do. This prevents browser-based
	// cross-site WebSocket hijacking attacks against the relay.
	CheckOrigin: func(r *http.Request) bool {
		return r.Header.Get("Origin") == ""
	},
}

// SafeConn wraps a websocket.Conn with a write mutex.
// gorilla/websocket requires that at most one goroutine calls write methods
// concurrently. SafeConn serializes all writes through SafeWrite.
type SafeConn struct {
	*websocket.Conn
	writeMu sync.Mutex
}

// SafeWrite sends a WebSocket message while holding the write mutex.
func (sc *SafeConn) SafeWrite(msgType int, data []byte, deadline time.Duration) error {
	sc.writeMu.Lock()
	defer sc.writeMu.Unlock()
	sc.Conn.SetWriteDeadline(time.Now().Add(deadline))
	return sc.Conn.WriteMessage(msgType, data)
}

// Channel holds the two sides of a relay channel.
type Channel struct {
	mu     sync.Mutex
	coda   *SafeConn
	mobile *SafeConn

	// APNs device token for push notifications (set by mobile on connect).
	apnsToken string
}

// Hub manages all active channels.
type Hub struct {
	mu       sync.RWMutex
	channels map[string]*Channel
}

func NewHub() *Hub {
	return &Hub{
		channels: make(map[string]*Channel),
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
	empty := ch.coda == nil && ch.mobile == nil
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
		if ch.coda != nil {
			ch.coda.Close()
		}
		if ch.mobile != nil {
			ch.mobile.Close()
		}
		ch.mu.Unlock()
	}
	h.channels = make(map[string]*Channel)
}

// controlMessage is a relay-originated control frame.
type controlMessage struct {
	Type string `json:"type"`
}

func sendControl(conn *SafeConn, msgType string) {
	msg, _ := json.Marshal(controlMessage{Type: msgType})
	conn.SafeWrite(websocket.TextMessage, msg, 5*time.Second)
}

// relayMessage wraps a forwarded payload to check for push flags.
type relayMessage struct {
	Push bool `json:"push,omitempty"`
}

func (h *Hub) HandleWebSocket(w http.ResponseWriter, r *http.Request, channelID, role string, pusher *APNsPusher) {
	rawConn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("upgrade error: %v", err)
		return
	}

	conn := &SafeConn{Conn: rawConn}

	ch := h.getOrCreateChannel(channelID)

	ch.mu.Lock()

	// Store connection by role, closing any previous connection for the same role.
	switch role {
	case "coda":
		if ch.coda != nil {
			ch.coda.Close()
		}
		ch.coda = conn
	case "mobile":
		if ch.mobile != nil {
			ch.mobile.Close()
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
		sendControl(peer, "relay:peer-reconnected")
	}

	ch.mu.Unlock()

	log.Printf("channel=%s role=%s connected", channelID, role)

	// Set up ping/pong keepalive.
	conn.SetPongHandler(func(string) error {
		conn.SetReadDeadline(time.Now().Add(90 * time.Second))
		return nil
	})
	conn.SetReadDeadline(time.Now().Add(90 * time.Second))

	go h.ping(conn)

	// Read loop: forward messages to the peer.
	for {
		msgType, data, err := conn.ReadMessage()
		if err != nil {
			break
		}

		ch.mu.Lock()
		peer := ch.getPeerLocked(role)
		apnsToken := ch.apnsToken
		ch.mu.Unlock()

		if peer != nil {
			if err := peer.SafeWrite(msgType, data, 10*time.Second); err != nil {
				log.Printf("channel=%s forward error: %v", channelID, err)
			}
		} else if role == "coda" && pusher != nil && apnsToken != "" {
			// Peer not connected. Check if this message requests a push notification.
			var msg relayMessage
			if json.Unmarshal(data, &msg) == nil && msg.Push {
				pusher.Send(apnsToken, "CODA needs your attention", "Permission approval required")
			}
		}
	}

	// Cleanup on disconnect.
	ch.mu.Lock()
	switch role {
	case "coda":
		if ch.coda == conn {
			ch.coda = nil
		}
	case "mobile":
		if ch.mobile == conn {
			ch.mobile = nil
		}
	}
	peer = ch.getPeerLocked(role)
	ch.mu.Unlock()

	if peer != nil {
		sendControl(peer, "relay:peer-disconnected")
	}

	log.Printf("channel=%s role=%s disconnected", channelID, role)
	h.removeIfEmpty(channelID)
}

func (ch *Channel) getPeerLocked(myRole string) *SafeConn {
	if myRole == "coda" {
		return ch.mobile
	}
	return ch.coda
}

func (h *Hub) ping(conn *SafeConn) {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	for range ticker.C {
		if err := conn.SafeWrite(websocket.PingMessage, nil, 5*time.Second); err != nil {
			return
		}
	}
}
