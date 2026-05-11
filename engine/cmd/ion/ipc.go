package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"strings"
	"time"
)

// connectAndSend connects to the engine socket, sends a command, waits for response.
func connectAndSend(sock string, msg map[string]interface{}) (map[string]interface{}, error) {
	reqID := nextRequestID()
	msg["requestId"] = reqID

	conn, err := net.Dial(dialNetwork(), sock)
	if err != nil {
		return nil, fmt.Errorf("cannot connect to engine at %s: %w", sock, err)
	}
	defer func() { _ = conn.Close() }()

	data, _ := json.Marshal(msg)
	_, _ = conn.Write(append(data, '\n'))

	scanner := bufio.NewScanner(conn)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		var parsed map[string]interface{}
		if err := json.Unmarshal([]byte(line), &parsed); err != nil {
			continue
		}
		if rid, _ := parsed["requestId"].(string); rid == reqID {
			return parsed, nil
		}
	}
	return nil, fmt.Errorf("connection closed before receiving response")
}

// attachStream connects to engine and streams all events to stdout. When
// deadline is non-zero, the stream is bounded by that wall-clock timeout —
// returns true if the deadline fired (caller should exit 124). A zero deadline
// means "no limit".
func attachStream(sock string, key string, deadline time.Duration) (timedOut bool) {
	conn, err := net.Dial(dialNetwork(), sock)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Connection error: %s\n", err)
		os.Exit(1)
	}
	defer func() { _ = conn.Close() }()

	if deadline > 0 {
		_ = conn.SetReadDeadline(time.Now().Add(deadline))
	}

	scanner := bufio.NewScanner(conn)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line != "" {
			fmt.Println(line)
		}
	}
	if scanErr := scanner.Err(); scanErr != nil && deadline > 0 {
		if netErr, ok := scanErr.(net.Error); ok && netErr.Timeout() {
			fmt.Fprintf(os.Stderr, "\nTimeout: stream exceeded %s deadline\n", deadline)
			return true
		}
	}
	return false
}

// streamUntilIdle connects to the engine socket and streams text deltas to
// stdout until the session emits engine_status with state=idle. When deadline
// is non-zero, the stream is bounded by that wall-clock timeout — returns true
// if the deadline fired (caller should abort and exit 124). A zero deadline
// means "no limit".
func streamUntilIdle(sock, key string, deadline time.Duration) (timedOut bool) {
	conn, err := net.Dial(dialNetwork(), sock)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error connecting to stream: %s\n", err)
		return false
	}
	defer func() { _ = conn.Close() }()

	// Set a read deadline so the scanner unblocks when the timeout fires.
	if deadline > 0 {
		_ = conn.SetReadDeadline(time.Now().Add(deadline))
	}

	scanner := bufio.NewScanner(conn)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		var msg map[string]interface{}
		if err := json.Unmarshal([]byte(line), &msg); err != nil {
			continue
		}
		if msgKey, _ := msg["key"].(string); msgKey != key {
			continue
		}
		event, _ := msg["event"].(map[string]interface{})
		if event == nil {
			continue
		}
		eventType, _ := event["type"].(string)
		switch eventType {
		case "engine_text_delta":
			if text, ok := event["text"].(string); ok {
				fmt.Print(text)
			}
		case "engine_status":
			fields, _ := event["fields"].(map[string]interface{})
			if fields != nil {
				if state, _ := fields["state"].(string); state == "idle" {
					fmt.Println()
					return false
				}
			}
		case "engine_error":
			if errMsg, ok := event["message"].(string); ok {
				fmt.Fprintf(os.Stderr, "\nError: %s\n", errMsg)
				return false
			}
		}
	}
	// Scanner exited — check if it was a timeout.
	if scanErr := scanner.Err(); scanErr != nil && deadline > 0 {
		if netErr, ok := scanErr.(net.Error); ok && netErr.Timeout() {
			fmt.Fprintf(os.Stderr, "\nTimeout: prompt exceeded %s deadline\n", deadline)
			return true
		}
	}
	return false
}
