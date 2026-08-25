// Package telemetryforwarder sends expanded telemetry events to Loki.
package telemetryforwarder

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"time"

	"github.com/dsswift/ion/engine/internal/filetail"
	"github.com/dsswift/ion/engine/internal/telemetryformat"
	"github.com/dsswift/ion/engine/internal/utils"
)

const (
	// DefaultFile is the engine telemetry file path inside a forwarder container.
	DefaultFile = "/ion-logs/telemetry.jsonl"
	// DefaultCursor is the durable forwarder cursor path.
	DefaultCursor = "/data/telemetry-forwarder.cursor.json"
	// DefaultEndpoint is Alloy's Loki Push API listener in the local stack.
	DefaultEndpoint = "http://alloy:3500/loki/api/v1/push"
)

// Config configures a Forwarder.
type Config struct {
	File     string
	Cursor   string
	Endpoint string
	Client   *http.Client
}

// Forwarder follows one telemetry file and forwards its expanded events.
type Forwarder struct {
	cursorPath string
	endpoint   string
	client     *http.Client
	follower   *filetail.Follower
}

// New creates a forwarder from durable cursor state. It starts at the beginning
// when no cursor exists, so a new forwarder backfills readable telemetry.
func New(config Config) (*Forwarder, error) {
	if config.File == "" {
		return nil, fmt.Errorf("telemetry forwarder: file is required")
	}
	if config.Cursor == "" {
		return nil, fmt.Errorf("telemetry forwarder: cursor is required")
	}
	if config.Endpoint == "" {
		return nil, fmt.Errorf("telemetry forwarder: endpoint is required")
	}
	cursor, err := loadCursor(config.Cursor)
	if err != nil {
		return nil, err
	}
	client := config.Client
	if client == nil {
		client = &http.Client{Timeout: 15 * time.Second}
	}
	return &Forwarder{
		cursorPath: config.Cursor,
		endpoint:   config.Endpoint,
		client:     client,
		follower:   filetail.New(config.File, filetail.Options{Start: filetail.StartAtBeginning, Cursor: cursor}),
	}, nil
}

// Close releases the telemetry file descriptor.
func (f *Forwarder) Close() error { return f.follower.Close() }

// Poll forwards all complete, unacknowledged lines. It writes the cursor after
// Loki accepts each physical line, so failed requests remain retryable.
func (f *Forwarder) Poll(ctx context.Context) error {
	return f.follower.Poll(func(line []byte) error {
		events, err := telemetryformat.DecodeLine(line)
		if err != nil {
			return fmt.Errorf("telemetry forwarder: decode line: %w", err)
		}
		if err := f.push(ctx, events); err != nil {
			return err
		}
		if err := saveCursor(f.cursorPath, nextCursor(f.follower.Cursor(), len(line))); err != nil {
			return err
		}
		return nil
	})
}

// Run polls until ctx stops. A missing telemetry file is treated as an idle
// source so the forwarder can start before the engine creates it.
func (f *Forwarder) Run(ctx context.Context, interval time.Duration) error {
	if interval <= 0 {
		return fmt.Errorf("telemetry forwarder: poll interval must be positive")
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		if err := f.Poll(ctx); err != nil && !errors.Is(err, os.ErrNotExist) {
			// Alloy can start after this container even when Compose expresses a
			// service dependency. Keep the cursor unchanged and retry the same
			// complete frame on the next poll instead of exiting during startup.
			utils.LogWithFields(utils.LevelWarn, "telemetry.forwarder", "telemetry forward poll failed retrying", map[string]any{
				"endpoint": f.endpoint,
				"error":    err.Error(),
			})
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
		}
	}
}

func (f *Forwarder) push(ctx context.Context, events []telemetryformat.Event) error {
	values := make([]lokiValue, 0, len(events))
	for index, event := range events {
		timestamp, err := time.Parse(time.RFC3339Nano, event.Ts)
		if err != nil {
			return fmt.Errorf("telemetry forwarder: event %d timestamp: %w", index, err)
		}
		line, err := json.Marshal(event)
		if err != nil {
			return fmt.Errorf("telemetry forwarder: event %d encode: %w", index, err)
		}
		values = append(values, lokiValue{fmt.Sprintf("%d", timestamp.UnixNano()), string(line)})
	}
	body, err := json.Marshal(lokiPushRequest{Streams: []lokiStream{{
		Stream: map[string]string{"service": "ion-telemetry", "service_name": "ion-telemetry"},
		Values: values,
	}}})
	if err != nil {
		return fmt.Errorf("telemetry forwarder: encode Loki request: %w", err)
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, f.endpoint, bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("telemetry forwarder: create Loki request: %w", err)
	}
	request.Header.Set("Content-Type", "application/json")
	response, err := f.client.Do(request)
	if err != nil {
		return fmt.Errorf("telemetry forwarder: push to Loki: %w", err)
	}
	defer func() { _ = response.Body.Close() }() //nolint:errcheck // response body is read only for status
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		return fmt.Errorf("telemetry forwarder: Loki push returned %s", response.Status)
	}
	return nil
}

// nextCursor accounts for filetail advancing only after this handler returns.
func nextCursor(cursor filetail.Cursor, lineLength int) filetail.Cursor {
	cursor.Offset += int64(lineLength + 1)
	return cursor
}

type lokiPushRequest struct {
	Streams []lokiStream `json:"streams"`
}

type lokiStream struct {
	Stream map[string]string `json:"stream"`
	Values []lokiValue       `json:"values"`
}

type lokiValue [2]string
