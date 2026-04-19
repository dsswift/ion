// Package telemetry collects and exports structured events and spans.
package telemetry

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"sync"
	"time"

	"github.com/dsswift/ion/engine/internal/types"
)

// Event name constants.
const (
	SessionStart = "session.start"
	SessionEnd   = "session.end"
	LlmCall      = "llm.call"
	ToolExecute  = "tool.execute"
	Compaction   = "compaction"
	ErrorEvent   = "error"
)

// Event is a single telemetry data point.
type Event struct {
	Name      string         `json:"name"`
	Timestamp int64          `json:"timestamp"`
	Payload   map[string]any `json:"payload"`
	Context   map[string]any `json:"context,omitempty"`
}

// SpanHandle tracks a timed operation in progress.
type SpanHandle struct {
	name      string
	start     int64
	attrs     map[string]any
	collector *Collector
}

// End completes the span and records it as an event. Optional extra attributes
// and an error message can be provided.
func (s *SpanHandle) End(attrs map[string]any, errMsg ...string) {
	endMs := time.Now().UnixMilli()
	durationMs := endMs - s.start
	payload := make(map[string]any, len(s.attrs)+len(attrs)+1)
	for k, v := range s.attrs {
		payload[k] = v
	}
	for k, v := range attrs {
		payload[k] = v
	}
	payload["durationMs"] = durationMs
	if len(errMsg) > 0 && errMsg[0] != "" {
		payload["error"] = errMsg[0]
	}
	s.collector.Event(s.name, payload, nil)

	// Forward span timing to OtelBridge if attached.
	s.collector.mu.Lock()
	bridge := s.collector.otelBridge
	s.collector.mu.Unlock()
	if bridge != nil {
		bridge.RecordSpan(s.name, s.start, endMs, payload)
	}
}

// Collector buffers telemetry events and flushes them to configured targets.
type Collector struct {
	config     types.TelemetryConfig
	buffer     []Event
	mu         sync.Mutex
	otelBridge *OtelBridge
}

// SetOtelBridge attaches an OpenTelemetry bridge to the collector.
// When set, Event() and span End() also forward to the bridge.
func (c *Collector) SetOtelBridge(bridge *OtelBridge) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.otelBridge = bridge
}

// NewCollector creates a Collector from the given config. If config.Enabled is
// false, all recording methods are no-ops but remain safe to call.
func NewCollector(config types.TelemetryConfig) *Collector {
	return &Collector{
		config: config,
		buffer: make([]Event, 0, 64),
	}
}

// Event records a named event with payload and optional context.
func (c *Collector) Event(name string, payload, ctx map[string]any) {
	if !c.config.Enabled {
		return
	}
	e := Event{
		Name:      name,
		Timestamp: time.Now().UnixMilli(),
		Payload:   payload,
		Context:   ctx,
	}
	c.mu.Lock()
	c.buffer = append(c.buffer, e)
	batchSize := c.config.BatchSize
	bridge := c.otelBridge
	c.mu.Unlock()

	if bridge != nil {
		bridge.RecordEvent(e)
	}

	if batchSize > 0 {
		c.mu.Lock()
		shouldFlush := len(c.buffer) >= batchSize
		c.mu.Unlock()
		if shouldFlush {
			_ = c.Flush()
		}
	}
}

// StartSpan begins a timed span. Call End on the returned handle to complete it.
func (c *Collector) StartSpan(name string, attrs map[string]any) *SpanHandle {
	return &SpanHandle{
		name:      name,
		start:     time.Now().UnixMilli(),
		attrs:     attrs,
		collector: c,
	}
}

// Flush exports all buffered events to the configured targets and clears the buffer.
func (c *Collector) Flush() error {
	c.mu.Lock()
	if len(c.buffer) == 0 {
		c.mu.Unlock()
		return nil
	}
	events := make([]Event, len(c.buffer))
	copy(events, c.buffer)
	c.buffer = c.buffer[:0]
	c.mu.Unlock()

	var lastErr error
	for _, target := range c.config.Targets {
		switch target {
		case "file":
			if err := flushToFile(events, c.config.FilePath); err != nil {
				lastErr = err
			}
		case "stdout":
			if err := flushToStdout(events); err != nil {
				lastErr = err
			}
		case "http":
			if err := flushToHTTP(events, c.config.HttpEndpoint, c.config.HttpHeaders); err != nil {
				lastErr = err
			}
		}
	}
	return lastErr
}

func flushToFile(events []Event, path string) error {
	if path == "" {
		return fmt.Errorf("telemetry file path not configured")
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	defer f.Close()

	enc := json.NewEncoder(f)
	for _, e := range events {
		if err := enc.Encode(e); err != nil {
			return err
		}
	}
	return nil
}

func flushToStdout(events []Event) error {
	enc := json.NewEncoder(os.Stdout)
	for _, e := range events {
		if err := enc.Encode(e); err != nil {
			return err
		}
	}
	return nil
}

func flushToHTTP(events []Event, endpoint string, headers map[string]string) error {
	if endpoint == "" {
		return fmt.Errorf("telemetry HTTP endpoint not configured")
	}
	body, err := json.Marshal(events)
	if err != nil {
		return err
	}
	req, err := http.NewRequest(http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	resp.Body.Close()
	if resp.StatusCode >= 400 {
		return fmt.Errorf("telemetry HTTP POST returned status %d", resp.StatusCode)
	}
	return nil
}
