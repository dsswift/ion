package mcp

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sync"

	"nhooyr.io/websocket"
)

// wsTransport implements mcpTransport over a WebSocket connection.
type wsTransport struct {
	conn *websocket.Conn
	mu   sync.Mutex
	done chan struct{}
}

func newWSTransport(url string, headers map[string]string) (*wsTransport, error) {
	if url == "" {
		return nil, fmt.Errorf("WebSocket transport requires URL")
	}

	opts := &websocket.DialOptions{}
	if len(headers) > 0 {
		h := http.Header{}
		for k, v := range headers {
			h.Set(k, v)
		}
		opts.HTTPHeader = h
	}

	conn, _, err := websocket.Dial(context.Background(), url, opts)
	if err != nil {
		return nil, fmt.Errorf("websocket dial: %w", err)
	}

	return &wsTransport{
		conn: conn,
		done: make(chan struct{}),
	}, nil
}

func (t *wsTransport) Send(msg json.RawMessage) error {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.conn.Write(context.Background(), websocket.MessageText, msg)
}

func (t *wsTransport) Receive() (json.RawMessage, error) {
	_, data, err := t.conn.Read(context.Background())
	if err != nil {
		select {
		case <-t.done:
			return nil, io.EOF
		default:
			return nil, fmt.Errorf("websocket read: %w", err)
		}
	}
	return json.RawMessage(data), nil
}

func (t *wsTransport) Close() error {
	close(t.done)
	return t.conn.Close(websocket.StatusNormalClosure, "closing")
}
