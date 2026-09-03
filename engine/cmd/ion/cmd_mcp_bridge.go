package main

import (
	"fmt"
	"io"
	"net"
	"os"
)

// cmdMcpBridge implements `ion mcp-bridge --socket <path>`: a minimal stdio<->Unix
// socket byte pump. A delegated CLI (claude-code via `--mcp-config`, or grok/cursor
// via ACP `session/new` mcpServers) spawns this as its MCP stdio server; it dials
// the engine's per-session ToolServer Unix socket and copies bytes both ways. It
// parses no MCP frames — the ToolServer remains the sole MCP server and protocol
// owner.
//
// This replaces `socat UNIX-CONNECT:<sock> STDIO`, removing Ion's hidden dependency
// on socat — a third-party binary Ion never ships, installs, or probes. When socat
// was absent (a stock macOS host has none), the delegated CLI could not spawn the
// bridge, the ion-extensions MCP server reported status "failed", and every ion
// tool (ExitPlanMode, ion_agent, and every client tool such as AskUserQuestion)
// vanished with "No such tool available". Self-execing the always-present Ion
// binary removes that failure at its cause.
func cmdMcpBridge(flags map[string]string) {
	sock := flags["socket"]
	if sock == "" {
		fmt.Fprintln(os.Stderr, "mcp-bridge: --socket <path> is required")
		os.Exit(2)
	}
	if err := runMcpBridge(sock, os.Stdin, os.Stdout, dialUnixSocket); err != nil {
		// This subprocess's stdout is the MCP JSON-RPC channel, so diagnostics go
		// to stderr, which the delegated CLI captures as MCP-server log output.
		fmt.Fprintf(os.Stderr, "mcp-bridge: %v\n", err)
		os.Exit(1)
	}
}

// dialUnixSocket is the production dialer for the bridge. Split out so tests can
// inject their own dialer and drive a real ToolServer round trip without a
// process boundary.
func dialUnixSocket(path string) (net.Conn, error) { return net.Dial("unix", path) }

// runMcpBridge dials sockPath and pumps in->socket and socket->out until the
// session ends. It blocks on the socket->out direction: the ToolServer closing the
// connection is the authoritative "session over" signal, and draining that
// direction fully guarantees no buffered MCP response is dropped when the CLI
// closes its stdin first. The in->socket direction runs concurrently and, on stdin
// EOF, half-closes the socket write side so the ToolServer reads EOF and unwinds
// the MCP session cleanly.
//
// Returns a non-nil error only for a dial (transport setup) failure; a clean EOF
// on the socket returns nil.
func runMcpBridge(sockPath string, in io.Reader, out io.Writer, dial func(string) (net.Conn, error)) error {
	conn, err := dial(sockPath)
	if err != nil {
		return fmt.Errorf("dial %s: %w", sockPath, err)
	}
	defer conn.Close() //nolint:errcheck // best-effort close of the bridge conn on exit

	go func() {
		// stdin -> socket. An EOF or error both mean the CLI is done sending; in
		// either case we half-close the write side so the ToolServer sees EOF.
		io.Copy(conn, in) //nolint:errcheck // EOF/err both terminate this direction; the socket->out copy owns the exit signal
		if uc, ok := conn.(*net.UnixConn); ok {
			uc.CloseWrite() //nolint:errcheck // best-effort half-close; the deferred Close covers the rest
		}
	}()

	// socket -> stdout. io.Copy returns nil at a clean EOF (session ended); any
	// other error is surfaced to the caller for stderr reporting.
	_, copyErr := io.Copy(out, conn)
	return copyErr
}
