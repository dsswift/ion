package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"strings"

	"github.com/dsswift/ion/engine/internal/utils"
)

func cmdRecord(flags map[string]string) {
	output := flags["output"]
	if output == "" {
		fmt.Fprintln(os.Stderr, "Error: --output <path> required")
		os.Exit(1)
	}

	f, err := os.Create(output)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error creating file: %s\n", err)
		os.Exit(1)
	}
	defer func() { f.Close() }() //nolint:errcheck // best-effort close on read-only recording sink during teardown

	conn, err := net.Dial(dialNetwork(), socketPath())
	if err != nil {
		fmt.Fprintf(os.Stderr, "Connection error: %s\n", err)
		os.Exit(1)
	}
	defer func() { conn.Close() }() //nolint:errcheck // best-effort IPC conn close during teardown

	fmt.Printf("Recording to %s...\n", output)
	if k := flags["key"]; k != "" {
		fmt.Printf("Filtering to key: %s\n", k)
	}
	fmt.Println("Press Ctrl+C to stop.")

	count := 0
	scanner := bufio.NewScanner(conn)
	for scanner.Scan() {
		line := scanner.Text()
		if strings.TrimSpace(line) == "" {
			continue
		}
		if key := flags["key"]; key != "" {
			var parsed map[string]interface{}
			if json.Unmarshal([]byte(line), &parsed) == nil {
				if k, ok := parsed["key"].(string); !ok || k != key {
					continue
				}
			}
		}
		if _, err := f.WriteString(line + "\n"); err != nil {
			utils.LogWithFields(utils.LevelError, "record", "recording sink write failed, stopping", map[string]any{
				"path":  output,
				"count": count,
				"error": utils.ErrStr(err),
			})
			break
		}
		count++
	}
	fmt.Printf("\nRecorded %d messages to %s\n", count, output)
}

func cmdRpc() {
	conn, err := net.Dial(dialNetwork(), socketPath())
	if err != nil {
		fmt.Fprintf(os.Stderr, "Connection error: %s\n", err)
		os.Exit(1)
	}
	defer func() { conn.Close() }() //nolint:errcheck // best-effort IPC conn close during teardown

	fmt.Fprintln(os.Stderr, "Connected to engine server (RPC mode)")

	go func() {
		scanner := bufio.NewScanner(conn)
		for scanner.Scan() {
			line := scanner.Text()
			if strings.TrimSpace(line) != "" {
				fmt.Println(line)
			}
		}
		os.Exit(0)
	}()

	scanner := bufio.NewScanner(os.Stdin)
	for scanner.Scan() {
		line := scanner.Text()
		if strings.TrimSpace(line) != "" {
			conn.Write([]byte(line + "\n")) //nolint:errcheck // best-effort IPC write; peer read loop surfaces disconnect
		}
	}
	conn.Close() //nolint:errcheck // best-effort IPC conn close during teardown
}
