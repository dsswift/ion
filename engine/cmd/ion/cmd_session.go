package main

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/dsswift/ion/engine/internal/protocol"
)

func cmdStart(flags map[string]string, listFlags map[string][]string) {
	profile := flags["profile"]
	dir := flags["dir"]
	if profile == "" {
		fmt.Fprintln(os.Stderr, "Error: --profile <name> required")
		os.Exit(1)
	}
	if dir == "" {
		fmt.Fprintln(os.Stderr, "Error: --dir <path> required")
		os.Exit(1)
	}

	key := flags["key"]
	if key == "" {
		key = profile
	}

	cfg := map[string]interface{}{
		"profileId":        profile,
		"workingDirectory": dir,
	}
	if exts := listFlags["extension"]; len(exts) > 0 {
		resolved := make([]string, len(exts))
		for i, e := range exts {
			resolved[i] = resolveExtensionPath(e)
		}
		cfg["extensions"] = resolved
	}

	result, err := connectAndSend(socketPathOrExit(), map[string]interface{}{
		"cmd":    "start_session",
		"key":    key,
		"config": cfg,
	})
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %s\n", err)
		os.Exit(1)
	}
	data := mustMarshalCLI(result)
	fmt.Println(string(data))
}

func cmdAttach(flags map[string]string) {
	attachStream(socketPathOrExit(), flags["key"], 0)
}

func cmdStatus(flags map[string]string) {
	if err := runStatus(os.Stdout, socketPathOrExit(), flags["json"] == "true"); err != nil {
		fmt.Fprintf(os.Stderr, "Error: %s\n", err)
		os.Exit(1)
	}
}

// runStatus lists the engine's sessions as `list_sessions` reports them: the
// session key, its conversation, whether a run is active, and its tool count.
func runStatus(w io.Writer, sock string, asJSON bool) error {
	result, err := connectAndSend(sock, map[string]interface{}{
		"cmd": "list_sessions",
	})
	if err != nil {
		return err
	}
	if errMsg, ok := result["error"].(string); ok && errMsg != "" {
		return fmt.Errorf("list_sessions: %s", errMsg)
	}
	sessions, err := decodeSessionList(result["data"])
	if err != nil {
		return err
	}
	if asJSON {
		_, err := fmt.Fprintln(w, string(mustMarshalCLI(sessions)))
		return err
	}
	if len(sessions) == 0 {
		_, err := fmt.Fprintln(w, "No active sessions")
		return err
	}
	var b strings.Builder
	fmt.Fprintf(&b, "%-24s %-38s %-7s %s\n", "KEY", "CONVERSATION", "ACTIVE", "TOOLS")
	b.WriteString(strings.Repeat("-", 78) + "\n")
	for _, s := range sessions {
		active := "no"
		if s.HasActiveRun {
			active = "yes"
		}
		fmt.Fprintf(&b, "%-24s %-38s %-7s %d\n", s.Key, orDash(s.ConversationID), active, s.ToolCount)
	}
	_, err = io.WriteString(w, b.String())
	return err
}

// decodeSessionList reads a `list_sessions` result's data array.
func decodeSessionList(data interface{}) ([]protocol.SessionInfo, error) {
	sessions := []protocol.SessionInfo{}
	if data == nil {
		return sessions, nil
	}
	raw, err := json.Marshal(data)
	if err != nil {
		return nil, fmt.Errorf("re-encode list_sessions data: %w", err)
	}
	if err := json.Unmarshal(raw, &sessions); err != nil {
		return nil, fmt.Errorf("decode list_sessions data: %w", err)
	}
	return sessions, nil
}

func cmdStop(flags map[string]string) {
	msg := map[string]interface{}{
		"cmd": "stop_session",
	}
	if k := flags["key"]; k != "" {
		msg["key"] = k
	}
	result, err := connectAndSend(socketPathOrExit(), msg)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %s\n", err)
		os.Exit(1)
	}
	data := mustMarshalCLI(result)
	fmt.Println(string(data))
}

func cmdShutdown() {
	result, err := connectAndSend(socketPathOrExit(), map[string]interface{}{
		"cmd": "shutdown",
	})
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %s\n", err)
		os.Exit(1)
	}
	data := mustMarshalCLI(result)
	fmt.Println(string(data))
}

func cmdHealth() {
	result, err := connectAndSend(socketPathOrExit(), map[string]interface{}{
		"cmd": "health",
	})
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %s\n", err)
		os.Exit(1)
	}
	if errMsg, ok := result["error"].(string); ok && errMsg != "" {
		fmt.Fprintf(os.Stderr, "Error: %s\n", errMsg)
		os.Exit(1)
	}
	data, _ := result["data"].(map[string]interface{}) //nolint:errcheck // nil/!object handled by the empty-response guard below
	if data == nil {
		fmt.Fprintln(os.Stderr, "Error: empty health response")
		os.Exit(1)
	}
	out := mustMarshalCLI(data)
	fmt.Println(string(out))
	if ok, _ := data["ok"].(bool); !ok { //nolint:errcheck // missing/!bool ok treated as unhealthy -> exit 1
		os.Exit(1)
	}
}
