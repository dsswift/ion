package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"strings"
	"time"
)

// promptStream is one engine connection that carried a send_prompt and stays
// open as that run's event stream. The engine counts the connection that sent
// a prompt as an owner of the session, and it reaps a session once every
// owner has been gone for its grace window. Streaming the run on that same
// connection keeps the session owned for as long as this CLI waits on it.
type promptStream struct {
	conn     net.Conn
	scanner  *bufio.Scanner
	deadline time.Duration
	// early holds lines that arrived before the engine answered the prompt.
	// They are replayed first, so no event of the run is lost.
	early []string
}

func newStreamScanner(conn net.Conn) *bufio.Scanner {
	scanner := bufio.NewScanner(conn)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	return scanner
}

// errPromptNotAccepted: the deadline fired before the engine answered the
// prompt.
var errPromptNotAccepted = errors.New("the engine did not answer the prompt before the deadline")

// openPromptStream sends msg (a send_prompt) on a new connection and returns
// that connection as the run's stream once the engine accepts the prompt. A
// non-zero deadline bounds the whole exchange, the answer and the stream.
func openPromptStream(sock string, msg map[string]interface{}, deadline time.Duration) (*promptStream, error) {
	reqID := nextRequestID()
	msg["requestId"] = reqID
	data, err := json.Marshal(msg)
	if err != nil {
		return nil, fmt.Errorf("marshal command: %w", err)
	}

	conn, err := net.Dial(dialNetwork(sock), sock)
	if err != nil {
		return nil, fmt.Errorf("cannot connect to engine at %s: %w", sock, err)
	}
	if deadline > 0 {
		conn.SetReadDeadline(time.Now().Add(deadline)) //nolint:errcheck // best-effort deadline; scanner surfaces a read failure
	}
	stream := &promptStream{conn: conn, scanner: newStreamScanner(conn), deadline: deadline}
	if _, err := conn.Write(append(data, '\n')); err != nil {
		stream.close()
		return nil, fmt.Errorf("write command to engine: %w", err)
	}

	for stream.scanner.Scan() {
		line := strings.TrimSpace(stream.scanner.Text())
		if line == "" {
			continue
		}
		var parsed map[string]interface{}
		if json.Unmarshal([]byte(line), &parsed) == nil {
			if rid, ok := parsed["requestId"].(string); ok && rid == reqID {
				if errMsg, ok := parsed["error"].(string); ok && errMsg != "" {
					stream.close()
					return nil, errors.New(errMsg)
				}
				return stream, nil
			}
		}
		stream.early = append(stream.early, line)
	}
	stream.close()
	if stream.timedOut() {
		return nil, errPromptNotAccepted
	}
	return nil, fmt.Errorf("connection closed before receiving response")
}

// next returns the stream's next non-empty line, or false when the
// connection ends or its deadline fires.
func (s *promptStream) next() (string, bool) {
	if len(s.early) > 0 {
		line := s.early[0]
		s.early = s.early[1:]
		return line, true
	}
	for s.scanner.Scan() {
		if line := strings.TrimSpace(s.scanner.Text()); line != "" {
			return line, true
		}
	}
	return "", false
}

// timedOut reports whether the stream ended because its deadline fired.
func (s *promptStream) timedOut() bool {
	var netErr net.Error
	return s.deadline > 0 && errors.As(s.scanner.Err(), &netErr) && netErr.Timeout()
}

func (s *promptStream) close() {
	s.conn.Close() //nolint:errcheck // best-effort IPC conn close during teardown
}

// printStream prints every line of the stream until it ends. It returns true
// when the deadline ended it (caller should exit 124).
func printStream(s *promptStream) (timedOut bool) {
	for line, ok := s.next(); ok; line, ok = s.next() {
		fmt.Println(line)
	}
	if s.timedOut() {
		fmt.Fprintf(os.Stderr, "\nTimeout: stream exceeded %s deadline\n", s.deadline)
		return true
	}
	return false
}

// streamEnd is how a streamed prompt run ended, as seen from the CLI.
type streamEnd int

const (
	// streamIdle: the session reported idle, so the run finished.
	streamIdle streamEnd = iota
	// streamFailed: the engine reported an error for the run, or the session
	// died before the run finished.
	streamFailed
	// streamTimedOut: the caller's deadline fired first.
	streamTimedOut
	// streamLost: the connection failed or closed before the run finished.
	streamLost
)

// exitCode is the process exit status for a prompt run that ended this way:
// 0 only for a finished run, 124 for a timeout, 1 for every failure.
func (e streamEnd) exitCode() int {
	switch e {
	case streamIdle:
		return 0
	case streamTimedOut:
		return 124
	default:
		return 1
	}
}

// streamUntilIdle prints the run's text deltas for key until the session
// emits engine_status with state=idle, the engine reports an error, the
// session dies, or the stream ends.
func streamUntilIdle(s *promptStream, key string) streamEnd {
	for line, ok := s.next(); ok; line, ok = s.next() {
		var msg map[string]interface{}
		if err := json.Unmarshal([]byte(line), &msg); err != nil {
			continue
		}
		if msgKey, ok := msg["key"].(string); !ok || msgKey != key {
			continue
		}
		event, ok := msg["event"].(map[string]interface{})
		if !ok || event == nil {
			continue
		}
		eventType, _ := event["type"].(string) //nolint:errcheck // missing/!string type falls through the switch as no-op
		switch eventType {
		case "engine_text_delta":
			if text, ok := event["text"].(string); ok {
				fmt.Print(text)
			}
		case "engine_status":
			fields, ok := event["fields"].(map[string]interface{})
			if ok && fields != nil {
				if state, ok := fields["state"].(string); ok && state == "idle" {
					fmt.Println()
					return streamIdle
				}
			}
		case "engine_error":
			if errMsg, ok := event["message"].(string); ok {
				fmt.Fprintf(os.Stderr, "\nError: %s\n", errMsg)
				return streamFailed
			}
		case "engine_dead":
			fmt.Fprintf(os.Stderr, "\nError: the session ended before the prompt finished\n")
			return streamFailed
		}
	}
	if s.timedOut() {
		fmt.Fprintf(os.Stderr, "\nTimeout: prompt exceeded %s deadline\n", s.deadline)
		return streamTimedOut
	}
	fmt.Fprintf(os.Stderr, "\nError: the engine closed the stream before the prompt finished\n")
	return streamLost
}
