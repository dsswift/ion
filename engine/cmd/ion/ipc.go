package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"strings"
	"time"

	"github.com/dsswift/ion/engine/internal/engineipc"
	"github.com/dsswift/ion/engine/internal/utils"
)

// connectAndSend connects to the engine socket, sends a command, waits for response.
func connectAndSend(sock string, msg map[string]interface{}) (map[string]interface{}, error) {
	reqID := nextRequestID()
	msg["requestId"] = reqID

	conn, err := net.Dial(dialNetwork(sock), sock)
	if err != nil {
		return nil, fmt.Errorf("cannot connect to engine at %s: %w", sock, err)
	}
	defer func() { conn.Close() }() //nolint:errcheck // best-effort IPC conn close during teardown

	data, err := json.Marshal(msg)
	if err != nil {
		return nil, fmt.Errorf("marshal command: %w", err)
	}
	if _, err := conn.Write(append(data, '\n')); err != nil {
		return nil, fmt.Errorf("write command to engine: %w", err)
	}

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
		if rid, ok := parsed["requestId"].(string); ok && rid == reqID {
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
	conn, err := net.Dial(dialNetwork(sock), sock)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Connection error: %s\n", err)
		os.Exit(1)
	}
	defer func() { conn.Close() }() //nolint:errcheck // best-effort IPC conn close during teardown

	if deadline > 0 {
		conn.SetReadDeadline(time.Now().Add(deadline)) //nolint:errcheck // best-effort deadline; scanner surfaces a read failure
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
	conn, err := net.Dial(dialNetwork(sock), sock)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error connecting to stream: %s\n", err)
		return false
	}
	defer func() { conn.Close() }() //nolint:errcheck // best-effort IPC conn close during teardown

	// Set a read deadline so the scanner unblocks when the timeout fires.
	if deadline > 0 {
		conn.SetReadDeadline(time.Now().Add(deadline)) //nolint:errcheck // best-effort deadline; scanner surfaces a read failure
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

// connectAndSendTimeout is connectAndSend bounded by a deadline over the dial,
// the write, and the wait for the answer, for a probe that must not hang on
// an engine that accepted the connection but never replies.
func connectAndSendTimeout(sock string, msg map[string]interface{}, timeout time.Duration) (map[string]interface{}, error) {
	return engineipc.Request(dialNetwork(sock), sock, msg, timeout)
}

// shareIdentityWithOwnUser lets a non-elevated engine verify this process
// when it runs elevated, as an administrator's SSH session does on Windows.
func shareIdentityWithOwnUser() {
	changed, err := utils.ShareIdentityWithOwnUser()
	if err != nil {
		utils.LogWithFields(utils.LevelWarn, "cli", "could not share this elevated process's identity with its own user; a non-elevated engine will refuse it", map[string]any{"error": err.Error()})
		return
	}
	if changed {
		utils.LogWithFields(utils.LevelDebug, "cli", "shared this elevated process's identity with its own user", nil)
	}
}
