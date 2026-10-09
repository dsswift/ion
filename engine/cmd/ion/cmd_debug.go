package main

import (
	"fmt"
	"os"
	"strconv"
	"time"

	"github.com/dsswift/ion/engine/internal/utils"
)

// debugProfileReplyGrace is how much longer than the requested capture the
// CLI waits for the daemon's reply.
const debugProfileReplyGrace = 30 * time.Second

// cmdDebug is `ion debug <sub>`: operator diagnostics against the running
// daemon. `profile <cpu|heap|goroutine|trace> [--seconds N]` asks the daemon
// to capture one Go runtime profile of itself (the debug_profile command)
// and prints the path it was written to, under <data dir>/profiles/.
func cmdDebug(positional []string, flags map[string]string) {
	if len(positional) == 0 {
		debugUsage()
		os.Exit(2)
	}
	switch positional[0] {
	case "profile":
		if len(positional) != 2 {
			debugUsage()
			os.Exit(2)
		}
		path, err := debugProfile(socketPathOrExit(), positional[1], flags["seconds"])
		if err != nil {
			fmt.Fprintf(os.Stderr, "debug profile: %v\n", err)
			os.Exit(1)
		}
		fmt.Println(path)
	default:
		debugUsage()
		os.Exit(2)
	}
}

// debugProfile sends debug_profile and returns the written file's path.
func debugProfile(sock, kind, secondsFlag string) (string, error) {
	seconds := 0
	if secondsFlag != "" {
		n, err := strconv.Atoi(secondsFlag)
		if err != nil || n <= 0 {
			return "", fmt.Errorf("--seconds must be a positive integer, got %q", secondsFlag)
		}
		seconds = n
	}
	msg := map[string]interface{}{"cmd": "debug_profile", "profileKind": kind}
	if seconds > 0 {
		msg["seconds"] = seconds
	}
	utils.LogWithFields(utils.LevelInfo, "debug", "requesting daemon profile", map[string]any{"kind": kind, "seconds": seconds, "sock": sock})
	resp, err := connectAndSendTimeout(sock, msg, time.Duration(seconds)*time.Second+debugProfileReplyGrace)
	if err != nil {
		return "", err
	}
	if ok, _ := resp["ok"].(bool); !ok { //nolint:errcheck // a missing ok is a failed command
		if e, _ := resp["error"].(string); e != "" { //nolint:errcheck // absent error text falls through to the generic message
			return "", fmt.Errorf("%s", e)
		}
		return "", fmt.Errorf("daemon refused the profile request")
	}
	data, _ := resp["data"].(map[string]interface{}) //nolint:errcheck // a reply without data is reported below
	path, _ := data["path"].(string)                 //nolint:errcheck // same
	if path == "" {
		return "", fmt.Errorf("daemon reply carried no profile path: %v", resp)
	}
	utils.LogWithFields(utils.LevelInfo, "debug", "daemon profile written", map[string]any{"kind": kind, "path": path})
	return path, nil
}

func debugUsage() {
	fmt.Fprintln(os.Stderr, "Usage: ion debug profile <cpu|heap|goroutine|trace> [--seconds N]")
}
