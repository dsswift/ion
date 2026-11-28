package main

import (
	"encoding/json"
	"fmt"
	"os"
	"time"

	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// runReportPrefix starts the line `ion prompt --attach` ends with once the
// engine closed the run: the run's report as one JSON object.
const runReportPrefix = "Run: "

// runCloseGrace is how long the CLI keeps reading after the engine reports
// an error, for the status that closes the run. A run stopped at its budget
// reports the error and then closes, so its cost is still read.
const runCloseGrace = 10 * time.Second

// runReport is what the engine said of a prompt's run when it closed it: the
// model, the cost, the turns, and the usage. A script reads what a run spent
// from it however the run ended, finished, failed, or stopped at its budget.
type runReport struct {
	Model               string  `json:"model,omitempty"`
	CostUsd             float64 `json:"costUsd"`
	Turns               int     `json:"turns"`
	DurationMs          int64   `json:"durationMs"`
	InputTokens         int     `json:"inputTokens"`
	OutputTokens        int     `json:"outputTokens"`
	CacheReadTokens     int     `json:"cacheReadTokens"`
	CacheCreationTokens int     `json:"cacheCreationTokens"`
	Reason              string  `json:"reason,omitempty"`
}

// runWatch follows the statuses of one prompt's run: the model they name, and
// the status that closes the run, which carries its usage.
type runWatch struct {
	model  string
	report *runReport
}

// status reads one engine_status and reports whether the run is over: the
// session is idle with no work pending. An idle session that still holds
// work, such as a run parked on background commands, is not over: the
// engine wakes it when that work is done, and the close of the woken run is
// the prompt's.
func (w *runWatch) status(f *types.StatusFields) (over bool) {
	if f == nil {
		return false
	}
	if f.Model != "" {
		w.model = f.Model
	}
	if f.RunUsage != nil {
		w.report = &runReport{
			CostUsd:             f.RunCostUsd,
			Turns:               f.NumTurns,
			DurationMs:          f.RunUsage.DurationMs,
			InputTokens:         f.RunUsage.InputTokens,
			OutputTokens:        f.RunUsage.OutputTokens,
			CacheReadTokens:     f.RunUsage.CacheReadTokens,
			CacheCreationTokens: f.RunUsage.CacheCreationTokens,
			Reason:              string(f.CompletionReason),
		}
	}
	return f.State == "idle" && !f.HasPendingWork
}

// closed reports whether the status that closes the run was read.
func (w *runWatch) closed() bool { return w.report != nil }

// print writes the run's report as the last line on stderr, once the run was
// closed. A run the CLI never saw closed prints none: no figure is guessed.
func (w *runWatch) print() {
	if w.report == nil {
		return
	}
	r := *w.report
	r.Model = w.model
	data, err := json.Marshal(r)
	if err != nil {
		utils.LogWithFields(utils.LevelWarn, "prompt", "run report not printed", map[string]any{"error": utils.ErrStr(err)})
		return
	}
	fmt.Fprintf(os.Stderr, "%s%s\n", runReportPrefix, data)
}

// awaitRunClose keeps reading the stream after an error, within
// runCloseGrace and the stream's own deadline, until the status that closes
// the run, an idle session, or a dead one.
func awaitRunClose(s *promptStream, key string, w *runWatch) {
	until := time.Now().Add(runCloseGrace)
	if !s.until.IsZero() && s.until.Before(until) {
		until = s.until
	}
	s.conn.SetReadDeadline(until) //nolint:errcheck // best-effort deadline; scanner surfaces a read failure
	for line, ok := s.next(); ok; line, ok = s.next() {
		event, ok := streamEvent(line, key)
		if !ok {
			continue
		}
		switch event.Type {
		case "engine_status":
			if w.status(event.Fields) || w.closed() {
				return
			}
		case "engine_dead":
			return
		}
	}
	utils.LogWithFields(utils.LevelInfo, "prompt", "run not closed after error", map[string]any{"key": key})
}

// streamEvent reads one line of the stream as an event for key.
func streamEvent(line, key string) (types.EngineEvent, bool) {
	var msg struct {
		Key   string             `json:"key"`
		Event *types.EngineEvent `json:"event"`
	}
	if err := json.Unmarshal([]byte(line), &msg); err != nil || msg.Key != key || msg.Event == nil {
		return types.EngineEvent{}, false
	}
	return *msg.Event, true
}
