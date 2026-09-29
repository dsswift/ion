package main

// otlp_egress.go — optional OTLP/HTTP shipping of the relay's own log lines
// and forward spans. Off unless RELAY_OTLP_ENDPOINT is set. The log-record
// mapping lives in otlp_logs.go and the span mapping in otlp_traces.go; this
// file owns config, the client_credentials token cache, the HTTP exporter,
// the bounded queues, and the flush loop. Config and the token source live in
// otlp_token.go.
//
// Recursion rule: the shipper's own diagnostics (export failures, overflow
// drops) go to s.local, a logger bound to the local file/stdout writer only.
// They never pass through the tee that feeds the shipper.

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"
)

// otlpServiceName is the service.name resource attribute on every shipped
// log record and span.
const otlpServiceName = "ion-relay"

const (
	otlpDefaultFlushInterval = 5 * time.Second
	otlpDefaultBatchSize     = 500
	otlpDefaultLogCapacity   = 10000
	otlpDefaultSpanCapacity  = 10000
	// otlpTokenRefreshSkew is how long before a token's expiry the cache
	// stops handing it out and fetches a fresh one.
	otlpTokenRefreshSkew = 60 * time.Second
	// otlpErrorLogInterval rate-limits export-failure lines in the local log.
	otlpErrorLogInterval = 60 * time.Second
	// otlpErrorBodyLimit caps how much of a rejection body lands in the log.
	otlpErrorBodyLimit = 512
)

// --- exporter ---

// otlpExportError is a failed export. Retryable failures (transport errors,
// 401 after the refresh retry, 429, 5xx) put the batch back at the head of
// its queue; anything else drops the batch, since resending it cannot help.
type otlpExportError struct {
	err       error
	retryable bool
}

func (e *otlpExportError) Error() string { return e.err.Error() }
func (e *otlpExportError) Unwrap() error { return e.err }

// post sends one OTLP/HTTP JSON body to endpoint+path. With a token source,
// a 401 refreshes the token once and retries.
func (s *otlpShipper) post(ctx context.Context, path string, body []byte) error {
	status, respBody, err := s.postOnce(ctx, path, body)
	if err == nil && status == http.StatusUnauthorized && s.tokens != nil {
		s.tokens.Invalidate()
		status, respBody, err = s.postOnce(ctx, path, body)
	}
	if err != nil {
		return &otlpExportError{err: err, retryable: true}
	}
	if status >= 200 && status < 300 {
		return nil
	}
	retryable := status == http.StatusUnauthorized || status == http.StatusTooManyRequests || status >= 500
	return &otlpExportError{
		err:       fmt.Errorf("POST %s: status %d: %s", path, status, truncateForLog(respBody)),
		retryable: retryable,
	}
}

func (s *otlpShipper) postOnce(ctx context.Context, path string, body []byte) (int, []byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, s.cfg.Endpoint+path, bytes.NewReader(body))
	if err != nil {
		return 0, nil, fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	if s.tokens != nil {
		tok, err := s.tokens.Token(ctx)
		if err != nil {
			return 0, nil, err
		}
		req.Header.Set("Authorization", "Bearer "+tok)
	}
	resp, err := s.client.Do(req)
	if err != nil {
		return 0, nil, fmt.Errorf("POST %s: %w", path, err)
	}
	defer resp.Body.Close() //nolint:errcheck // response body close after read
	respBody, err := io.ReadAll(io.LimitReader(resp.Body, otlpErrorBodyLimit))
	if err != nil {
		return resp.StatusCode, nil, nil //nolint:nilerr // the status decides the outcome; the body is only log context
	}
	return resp.StatusCode, respBody, nil
}

func truncateForLog(b []byte) string {
	if len(b) > otlpErrorBodyLimit {
		b = b[:otlpErrorBodyLimit]
	}
	return strings.TrimSpace(string(b))
}

// --- bounded queue ---

// otlpQueue is a bounded FIFO that drops its oldest item on overflow and
// counts every drop until the count is taken.
type otlpQueue[T any] struct {
	mu       sync.Mutex
	items    []T
	capacity int
	dropped  int64
}

func newOTLPQueue[T any](capacity int) *otlpQueue[T] {
	return &otlpQueue[T]{capacity: capacity}
}

func (q *otlpQueue[T]) push(v T) {
	q.mu.Lock()
	defer q.mu.Unlock()
	if len(q.items) >= q.capacity {
		q.items = q.items[1:]
		q.dropped++
	}
	q.items = append(q.items, v)
}

// take removes and returns up to n items from the head.
func (q *otlpQueue[T]) take(n int) []T {
	q.mu.Lock()
	defer q.mu.Unlock()
	if n > len(q.items) {
		n = len(q.items)
	}
	out := append([]T(nil), q.items[:n]...)
	q.items = q.items[n:]
	return out
}

// requeueFront puts a failed batch back at the head, then trims the oldest
// items past capacity.
func (q *otlpQueue[T]) requeueFront(batch []T) {
	q.mu.Lock()
	defer q.mu.Unlock()
	merged := append(append([]T(nil), batch...), q.items...)
	if over := len(merged) - q.capacity; over > 0 {
		merged = merged[over:]
		q.dropped += int64(over)
	}
	q.items = merged
}

func (q *otlpQueue[T]) len() int {
	q.mu.Lock()
	defer q.mu.Unlock()
	return len(q.items)
}

// takeDropped returns and clears the drop count.
func (q *otlpQueue[T]) takeDropped() int64 {
	q.mu.Lock()
	defer q.mu.Unlock()
	d := q.dropped
	q.dropped = 0
	return d
}

// --- shipper ---

// otlpShipper tees canonical log lines into a queue, collects forward spans,
// and ships both on a timer and at shutdown. A nil *otlpShipper is the
// disabled state; every method is nil-safe.
type otlpShipper struct {
	cfg    otlpConfig
	client *http.Client
	tokens *otlpTokenSource // nil unless AuthMode names a credential
	local  *slog.Logger     // local-only logger; never feeds back into the shipper
	host   string

	logs  *otlpQueue[[]byte]
	spans *otlpQueue[otlpSpan]

	flushInterval time.Duration
	batchSize     int

	flushMu sync.Mutex // one flush at a time

	errMu         sync.Mutex
	lastErrLog    time.Time
	suppressedErr int

	stopOnce sync.Once
	stop     chan struct{}
	done     chan struct{}
}

// newOTLPShipper builds a shipper. It does not start the flush loop.
func newOTLPShipper(cfg otlpConfig, local *slog.Logger) *otlpShipper {
	host := relayHostName()
	if host == "" {
		local.Warn("otlp: hostname unavailable; host attribute will be empty", "tag", "relay.otlp")
	}
	client := &http.Client{Timeout: 15 * time.Second}
	s := &otlpShipper{
		cfg:           cfg,
		client:        client,
		local:         local,
		host:          host,
		logs:          newOTLPQueue[[]byte](otlpDefaultLogCapacity),
		spans:         newOTLPQueue[otlpSpan](otlpDefaultSpanCapacity),
		flushInterval: otlpDefaultFlushInterval,
		batchSize:     otlpDefaultBatchSize,
		stop:          make(chan struct{}),
		done:          make(chan struct{}),
	}
	if cfg.AuthMode == otlpAuthSecret || cfg.AuthMode == otlpAuthFederated {
		s.tokens = &otlpTokenSource{cfg: cfg, client: client, now: time.Now, local: local}
	}
	return s
}

// Write is the tee side of the log writer: slog's JSON handler hands it one
// complete canonical line per call. It copies and queues the line and never
// blocks on the network.
func (s *otlpShipper) Write(p []byte) (int, error) {
	line := bytes.TrimRight(p, "\n")
	if len(line) > 0 {
		s.logs.push(append([]byte(nil), line...))
	}
	return len(p), nil
}

// start runs the periodic flush loop until Shutdown.
func (s *otlpShipper) start() {
	go func() {
		defer close(s.done)
		ticker := time.NewTicker(s.flushInterval)
		defer ticker.Stop()
		for {
			select {
			case <-s.stop:
				return
			case <-ticker.C:
				ctx, cancel := context.WithTimeout(context.Background(), s.flushInterval*3)
				s.Flush(ctx)
				cancel()
			}
		}
	}()
}

// Shutdown stops the flush loop and ships whatever is queued, bounded by ctx.
func (s *otlpShipper) Shutdown(ctx context.Context) {
	if s == nil {
		return
	}
	s.stopOnce.Do(func() { close(s.stop) })
	select {
	case <-s.done:
	case <-ctx.Done():
	}
	s.Flush(ctx)
	if n, m := s.logs.len(), s.spans.len(); n > 0 || m > 0 {
		s.local.Warn("otlp: shutdown flush left records unshipped",
			"tag", "relay.otlp", "logs_left", n, "spans_left", m)
		return
	}
	s.local.Info("otlp: shutdown flush complete", "tag", "relay.otlp")
}

// Flush drains both queues in batches. A retryable failure puts the batch
// back and stops draining that signal until the next flush. Overflow drops
// counted since the last flush are reported to the local log.
func (s *otlpShipper) Flush(ctx context.Context) {
	if s == nil {
		return
	}
	s.flushMu.Lock()
	defer s.flushMu.Unlock()

	flushQueue(ctx, s, s.logs, "logs", "/v1/logs", s.buildLogsPayload)
	flushQueue(ctx, s, s.spans, "traces", "/v1/traces", s.buildTracesPayload)

	if d := s.logs.takeDropped(); d > 0 {
		s.local.Warn("otlp: log buffer overflow; dropped oldest lines",
			"tag", "relay.otlp", "signal", "logs", "dropped", d)
	}
	if d := s.spans.takeDropped(); d > 0 {
		s.local.Warn("otlp: span buffer overflow; dropped oldest spans",
			"tag", "relay.otlp", "signal", "traces", "dropped", d)
	}
}

func flushQueue[T any](ctx context.Context, s *otlpShipper, q *otlpQueue[T], signal, path string, build func([]T) ([]byte, error)) {
	for ctx.Err() == nil {
		batch := q.take(s.batchSize)
		if len(batch) == 0 {
			return
		}
		body, err := build(batch)
		if err != nil {
			s.reportExportError(signal, len(batch), false, err)
			continue
		}
		if err := s.post(ctx, path, body); err != nil {
			var ee *otlpExportError
			retryable := errors.As(err, &ee) && ee.retryable
			if retryable {
				q.requeueFront(batch)
			}
			s.reportExportError(signal, len(batch), retryable, err)
			return
		}
	}
}

// reportExportError logs an export failure to the local log, at most once
// per otlpErrorLogInterval, carrying how many failures it stood in for.
func (s *otlpShipper) reportExportError(signal string, n int, requeued bool, err error) {
	s.errMu.Lock()
	now := time.Now()
	if !s.lastErrLog.IsZero() && now.Sub(s.lastErrLog) < otlpErrorLogInterval {
		s.suppressedErr++
		s.errMu.Unlock()
		return
	}
	suppressed := s.suppressedErr
	s.suppressedErr = 0
	s.lastErrLog = now
	s.errMu.Unlock()
	s.local.Warn("otlp: export failed",
		"tag", "relay.otlp", "signal", signal, "records", n,
		"requeued", requeued, "suppressed_failures", suppressed, "err", err)
}
