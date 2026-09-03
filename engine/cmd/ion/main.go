package main

import (
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/dsswift/ion/engine/internal/utils"
)

var version = "dev"

func main() {
	command, flags, listFlags, positional := parseArgs()

	// Answering a question about the binary must not touch the operator's
	// engine.jsonl. Provider registration runs in package init() and every
	// provider constructor logs, so the log file is already destined to be
	// written by the time main() runs — this discards it before the first
	// flush. Must happen before the switch, and before anything else logs.
	if command == "version" || command == "help" || command == "mcp-bridge" {
		// mcp-bridge is a transient stdio<->socket adapter spawned per delegated-CLI
		// MCP session; it must not spam the operator's engine.jsonl with the
		// provider-registration logs every process emits at init().
		utils.DiscardOperationalLogs()
	}

	switch command {
	case "serve":
		// Wrap in an anonymous func with a recover so panics write a
		// breadcrumb before the process exits. Re-panic preserves the exit code.
		func() {
			defer func() {
				if r := recover(); r != nil {
					stack := captureStack()
					writePanic(exitPath(), fmt.Sprintf("%v", r), stack)
					panic(r) // re-panic to preserve non-zero exit
				}
			}()
			cmdServe()
		}()
	case "start":
		cmdStart(flags, listFlags)
	case "prompt":
		cmdPrompt(positional, flags, listFlags)
	case "attach":
		cmdAttach(flags)
	case "status":
		cmdStatus()
	case "stop":
		cmdStop(flags)
	case "shutdown":
		cmdShutdown()
	case "health":
		cmdHealth()
	case "record":
		cmdRecord(flags)
	case "rpc":
		cmdRpc()
	case "upgrade":
		cmdUpgrade()
	case "install-assets":
		cmdInstallAssets()
	case "plugin":
		cmdPlugin(positional)
	case "auth":
		cmdAuth(positional, flags)
	case "mcp":
		cmdMcp(positional, flags, listFlags)
	case "mcp-bridge":
		cmdMcpBridge(flags)
	case "telemetry":
		cmdTelemetry(positional, flags)
	case "version":
		fmt.Printf("ion-engine %s\n", version)
	case "help":
		// Reached by `help`, `--help`, and `-h`. printUsage exits non-zero
		// because it is also the unknown-command path; an explicit request for
		// help is not an error, so it exits 0.
		printUsageTo(os.Stdout)
	default:
		printUsage()
	}
}

// printUsage writes usage to stderr and exits 1. This is the unknown-command
// path: the caller asked for something that does not exist, so the non-zero
// exit and the stderr stream are both correct.
func printUsage() {
	printUsageTo(os.Stderr)
	os.Exit(1)
}

// printUsageTo renders the usage text to w. Split from printUsage so an
// explicit `help` request can write to stdout and exit 0, while an unknown
// command still writes to stderr and exits 1.
func printUsageTo(w io.Writer) {
	// Built as one string and written once: a per-line Fprintln to an
	// io.Writer returns an error errcheck rightly demands be handled, and
	// threading a check through ~40 calls would be noise. One write also means
	// usage text cannot interleave with another goroutine's output.
	var b strings.Builder
	b.WriteString("Ion Engine - Headless AI agent runtime" + "\n")
	b.WriteString("\n")
	b.WriteString("Usage: ion [command] [options]" + "\n")
	b.WriteString("\n")
	b.WriteString("Commands:" + "\n")
	b.WriteString("  serve                    Start daemon (default)" + "\n")
	b.WriteString("  start --profile --dir    Start session" + "\n")
	b.WriteString("    --key KEY              Session key (default: profile name)" + "\n")
	b.WriteString("    --extension FILE       Load extension (can be repeated)" + "\n")
	b.WriteString("  prompt \"text\"             Send prompt" + "\n")
	b.WriteString("  prompt -                 Read prompt text from stdin (also: prompt < file)" + "\n")
	b.WriteString("    --no-extensions        Skip extensions for this prompt" + "\n")
	b.WriteString("    --extension FILE       Load extension (can be repeated)" + "\n")
	b.WriteString("    --attach               Stream output until idle (keyed sessions)" + "\n")
	b.WriteString("    --timeout DURATION      Wall-clock deadline (e.g. 60s, 5m, 2h); exit 124 on timeout" + "\n")
	b.WriteString("  attach                   Stream events (NDJSON)" + "\n")
	b.WriteString("  status                   List sessions" + "\n")
	b.WriteString("  stop --key               Stop session" + "\n")
	b.WriteString("  shutdown                 Stop daemon" + "\n")
	b.WriteString("  health                   Probe daemon liveness (exit 0=ok, 1=down)" + "\n")
	b.WriteString("  record --output          Record session to NDJSON" + "\n")
	b.WriteString("  rpc                      JSON-RPC over stdin/stdout" + "\n")
	b.WriteString("  upgrade                  Upgrade to latest release" + "\n")
	b.WriteString("  auth verify              Verify configured workload identity" + "\n")
	b.WriteString("  mcp <sub>                Manage MCP servers (add|list|remove|login|logout)" + "\n")
	b.WriteString("  install-assets           Install the extension SDK to ~/.ion" + "\n")
	b.WriteString("  plugin install <owner/repo>  Install a plugin" + "\n")
	b.WriteString("  plugin list                  List installed plugins" + "\n")
	b.WriteString("  plugin remove <name>         Remove a plugin" + "\n")
	b.WriteString("  telemetry expand [FILE|-] Expand telemetry frames as JSONL" + "\n")
	b.WriteString("  telemetry forward          Forward telemetry to Loki" + "\n")
	b.WriteString("  version                  Show version (also: --version, -v)" + "\n")
	b.WriteString("  help                     Show this help (also: --help, -h)" + "\n")
	b.WriteString("\n")
	b.WriteString("Options:" + "\n")
	b.WriteString("  --model <model>          Model override" + "\n")
	b.WriteString("  --max-turns N            Max LLM turns (default: 50)" + "\n")
	b.WriteString("  --max-budget USD         Cost ceiling" + "\n")
	b.WriteString("  --output text|json|stream-json" + "\n")
	b.WriteString("  --key KEY                Session key" + "\n")
	if _, err := io.WriteString(w, b.String()); err != nil {
		// Usage text is the only output this path produces; if it cannot be
		// written there is nowhere left to report that, so exit non-zero.
		os.Exit(1)
	}
}
