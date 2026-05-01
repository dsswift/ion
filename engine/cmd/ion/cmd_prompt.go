package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"strconv"
	"strings"
)

func cmdPrompt(positional []string, flags map[string]string, listFlags map[string][]string) {
	text := strings.Join(positional, " ")
	if text == "" {
		fmt.Fprintln(os.Stderr, "Error: prompt text required")
		os.Exit(1)
	}

	sock := socketPath()
	serverStarted := ensureServer(sock)

	key := flags["key"]
	ephemeral := key == ""
	if ephemeral {
		b := make([]byte, 8)
		rand.Read(b)
		key = "prompt-" + hex.EncodeToString(b)

		cwd, _ := os.Getwd()
		startMsg := map[string]interface{}{
			"cmd": "start_session",
			"key": key,
			"config": map[string]interface{}{
				"workingDirectory": cwd,
			},
		}
		if m := flags["model"]; m != "" {
			startMsg["config"].(map[string]interface{})["model"] = m
		}
		if exts := listFlags["extension"]; len(exts) > 0 {
			resolved := make([]string, len(exts))
			for i, e := range exts {
				resolved[i] = resolveExtensionPath(e)
			}
			startMsg["config"].(map[string]interface{})["extensions"] = resolved
		}
		result, err := connectAndSend(sock, startMsg)
		if err != nil {
			fmt.Fprintf(os.Stderr, "Error starting session: %s\n", err)
			os.Exit(1)
		}
		if errMsg, _ := result["error"].(string); errMsg != "" {
			fmt.Fprintf(os.Stderr, "Error starting session: %s\n", errMsg)
			os.Exit(1)
		}
	} else {
		cwd, _ := os.Getwd()
		startMsg := map[string]interface{}{
			"cmd": "start_session",
			"key": key,
			"config": map[string]interface{}{
				"workingDirectory": cwd,
			},
		}
		if m := flags["model"]; m != "" {
			startMsg["config"].(map[string]interface{})["model"] = m
		}
		if exts := listFlags["extension"]; len(exts) > 0 {
			resolved := make([]string, len(exts))
			for i, e := range exts {
				resolved[i] = resolveExtensionPath(e)
			}
			startMsg["config"].(map[string]interface{})["extensions"] = resolved
		}
		result, err := connectAndSend(sock, startMsg)
		if err != nil {
			fmt.Fprintf(os.Stderr, "Error starting session: %s\n", err)
			os.Exit(1)
		}
		if errMsg, _ := result["error"].(string); errMsg != "" {
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
		n, _ := strconv.Atoi(mt)
		msg["maxTurns"] = n
	}
	if mb := flags["max-budget"]; mb != "" {
		f, _ := strconv.ParseFloat(mb, 64)
		msg["maxBudgetUsd"] = f
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
		if errMsg, _ := result["error"].(string); errMsg != "" {
			fmt.Fprintf(os.Stderr, "Error: %s\n", errMsg)
			os.Exit(1)
		}
		streamUntilIdle(sock, key)
		connectAndSend(sock, map[string]interface{}{
			"cmd": "stop_session",
			"key": key,
		})
		if serverStarted {
			connectAndSend(sock, map[string]interface{}{
				"cmd": "shutdown",
			})
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
		attachStream(sock, key)
		return
	}

	result, err := connectAndSend(sock, msg)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %s\n", err)
		os.Exit(1)
	}

	if outputMode == "json" {
		data, _ := json.MarshalIndent(result, "", "  ")
		fmt.Println(string(data))
		return
	}

	if errMsg, ok := result["error"].(string); ok && errMsg != "" {
		fmt.Fprintf(os.Stderr, "Error: %s\n", errMsg)
		os.Exit(1)
	}
	if ok, _ := result["ok"].(bool); ok {
		if flags["attach"] == "true" {
			streamUntilIdle(sock, key)
		} else {
			fmt.Println("Prompt sent. Use `ion attach` to stream output.")
		}
	} else {
		data, _ := json.MarshalIndent(result, "", "  ")
		fmt.Println(string(data))
	}
}
