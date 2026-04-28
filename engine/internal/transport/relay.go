// Package transport provides Transport implementations.
// This file implements RelayTransport using WebSocket connections to the
// Ion relay server for mobile remote access.
package transport

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"sync"
	"time"

	"nhooyr.io/websocket"

	"github.com/dsswift/ion/engine/internal/utils"
)

// controlMessage is a relay-originated control frame.
type controlMessage struct {
	Type string `json:"type"`
}

// RelayTransport connects to a WebSocket relay server with automatic
// exponential backoff reconnection. Each incoming non-control message
// is dispatched to OnMessage.
type RelayTransport struct {
	url       string
	apiKey    string
	channelID string

	// OnMessage is called for each non-control WebSocket message received
	// from the relay (i.e. commands forwarded from the mobile peer).
	// Must be set before calling Listen.
	OnMessage func(data []byte)

	mu      sync.Mutex
	conn    *websocket.Conn
	done    chan struct{}
	closed  bool
	attempt int
}

// NewRelayTransport creates a relay transport targeting the given WebSocket URL.
func NewRelayTransport(url, apiKey, channelID string) *RelayTransport {
	return &RelayTransport{
		url:       url,
		apiKey:    apiKey,
		channelID: channelID,
		done:      make(chan struct{}),
	}
}

// Listen starts the WebSocket connection loop with reconnection.
// The handler is called each time a connection is established (providing
// a Conn for sending responses). For relay, this is a single logical
// connection to the relay server.
func (r *RelayTransport) Listen(handler func(conn Conn)) error {
	go r.connectLoop(handler)
	return nil
}

func (r *RelayTransport) connectLoop(handler func(conn Conn)) {
	for {
		select {
		case <-r.done:
			return
		default:
		}

		err := r.dial()
		if err != nil {
			utils.Log("Relay", fmt.Sprintf("dial failed (attempt %d): %v", r.attempt, err))

			delay := r.backoffDelay()
			select {
			case <-time.After(delay):
			case <-r.done:
				return
			}

			r.mu.Lock()
			r.attempt++
			if r.attempt > 100 {
				r.mu.Unlock()
				utils.Log("Relay", "max reconnection attempts reached")
				return
			}
			r.mu.Unlock()
			continue
		}

		// Connected. Reset attempt counter.
		r.mu.Lock()
		r.attempt = 0
		r.mu.Unlock()

		utils.Log("Relay", "connected to relay")

		// Notify handler of new connection (provides Send capability).
		if handler != nil {
			handler(&relayConn{transport: r})
		}

		// Run read loop (blocks until disconnect).
		r.readLoop()

		utils.Log("Relay", "disconnected from relay")

		// Check if intentionally closed.
		select {
		case <-r.done:
			return
		default:
			// Brief pause before reconnect.
			select {
			case <-time.After(1 * time.Second):
			case <-r.done:
				return
			}
		}
	}
}

func (r *RelayTransport) dial() error {
	dialURL := fmt.Sprintf("%s/v1/channel/%s?role=ion", r.url, r.channelID)

	opts := &websocket.DialOptions{
		HTTPHeader: http.Header{
			"Authorization": []string{"Bearer " + r.apiKey},
		},
	}

	conn, _, err := websocket.Dial(context.Background(), dialURL, opts)
	if err != nil {
		return fmt.Errorf("websocket dial: %w", err)
	}

	r.mu.Lock()
	r.conn = conn
	r.mu.Unlock()

	return nil
}

func (r *RelayTransport) readLoop() {
	for {
		select {
		case <-r.done:
			return
		default:
		}

		r.mu.Lock()
		conn := r.conn
		r.mu.Unlock()
		if conn == nil {
			return
		}

		_, data, err := conn.Read(context.Background())
		if err != nil {
			select {
			case <-r.done:
			default:
				utils.Log("Relay", fmt.Sprintf("read error: %v", err))
			}
			return
		}

		// Check for relay control messages.
		var ctrl controlMessage
		if json.Unmarshal(data, &ctrl) == nil && ctrl.Type != "" {
			switch ctrl.Type {
			case "relay:peer-reconnected":
				utils.Log("Relay", "mobile peer connected")
			case "relay:peer-disconnected":
				utils.Log("Relay", "mobile peer disconnected")
			}
			continue
		}

		// Dispatch command data to handler.
		if r.OnMessage != nil {
			r.OnMessage(data)
		}
	}
}

func (r *RelayTransport) backoffDelay() time.Duration {
	r.mu.Lock()
	attempt := r.attempt
	r.mu.Unlock()

	secs := math.Min(30, math.Pow(2, float64(attempt)))
	return time.Duration(secs) * time.Second
}

// Broadcast sends data to the relay server (forwarded to mobile peer).
func (r *RelayTransport) Broadcast(data []byte) {
	r.mu.Lock()
	conn := r.conn
	r.mu.Unlock()

	if conn == nil {
		return
	}

	err := conn.Write(context.Background(), websocket.MessageText, data)
	if err != nil {
		utils.Log("Relay", fmt.Sprintf("broadcast write error: %v", err))
	}
}

// Close terminates the relay connection and stops reconnection.
func (r *RelayTransport) Close() error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if !r.closed {
		r.closed = true
		close(r.done)
		if r.conn != nil {
			r.conn.Close(websocket.StatusNormalClosure, "engine shutdown")
		}
	}
	return nil
}

// Verify interface compliance.
var _ Transport = (*RelayTransport)(nil)

// relayConn wraps the relay transport as a transport.Conn.
type relayConn struct {
	transport *RelayTransport
}

func (c *relayConn) Send(data []byte) error {
	c.transport.Broadcast(data)
	return nil
}

func (c *relayConn) Close() error {
	return nil
}
