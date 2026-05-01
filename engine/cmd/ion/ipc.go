package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"strings"
)

// connectAndSend connects to the engine socket, sends a command, waits for response.
func connectAndSend(sock string, msg map[string]interface{}) (map[string]interface{}, error) {
	reqID := nextRequestID()
	msg["requestId"] = reqID

	conn, err := net.Dial(dialNetwork(), sock)
	if err != nil {
		return nil, fmt.Errorf("cannot connect to engine at %s: %w", sock, err)
	}
	defer conn.Close()

	data, _ := json.Marshal(msg)
	conn.Write(append(data, '\n'))

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

// attachStream connects to engine and streams all events to stdout.
func attachStream(sock string, key string) {
	conn, err := net.Dial(dialNetwork(), sock)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Connection error: %s\n", err)
		os.Exit(1)
	}
	defer conn.Close()

	scanner := bufio.NewScanner(conn)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line != "" {
			fmt.Println(line)
		}
	}
}

// streamUntilIdle connects to the engine socket and streams text deltas to
// stdout until the session emits engine_status with state=idle.
func streamUntilIdle(sock, key string) {
	conn, err := net.Dial(dialNetwork(), sock)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error connecting to stream: %s\n", err)
		return
	}
	defer conn.Close()

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
					return
				}
			}
		case "engine_error":
			if errMsg, ok := event["message"].(string); ok {
				fmt.Fprintf(os.Stderr, "\nError: %s\n", errMsg)
				return
			}
		}
	}
}
