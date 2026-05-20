package providers

import (
	"bufio"
	"io"
	"strings"
	"sync"
)

// SSEEvent represents a single Server-Sent Event.
type SSEEvent struct {
	Event string
	Data  string
}

// ParseSSEStream reads an SSE stream and emits events on the returned channel.
// The channel is closed when the reader returns EOF or an error occurs.
//
// The returned errFn must be called after the events channel is drained to
// retrieve any error encountered while reading. It returns nil for a clean EOF
// and the underlying read error otherwise (e.g. io.ErrUnexpectedEOF, *net.OpError,
// "http2: stream reset"). Callers MUST consult errFn to distinguish a clean
// end-of-stream from a truncated/dropped connection.
func ParseSSEStream(reader io.Reader) (<-chan SSEEvent, func() error) {
	ch := make(chan SSEEvent, 16)
	var (
		mu      sync.Mutex
		readErr error
		done    = make(chan struct{})
	)

	go func() {
		defer close(ch)
		defer close(done)

		scanner := bufio.NewScanner(reader)
		// Allow lines up to 1MB for large JSON payloads
		scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)

		var currentEvent string
		var dataLines []string

		for scanner.Scan() {
			line := scanner.Text()

			// Empty line signals end of event
			if line == "" {
				if len(dataLines) > 0 {
					data := strings.Join(dataLines, "\n")
					// Skip [DONE] sentinel used by OpenAI
					if data == "[DONE]" {
						dataLines = nil
						currentEvent = ""
						continue
					}
					ch <- SSEEvent{
						Event: currentEvent,
						Data:  data,
					}
					dataLines = nil
					currentEvent = ""
				}
				continue
			}

			if strings.HasPrefix(line, "event: ") {
				currentEvent = strings.TrimPrefix(line, "event: ")
			} else if strings.HasPrefix(line, "data: ") {
				dataLines = append(dataLines, strings.TrimPrefix(line, "data: "))
			} else if line == "data:" {
				dataLines = append(dataLines, "")
			}
			// Ignore comments (lines starting with :) and unknown fields
		}

		// Flush any remaining event if the stream ended without a trailing blank line
		if len(dataLines) > 0 {
			data := strings.Join(dataLines, "\n")
			if data != "[DONE]" {
				ch <- SSEEvent{Event: currentEvent, Data: data}
			}
		}

		if err := scanner.Err(); err != nil {
			mu.Lock()
			readErr = err
			mu.Unlock()
		}
	}()

	errFn := func() error {
		<-done
		mu.Lock()
		defer mu.Unlock()
		return readErr
	}

	return ch, errFn
}
