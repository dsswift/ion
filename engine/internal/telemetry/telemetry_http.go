package telemetry

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"

	"github.com/dsswift/ion/engine/internal/network"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// telemetry_http.go implements the "http" target: a JSON array of events
// POSTed to the configured endpoint, with the shared durable retry queue
// (telemetry_retry_queue.go) behind it. Extracted from telemetry.go to keep
// that file under the file-size cap; the target's semantics are unchanged.

func hasHTTPTarget(targets []string) bool {
	for _, t := range targets {
		if t == "http" {
			return true
		}
	}
	return false
}

// setupHTTPTarget wires the "http" target's retry queue into a
// newly-constructed Collector. Called once from NewCollector when "http" is
// configured. The deliverFunc returns the whole batch as still owed on any
// failure: HTTP has no per-event size contract, so nothing is disposed of
// another way.
func setupHTTPTarget(c *Collector, config types.TelemetryConfig) {
	c.httpRetry = newRetryQueue(
		"http",
		retryQueuePath("http", config.FilePath, config.HttpEndpoint),
		config.HttpRetryQueueMaxMB,
		config.RetryQueueSoftWarnMB,
		config.RetryQueueStuckAfterMinutes,
		func(events []Event) ([]Event, error) {
			if err := flushToHTTP(events, config.HttpEndpoint, config.HttpHeaders); err != nil {
				return events, err
			}
			return nil, nil
		},
	)
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
	resp, err := network.GetHTTPClient().Do(req)
	if err != nil {
		return err
	}
	if err := resp.Body.Close(); err != nil {
		utils.LogWithFields(utils.LevelInfo, "telemetry", "http post response body close failed", map[string]any{"error": err.Error()})
	}
	if resp.StatusCode >= 400 {
		return fmt.Errorf("telemetry HTTP POST returned status %d", resp.StatusCode)
	}
	return nil
}
