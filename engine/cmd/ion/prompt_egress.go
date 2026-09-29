package main

import (
	"os"

	"github.com/dsswift/ion/engine/internal/config"
	"github.com/dsswift/ion/engine/internal/utils"
)

// promptEgressActive reports whether this ion prompt process ships its own
// log lines; exitPrompt drains them before the process ends.
var promptEgressActive bool

// startPromptEgress ships this process's own log lines when it started the
// engine itself: the headless case, where ion prompt is the whole job (a
// container, a CI runner) and its lines are the job's outcome. Against an
// already-running engine it ships nothing, as before; that engine's owner
// already ships. Runs after the engine is spawned, because a machine identity
// consumes its secret environment variable and the engine must inherit it
// first. Uses its own spool file so it never shares one with the engine.
func startPromptEgress(spawned *os.Process) {
	if spawned == nil {
		return
	}
	utils.SetEgressSpoolName(".prompt-egress-spool.jsonl")
	cfg := config.LoadConfig("")
	if utils.ActiveEgressForwarder() == nil {
		return
	}
	installEgressAuth(cfg)
	promptEgressActive = true
	utils.LogWithFields(utils.LevelInfo, "prompt", "prompt log egress started", map[string]any{"engine_pid": spawned.Pid})
}

// exitPrompt ends the ion prompt process, draining its log egress first when
// startPromptEgress enabled it.
func exitPrompt(code int) {
	drainPromptEgress()
	os.Exit(code)
}

// drainPromptEgress ships this process's remaining log lines. cmdPrompt defers
// it for its normal returns; exitPrompt calls it for every exit.
func drainPromptEgress() {
	if promptEgressActive {
		promptEgressActive = false
		utils.ShutdownLogEgress(logEgressShutdownTimeout)
	}
}
