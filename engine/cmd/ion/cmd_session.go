package main

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"
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

	result, err := connectAndSend(socketPath(), map[string]interface{}{
		"cmd":    "start_session",
		"key":    key,
		"config": cfg,
	})
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %s\n", err)
		os.Exit(1)
	}
	data, _ := json.MarshalIndent(result, "", "  ")
	fmt.Println(string(data))
}

func cmdAttach(flags map[string]string) {
	attachStream(socketPath(), flags["key"])
}

func cmdStatus() {
	result, err := connectAndSend(socketPath(), map[string]interface{}{
		"cmd": "list_sessions",
	})
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %s\n", err)
		os.Exit(1)
	}

	sessions, _ := result["data"].([]interface{})
	if len(sessions) == 0 {
		fmt.Println("No active sessions")
		return
	}

	fmt.Printf("%-16s %-16s %-16s %-16s\n", "KEY", "PROFILE", "DIRECTORY", "STATE")
	fmt.Println(strings.Repeat("-", 64))
	for _, s := range sessions {
		sm, _ := s.(map[string]interface{})
		fmt.Printf("%-16s %-16s %-16s %-16s\n",
			sm["key"], sm["profile"], sm["directory"], sm["state"])
	}
}

func cmdStop(flags map[string]string) {
	msg := map[string]interface{}{
		"cmd": "stop_session",
	}
	if k := flags["key"]; k != "" {
		msg["key"] = k
	}
	result, err := connectAndSend(socketPath(), msg)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %s\n", err)
		os.Exit(1)
	}
	data, _ := json.MarshalIndent(result, "", "  ")
	fmt.Println(string(data))
}

func cmdShutdown() {
	result, err := connectAndSend(socketPath(), map[string]interface{}{
		"cmd": "shutdown",
	})
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %s\n", err)
		os.Exit(1)
	}
	data, _ := json.MarshalIndent(result, "", "  ")
	fmt.Println(string(data))
}

func cmdHealth() {
	result, err := connectAndSend(socketPath(), map[string]interface{}{
		"cmd": "health",
	})
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %s\n", err)
		os.Exit(1)
	}
	if errMsg, _ := result["error"].(string); errMsg != "" {
		fmt.Fprintf(os.Stderr, "Error: %s\n", errMsg)
		os.Exit(1)
	}
	data, _ := result["data"].(map[string]interface{})
	if data == nil {
		fmt.Fprintln(os.Stderr, "Error: empty health response")
		os.Exit(1)
	}
	out, _ := json.MarshalIndent(data, "", "  ")
	fmt.Println(string(out))
	if ok, _ := data["ok"].(bool); !ok {
		os.Exit(1)
	}
}
