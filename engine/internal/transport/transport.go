// Package transport provides Transport and Conn abstractions for the engine
// server to accept connections over Unix sockets or WebSocket relay.
package transport

import (
	"fmt"
	"net"
	"sync"
)

// Transport accepts connections and broadcasts data to all of them.
type Transport interface {
	Listen(handler func(conn Conn)) error
	Close() error
	Broadcast(data []byte)
}

// Conn is a single client connection.
type Conn interface {
	Send(data []byte) error
	Close() error
}

// --- Unix socket transport ---

// UnixTransport listens on a Unix domain socket.
type UnixTransport struct {
	path     string
	listener net.Listener
	conns    map[net.Conn]struct{}
	mu       sync.RWMutex
	done     chan struct{}
}

// NewUnixTransport creates a transport that listens on the given Unix socket path.
func NewUnixTransport(path string) *UnixTransport {
	return &UnixTransport{
		path:  path,
		conns: make(map[net.Conn]struct{}),
		done:  make(chan struct{}),
	}
}

// Listen starts accepting connections on the Unix socket.
func (u *UnixTransport) Listen(handler func(conn Conn)) error {
	ln, err := net.Listen("unix", u.path)
	if err != nil {
		return fmt.Errorf("unix listen: %w", err)
	}
	u.listener = ln

	go func() {
		for {
			raw, err := ln.Accept()
			if err != nil {
				select {
				case <-u.done:
					return
				default:
					continue
				}
			}

			uc := &unixConn{
				conn:      raw,
				transport: u,
			}

			u.mu.Lock()
			u.conns[raw] = struct{}{}
			u.mu.Unlock()

			go handler(uc)
		}
	}()

	return nil
}

// Close shuts down the listener and all active connections.
func (u *UnixTransport) Close() error {
	close(u.done)

	u.mu.Lock()
	for c := range u.conns {
		c.Close()
	}
	u.conns = make(map[net.Conn]struct{})
	u.mu.Unlock()

	if u.listener != nil {
		return u.listener.Close()
	}
	return nil
}

// Broadcast sends data to all connected clients. Failed sends silently
// remove the connection.
func (u *UnixTransport) Broadcast(data []byte) {
	line := append(data, '\n')

	u.mu.RLock()
	snapshot := make([]net.Conn, 0, len(u.conns))
	for c := range u.conns {
		snapshot = append(snapshot, c)
	}
	u.mu.RUnlock()

	for _, c := range snapshot {
		if _, err := c.Write(line); err != nil {
			u.removeConn(c)
		}
	}
}

func (u *UnixTransport) removeConn(c net.Conn) {
	u.mu.Lock()
	delete(u.conns, c)
	u.mu.Unlock()
	c.Close()
}

// Path returns the socket path.
func (u *UnixTransport) Path() string {
	return u.path
}

// unixConn wraps a net.Conn as a transport.Conn.
type unixConn struct {
	conn      net.Conn
	transport *UnixTransport
}

func (c *unixConn) Send(data []byte) error {
	_, err := c.conn.Write(append(data, '\n'))
	if err != nil {
		c.transport.removeConn(c.conn)
	}
	return err
}

func (c *unixConn) Close() error {
	c.transport.removeConn(c.conn)
	return nil
}

