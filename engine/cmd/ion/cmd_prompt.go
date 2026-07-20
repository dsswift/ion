package main

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/dsswift/ion/engine/internal/utils"
)

// teardownSend fires a best-effort teardown command (abort/stop_session/
// shutdown) at the engine during ephemeral-session cleanup. Failure is logged
// at Warn: a dropped abort leaves a runaway session alive on the daemon, which
// an operator wants to see rather than silently discard.
func teardownSend(sock, cmd, key string) {
	msg := map[string]interface{}{"cmd": cmd}
	if key != "" {
		msg["key"] = key
	}
	if _, err := connectAndSend(sock, msg); err != nil {
		utils.LogWithFields(utils.LevelWarn, "prompt", "teardown command failed", map[string]any{
			"cmd":   cmd,
			"key":   key,
			"error": utils.ErrStr(err),
		})
	}
}

func cmdPrompt(positional []string, flags map[string]string, listFlags map[string][]string) {
	text := strings.Join(positional, " ")
	if text == "" {
		fmt.Fprintln(os.Stderr, "Error: prompt text required")
		os.Exit(1)
	}

	// Parse --timeout flag (duration string like 60s, 5m, 2h).
	var timeout time.Duration
	if t := flags["timeout"]; t != "" {
		d, err := time.ParseDuration(t)
		if err != nil {
			fmt.Fprintf(os.Stderr, "Error: invalid --timeout value %q: %s\n", t, err)
			os.Exit(1)
		}
		timeout = d
	}

	sock := socketPath()
	serverStarted := ensureServer(sock)

	key := flags["key"]
	ephemeral := key == ""
	if ephemeral {
		b := make([]byte, 8)
		if _, err := rand.Read(b); err != nil {
			fmt.Fprintf(os.Stderr, "Error generating session key: %s\n", err)
			os.Exit(1)
		}
		key = "prompt-" + hex.EncodeToString(b)

		cwd, _ := os.Getwd() //nolint:errcheck // cwd failure falls back to empty working directory
		config := map[string]interface{}{"workingDirectory": cwd}
		if m := flags["model"]; m != "" {
			config["model"] = m
		}
		if exts := listFlags["extension"]; len(exts) > 0 {
			resolved := make([]string, len(exts))
			for i, e := range exts {
				resolved[i] = resolveExtensionPath(e)
			}
			config["extensions"] = resolved
		}
		startMsg := map[string]interface{}{
			"cmd":    "start_session",
			"key":    key,
			"config": config,
		}
		result, err := connectAndSend(sock, startMsg)
		if err != nil {
			fmt.Fprintf(os.Stderr, "Error starting session: %s\n", err)
			os.Exit(1)
		}
		if errMsg, ok := result["error"].(string); ok && errMsg != "" {
			fmt.Fprintf(os.Stderr, "Error starting session: %s\n", errMsg)
			os.Exit(1)
		}
	} else {
		cwd, _ := os.Getwd() //nolint:errcheck // cwd failure falls back to empty working directory
		config := map[string]interface{}{"workingDirectory": cwd}
		if m := flags["model"]; m != "" {
			config["model"] = m
		}
		if exts := listFlags["extension"]; len(exts) > 0 {
			resolved := make([]string, len(exts))
			for i, e := range exts {
				resolved[i] = resolveExtensionPath(e)
			}
			config["extensions"] = resolved
		}
		startMsg := map[string]interface{}{
			"cmd":    "start_session",
			"key":    key,
			"config": config,
		}
		result, err := connectAndSend(sock, startMsg)
		if err != nil {
			fmt.Fprintf(os.Stderr, "Error starting session: %s\n", err)
			os.Exit(1)
		}
		if errMsg, ok := result["error"].(string); ok && errMsg != "" {
			if !strings.Contains(errMsg, "already exists") {
				fmt.Fprintf(os.Stderr, "Error starting session: %s\n", errMsg)
				os.Exit(1)
			}
		}
	}

	msg := map[string]interface{}{
		"cmd":  "send_prompt",
		"key":  key,
		"text": text,
	}
	if m := flags["model"]; m != "" {
		msg["model"] = m
	}
	if mt := flags["max-turns"]; mt != "" {
		n, err := strconv.Atoi(mt)
		if err != nil {
			utils.LogWithFields(utils.LevelWarn, "prompt", "invalid --max-turns flag ignored", map[string]any{
				"value": mt,
				"error": utils.ErrStr(err),
			})
		} else {
			msg["maxTurns"] = n
		}
	}
	if mb := flags["max-budget"]; mb != "" {
		f, err := strconv.ParseFloat(mb, 64)
		if err != nil {
			utils.LogWithFields(utils.LevelWarn, "prompt", "invalid --max-budget flag ignored", map[string]any{
				"value": mb,
				"error": utils.ErrStr(err),
			})
		} else {
			msg["maxBudgetUsd"] = f
		}
	}
	if exts := listFlags["extension"]; len(exts) > 0 {
		resolved := make([]string, len(exts))
		for i, e := range exts {
			resolved[i] = resolveExtensionPath(e)
		}
		msg["extensions"] = resolved
	}
	if flags["no-extensions"] == "true" {
		msg["noExtensions"] = true
	}

	outputMode := flags["output"]
	if outputMode == "" {
		outputMode = "text"
	}

	if ephemeral && outputMode == "text" {
		result, err := connectAndSend(sock, msg)
		if err != nil {
			fmt.Fprintf(os.Stderr, "Error: %s\n", err)
			os.Exit(1)
		}
		if errMsg, ok := result["error"].(string); ok && errMsg != "" {
			fmt.Fprintf(os.Stderr, "Error: %s\n", errMsg)
			os.Exit(1)
		}
		timedOut := streamUntilIdle(sock, key, timeout)
		if timedOut {
			// Send abort so the engine doesn't keep running.
			teardownSend(sock, "abort", key)
		}
		teardownSend(sock, "stop_session", key)
		if serverStarted {
			teardownSend(sock, "shutdown", "")
		}
		if timedOut {
			os.Exit(124)
		}
		return
	}

	if outputMode == "stream-json" {
		result, err := connectAndSend(sock, msg)
		if err != nil {
			fmt.Fprintf(os.Stderr, "Error: %s\n", err)
			os.Exit(1)
		}
		if errMsg, ok := result["error"].(string); ok && errMsg != "" {
			fmt.Fprintf(os.Stderr, "Error: %s\n", errMsg)
			os.Exit(1)
		}
		timedOut := attachStream(sock, key, timeout)
		if timedOut {
			if ephemeral {
				teardownSend(sock, "abort", key)
				teardownSend(sock, "stop_session", key)
				if serverStarted {
					teardownSend(sock, "shutdown", "")
				}
			}
			os.Exit(124)
		}
		return
	}

	result, err := connectAndSend(sock, msg)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %s\n", err)
		os.Exit(1)
	}

	if outputMode == "json" {
		data := mustMarshalCLI(result)
		fmt.Println(string(data))
		return
	}

	if errMsg, ok := result["error"].(string); ok && errMsg != "" {
		fmt.Fprintf(os.Stderr, "Error: %s\n", errMsg)
		os.Exit(1)
	}
	if ok, _ := result["ok"].(bool); ok { //nolint:errcheck // missing/!bool ok treated as failure -> prints result JSON
		if flags["attach"] == "true" {
			timedOut := streamUntilIdle(sock, key, timeout)
			if timedOut {
				fmt.Fprintf(os.Stderr, "\nTimeout: prompt exceeded %s deadline\n", timeout)
				os.Exit(124)
			}
		} else {
			fmt.Println("Prompt sent. Use `ion attach` to stream output.")
		}
	} else {
		data := mustMarshalCLI(result)
		fmt.Println(string(data))
	}
}
