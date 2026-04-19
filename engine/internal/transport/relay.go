// Package transport provides Transport implementations.
// This file implements RelayTransport using WebSocket connections.
package transport

import (
	"fmt"
	"math"
	"net"
	"sync"
	"time"
)

// RelayTransport connects to a WebSocket relay server with automatic
// exponential backoff reconnection. Commands from the relay are dispatched
// to the registered handler.
type RelayTransport struct {
	url        string
	apiKey     string
	deviceID   string
	cmdHandler func(conn net.Conn, line string)
	mu         sync.Mutex
	done       chan struct{}
	closed     bool

	// reconnection state
	attempt int
}

// NewRelayTransport creates a relay transport targeting the given WebSocket URL.
func NewRelayTransport(url, apiKey, deviceID string) *RelayTransport {
	return &RelayTransport{
		url:      url,
		apiKey:   apiKey,
		deviceID: deviceID,
		done:     make(chan struct{}),
	}
}

// Listen starts the WebSocket connection loop with reconnection.
// This is a stub that establishes the reconnection framework without pulling
// in gorilla/websocket as a dependency. The actual WebSocket I/O will be
// wired in once the dependency is added to go.mod.
func (r *RelayTransport) Listen() error {
	go r.connectLoop()
	return nil
}

func (r *RelayTransport) connectLoop() {
	for {
		select {
		case <-r.done:
			return
		default:
		}

		// Placeholder: actual WebSocket dial goes here.
		// On connection failure, backoff and retry.
		delay := r.backoffDelay()
		select {
		case <-time.After(delay):
		case <-r.done:
			return
		}

		r.mu.Lock()
		r.attempt++
		r.mu.Unlock()

		// Cap reconnection attempts to prevent infinite spinning.
		r.mu.Lock()
		if r.attempt > 100 {
			r.mu.Unlock()
			return
		}
		r.mu.Unlock()
	}
}

func (r *RelayTransport) backoffDelay() time.Duration {
	r.mu.Lock()
	attempt := r.attempt
	r.mu.Unlock()

	// Exponential backoff: 1s, 2s, 4s, 8s, ... capped at 30s.
	secs := math.Min(30, math.Pow(2, float64(attempt)))
	return time.Duration(secs) * time.Second
}

// Broadcast sends data to the relay server.
func (r *RelayTransport) Broadcast(data []byte) error {
	// Stub: write to WebSocket connection.
	_ = data
	return fmt.Errorf("relay transport: not connected")
}

// OnCommand registers a handler for messages received from the relay.
func (r *RelayTransport) OnCommand(fn func(conn net.Conn, line string)) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.cmdHandler = fn
}

// SendTo is not meaningful for relay transport (single connection).
func (r *RelayTransport) SendTo(conn net.Conn, data []byte) error {
	return r.Broadcast(data)
}

// Close terminates the relay connection and stops reconnection.
func (r *RelayTransport) Close() error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if !r.closed {
		r.closed = true
		close(r.done)
	}
	return nil
}
