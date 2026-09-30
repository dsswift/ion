package mcp

// transport_lifetime.go — binds every HTTP request of one MCP connection to
// that connection's lifetime.
//
// The SDK issues each request under the context of the call that sent it, and
// a cancelled call still sends notifications/cancelled under a detached
// context. A failed or abandoned handshake therefore leaves requests open
// against a server that does not answer, until the server replies or the
// response-header timeout fires. Ending the lifetime aborts every request the
// connection still has open, including the SSE streams a live connection
// holds.

import (
	"context"
	"io"
	"net/http"
	"sync"
)

// connLifetime is the lifetime of one MCP connection's HTTP traffic.
type connLifetime struct {
	ctx    context.Context
	cancel context.CancelFunc
}

func newConnLifetime() *connLifetime {
	ctx, cancel := context.WithCancel(context.Background())
	return &connLifetime{ctx: ctx, cancel: cancel}
}

// end aborts every open request and refuses new ones. Safe to call repeatedly.
func (l *connLifetime) end() { l.cancel() }

// bind wraps client so each request also ends when the lifetime does.
func (l *connLifetime) bind(client *http.Client) *http.Client {
	base := client.Transport
	if base == nil {
		base = http.DefaultTransport
	}
	bound := *client
	bound.Transport = &lifetimeRoundTripper{base: base, lifetime: l.ctx}
	return &bound
}

type lifetimeRoundTripper struct {
	base     http.RoundTripper
	lifetime context.Context
}

func (t *lifetimeRoundTripper) RoundTrip(req *http.Request) (*http.Response, error) {
	if err := t.lifetime.Err(); err != nil {
		return nil, err
	}
	ctx, cancel := context.WithCancel(req.Context())
	stop := context.AfterFunc(t.lifetime, cancel)
	release := func() {
		stop()
		cancel()
	}
	resp, err := t.base.RoundTrip(req.WithContext(ctx))
	if err != nil {
		release()
		return nil, err
	}
	// The body can outlive RoundTrip (an SSE stream), so the request stays
	// bound until the body is closed.
	resp.Body = &lifetimeBody{ReadCloser: resp.Body, release: release}
	return resp, nil
}

type lifetimeBody struct {
	io.ReadCloser
	once    sync.Once
	release func()
}

func (b *lifetimeBody) Close() error {
	err := b.ReadCloser.Close()
	b.once.Do(b.release)
	return err
}
