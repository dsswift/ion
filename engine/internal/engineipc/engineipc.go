// Package engineipc sends one command to an engine socket and reads its
// answer, bounded by a deadline: the request/response half of the NDJSON
// protocol a CLI probe needs, for callers outside the `ion` main package.
package engineipc

import (
	"bufio"
	"encoding/json"
	"fmt"
	"net"
	"strconv"
	"sync/atomic"
	"time"
)

var seq atomic.Int64

// Request sends msg (a `cmd` plus its fields) to the engine at sock over
// network ("unix", or "tcp4" for a Windows host:port) and returns the result
// envelope whose requestId matches. The deadline covers the dial, the write,
// and the wait, so an engine that accepts and never answers cannot hang the
// caller.
func Request(network, sock string, msg map[string]any, timeout time.Duration) (map[string]any, error) {
	reqID := "ipc-" + strconv.FormatInt(time.Now().UnixNano(), 36) + "-" + strconv.FormatInt(seq.Add(1), 10)
	msg["requestId"] = reqID
	conn, err := net.DialTimeout(network, sock, timeout)
	if err != nil {
		return nil, fmt.Errorf("cannot connect to engine at %s: %w", sock, err)
	}
	defer func() { conn.Close() }() //nolint:errcheck // best-effort IPC conn close during teardown
	if err := conn.SetDeadline(time.Now().Add(timeout)); err != nil {
		return nil, fmt.Errorf("set deadline: %w", err)
	}
	data, err := json.Marshal(msg)
	if err != nil {
		return nil, fmt.Errorf("marshal command: %w", err)
	}
	if _, err := conn.Write(append(data, '\n')); err != nil {
		return nil, fmt.Errorf("write command to engine: %w", err)
	}
	scanner := bufio.NewScanner(conn)
	scanner.Buffer(make([]byte, 0, 64*1024), 8<<20)
	for scanner.Scan() {
		var parsed map[string]any
		if err := json.Unmarshal(scanner.Bytes(), &parsed); err != nil {
			continue
		}
		if rid, ok := parsed["requestId"].(string); ok && rid == reqID {
			return parsed, nil
		}
	}
	if err := scanner.Err(); err != nil {
		return nil, fmt.Errorf("read engine answer: %w", err)
	}
	return nil, fmt.Errorf("connection closed before receiving response")
}

// Data decodes a result envelope's `data` into out, or returns its `error`.
func Data(res map[string]any, out any) error {
	if msg, ok := res["error"].(string); ok && msg != "" {
		return fmt.Errorf("%s", msg)
	}
	raw, err := json.Marshal(res["data"])
	if err != nil {
		return fmt.Errorf("re-encode data: %w", err)
	}
	return json.Unmarshal(raw, out)
}
