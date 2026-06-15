package main

import (
	"fmt"
	"os"
)

var version = "dev"

func main() {
	command, flags, listFlags, positional := parseArgs()

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
	case "version":
		fmt.Printf("ion-engine %s\n", version)
	default:
		printUsage()
	}
}

func printUsage() {
	fmt.Fprintln(os.Stderr, "Ion Engine - Headless AI agent runtime")
	fmt.Fprintln(os.Stderr, "")
	fmt.Fprintln(os.Stderr, "Usage: ion [command] [options]")
	fmt.Fprintln(os.Stderr, "")
	fmt.Fprintln(os.Stderr, "Commands:")
	fmt.Fprintln(os.Stderr, "  serve                    Start daemon (default)")
	fmt.Fprintln(os.Stderr, "  start --profile --dir    Start session")
	fmt.Fprintln(os.Stderr, "    --key KEY              Session key (default: profile name)")
	fmt.Fprintln(os.Stderr, "    --extension FILE       Load extension (can be repeated)")
	fmt.Fprintln(os.Stderr, "  prompt \"text\"             Send prompt")
	fmt.Fprintln(os.Stderr, "    --no-extensions        Skip extensions for this prompt")
	fmt.Fprintln(os.Stderr, "    --extension FILE       Load extension (can be repeated)")
	fmt.Fprintln(os.Stderr, "    --attach               Stream output until idle (keyed sessions)")
	fmt.Fprintln(os.Stderr, "    --timeout DURATION      Wall-clock deadline (e.g. 60s, 5m, 2h); exit 124 on timeout")
	fmt.Fprintln(os.Stderr, "  attach                   Stream events (NDJSON)")
	fmt.Fprintln(os.Stderr, "  status                   List sessions")
	fmt.Fprintln(os.Stderr, "  stop --key               Stop session")
	fmt.Fprintln(os.Stderr, "  shutdown                 Stop daemon")
	fmt.Fprintln(os.Stderr, "  health                   Probe daemon liveness (exit 0=ok, 1=down)")
	fmt.Fprintln(os.Stderr, "  record --output          Record session to NDJSON")
	fmt.Fprintln(os.Stderr, "  rpc                      JSON-RPC over stdin/stdout")
	fmt.Fprintln(os.Stderr, "  upgrade                  Upgrade to latest release")
	fmt.Fprintln(os.Stderr, "  version                  Show version")
	fmt.Fprintln(os.Stderr, "")
	fmt.Fprintln(os.Stderr, "Options:")
	fmt.Fprintln(os.Stderr, "  --model <model>          Model override")
	fmt.Fprintln(os.Stderr, "  --max-turns N            Max LLM turns (default: 50)")
	fmt.Fprintln(os.Stderr, "  --max-budget USD         Cost ceiling")
	fmt.Fprintln(os.Stderr, "  --output text|json|stream-json")
	fmt.Fprintln(os.Stderr, "  --key KEY                Session key")
	os.Exit(1)
}
