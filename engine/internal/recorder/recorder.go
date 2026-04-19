// Package recorder writes NDJSON session recordings to disk. Each call to
// Record appends a single JSON-encoded line to the output file.
package recorder

import (
	"encoding/json"
	"fmt"
	"os"
	"sync"
)

// Recorder appends NDJSON lines to a file, optionally filtering by key.
type Recorder struct {
	file  *os.File
	key   string
	count int
	mu    sync.Mutex
}

// New creates a Recorder that writes to outputPath. If key is non-empty,
// only messages whose JSON contains a matching "type" field are recorded.
func New(outputPath, key string) (*Recorder, error) {
	f, err := os.OpenFile(outputPath, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		return nil, fmt.Errorf("recorder open: %w", err)
	}
	return &Recorder{file: f, key: key}, nil
}

// Record marshals msg to JSON and appends it as a single line.
// If a key filter is set, the message is only recorded if its "type" field
// matches the key.
func (r *Recorder) Record(msg interface{}) error {
	data, err := json.Marshal(msg)
	if err != nil {
		return fmt.Errorf("recorder marshal: %w", err)
	}

	if r.key != "" {
		var peek struct {
			Type string `json:"type"`
		}
		if err := json.Unmarshal(data, &peek); err == nil && peek.Type != r.key {
			return nil
		}
	}

	r.mu.Lock()
	defer r.mu.Unlock()

	if _, err := r.file.Write(append(data, '\n')); err != nil {
		return fmt.Errorf("recorder write: %w", err)
	}

	r.count++
	return nil
}

// Close flushes and closes the underlying file.
func (r *Recorder) Close() error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.file != nil {
		err := r.file.Close()
		r.file = nil
		return err
	}
	return nil
}

// MessageCount returns the number of messages recorded so far.
func (r *Recorder) MessageCount() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.count
}
