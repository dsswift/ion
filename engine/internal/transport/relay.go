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

	"github.com/coder/websocket"

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

	// writeTimeout is the timeout for relay broadcast writes (default 10s).
	writeTimeout time.Duration

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
		url:          url,
		apiKey:       apiKey,
		channelID:    channelID,
		writeTimeout: 10 * time.Second,
		done:         make(chan struct{}),
	}
}

// SetWriteTimeout overrides the relay broadcast write timeout.
func (r *RelayTransport) SetWriteTimeout(d time.Duration) {
	r.writeTimeout = d
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
			utils.LogWithFields(utils.LevelInfo, "transport.relay", "dial failed", map[string]any{"attempt": r.attempt, "error": err.Error()})

			delay := r.backoffDelay()
			select {
			case <-time.After(delay):
			case <-r.done:
				return
			}

			r.mu.Lock()
			r.attempt++
			if r.attempt > 0 && r.attempt%50 == 0 {
				utils.LogWithFields(utils.LevelWarn, "transport.relay", "still trying to reconnect", map[string]any{"attempt": r.attempt})
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
		CompressionMode: websocket.CompressionContextTakeover,
	}

	conn, _, err := websocket.Dial(context.Background(), dialURL, opts)
	if err != nil {
		return fmt.Errorf("websocket dial: %w", err)
	}

	conn.SetReadLimit(1024 * 1024) // 1MB, matching relay server limit

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
				utils.LogWithFields(utils.LevelInfo, "transport.relay", "read error", map[string]any{"error": err.Error()})
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
			default:
				// Unknown control frame — log so relay protocol drift is
				// visible rather than silently swallowed.
				utils.LogWithFields(utils.LevelDebug, "transport.relay", "unknown control frame", map[string]any{"type": ctrl.Type})
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

// ErrRelayNotConnected is returned by relayConn.Send when the relay
// WebSocket is not currently connected, so the caller can observe that a
// broadcast was dropped rather than being told it was delivered.
var ErrRelayNotConnected = fmt.Errorf("relay transport: not connected")

// Broadcast sends data to the relay server (forwarded to mobile peer).
func (r *RelayTransport) Broadcast(data []byte) {
	r.mu.Lock()
	conn := r.conn
	r.mu.Unlock()

	if conn == nil {
		// No active relay connection (reconnecting or never connected). Every
		// broadcast — including mobile push notifications — is dropped here.
		// Log so the drop is visible instead of vanishing silently.
		utils.LogWithFields(utils.LevelInfo, "transport.relay", "broadcast dropped: no relay connection", map[string]any{"bytes": len(data)})
		return
	}

	writeCtx, writeCancel := context.WithTimeout(context.Background(), r.writeTimeout)
	defer writeCancel()
	err := conn.Write(writeCtx, websocket.MessageText, data)
	if err != nil {
		utils.LogWithFields(utils.LevelInfo, "transport.relay", "broadcast write error", map[string]any{"error": err.Error()})
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
			if err := r.conn.Close(websocket.StatusNormalClosure, "engine shutdown"); err != nil {
				utils.LogWithFields(utils.LevelInfo, "transport.relay", "close websocket close failed", map[string]any{"error": err.Error()})
			}
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
	// Report the not-connected case to the caller instead of hardcoding a
	// success return: a dropped broadcast must not look like a delivery.
	c.transport.mu.Lock()
	conn := c.transport.conn
	c.transport.mu.Unlock()
	if conn == nil {
		utils.LogWithFields(utils.LevelInfo, "transport.relay", "send dropped: no relay connection", map[string]any{"bytes": len(data)})
		return ErrRelayNotConnected
	}
	c.transport.Broadcast(data)
	return nil
}

func (c *relayConn) Close() error {
	return nil
}
