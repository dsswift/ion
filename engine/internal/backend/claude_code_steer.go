package backend

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// Mid-turn steering for the Claude CLI.
//
// A steer reaches a running CLI as one more stream-json user message on its
// stdin. The CLI reads it at its next turn boundary, not when it is written, so
// the write alone says nothing about where in the turn the steer took effect.
// The CLI is started with --replay-user-messages, which makes it echo every
// stdin user message back on stdout, flagged isReplay, at the moment it
// consumes it. That echo is the confirmation: it lands in the stream exactly
// between the output the model produced before seeing the steer and the output
// it produced after.
//
// Each steer written here is queued on its run. When the matching echo
// arrives, the steer is dequeued and announced with SteerInjectedEvent, which
// carries the text so the session layer can record the steer at that point in
// the turn it persists at run exit. The opening prompt and a forwarded
// /compact are also stdin user messages and are echoed too; neither is queued
// here, so neither is announced.

// ErrStdinSteerUnsupported is returned by a backend whose run has no stdin
// steering channel of its own. The caller falls back to WriteToStdin.
var ErrStdinSteerUnsupported = errors.New("run does not support stdin steering")

// pendingStdinSteer is one steer written to a run's stdin and not yet echoed
// back by the CLI.
type pendingStdinSteer struct {
	text string
	// kind is a types.InjectionKind wire value. Empty for a client steer.
	kind string
	// clientMessageID is the client's correlation id, echoed on the
	// confirming SteerInjectedEvent so the client can resolve its own row.
	clientMessageID string
}

// SteerViaStdin writes a main-loop steer to the run's CLI and queues it for
// confirmation. The write and the enqueue happen under one lock, so the queue
// order is the pipe order, which is the order the CLI echoes them in.
func (b *ClaudeCodeBackend) SteerViaStdin(requestID, message, kind, clientMessageID string) error {
	b.mu.Lock()
	run, ok := b.activeRuns[requestID]
	b.mu.Unlock()
	if !ok {
		return fmt.Errorf("run %q not found", requestID)
	}
	data, err := json.Marshal(stdinUserTextMessage(message))
	if err != nil {
		return fmt.Errorf("failed to marshal steer message: %w", err)
	}

	run.stdinMu.Lock()
	defer run.stdinMu.Unlock()
	if run.stdinPipe == nil {
		return fmt.Errorf("stdin pipe closed for run %q", requestID)
	}
	if _, err := run.stdinPipe.Write(append(data, '\n')); err != nil {
		return fmt.Errorf("failed to write steer to stdin: %w", err)
	}
	run.pendingSteers = append(run.pendingSteers, pendingStdinSteer{
		text: message, kind: kind, clientMessageID: clientMessageID,
	})
	utils.LogWithFields(utils.LevelInfo, "backend.claude_code", "steer written to stdin, awaiting cli echo", map[string]any{
		"request_id":        requestID,
		"count":             len(message),
		"kind":              kind,
		"client_message_id": clientMessageID,
		"pending":           len(run.pendingSteers),
	})
	return nil
}

// stdinUserTextMessage is the stream-json shape of one plain-text user message.
func stdinUserTextMessage(text string) map[string]any {
	return map[string]any{
		"type": "user",
		"message": map[string]any{
			"role":    "user",
			"content": []map[string]any{{"type": "text", "text": text}},
		},
	}
}

// replayedUserText returns the text of a stdout line when it is the CLI's
// echo of a stdin user message, and false for every other line.
func replayedUserText(raw json.RawMessage) (string, bool) {
	var line struct {
		Type     string `json:"type"`
		IsReplay bool   `json:"isReplay"`
		Message  struct {
			Content json.RawMessage `json:"content"`
		} `json:"message"`
	}
	if err := json.Unmarshal(raw, &line); err != nil || line.Type != "user" || !line.IsReplay {
		return "", false
	}
	content := line.Message.Content
	if len(content) == 0 {
		return "", true
	}
	var s string
	if json.Unmarshal(content, &s) == nil {
		return s, true
	}
	var blocks []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	if err := json.Unmarshal(content, &blocks); err != nil {
		utils.LogWithFields(utils.LevelWarn, "backend.claude_code", "replayed user message content unreadable", map[string]any{
			"error": err.Error(),
		})
		return "", true
	}
	var parts []string
	for _, block := range blocks {
		if block.Type == "text" {
			parts = append(parts, block.Text)
		}
	}
	return strings.Join(parts, ""), true
}

// acknowledgeReplay handles one stdout line. When it is the echo of the oldest
// queued steer, the steer is dequeued and announced. Returns whether the line
// was a replay at all, so the caller can skip normalizing it.
func (b *ClaudeCodeBackend) acknowledgeReplay(run *claudeCodeRun, raw json.RawMessage) bool {
	text, isReplay := replayedUserText(raw)
	if !isReplay {
		return false
	}
	run.stdinMu.Lock()
	var steer pendingStdinSteer
	matched := len(run.pendingSteers) > 0 && run.pendingSteers[0].text == text
	if matched {
		steer = run.pendingSteers[0]
		run.pendingSteers = run.pendingSteers[1:]
	}
	remaining := len(run.pendingSteers)
	run.stdinMu.Unlock()

	if !matched {
		// The opening prompt or a forwarded /compact: echoed, never queued.
		utils.LogWithFields(utils.LevelDebug, "backend.claude_code", "cli echoed a user message that is not a pending steer", map[string]any{
			"request_id": run.requestID,
			"count":      len(text),
			"pending":    remaining,
		})
		return true
	}

	machine := types.InjectionKind(steer.kind).IsMachineToMachine()
	// A machine steer must never resolve a client's row, even if a caller
	// supplied an id alongside a kind. Same rule as the API run loop.
	clientID := ""
	if steer.kind == "" {
		clientID = steer.clientMessageID
	}
	utils.LogWithFields(utils.LevelInfo, "backend.claude_code", "cli consumed steer", map[string]any{
		"request_id":        run.requestID,
		"count":             len(steer.text),
		"kind":              steer.kind,
		"client_message_id": clientID,
		"pending":           remaining,
	})
	b.emit(run.requestID, types.NormalizedEvent{Data: &types.SteerInjectedEvent{
		MessageLength:   len(steer.text),
		ClientMessageID: clientID,
		Kind:            steer.kind,
		MachineAuthored: machine,
		Text:            steer.text,
	}})
	return true
}

// logUnconsumedSteers reports steers the CLI exited without echoing. The CLI
// never saw them, so they reached neither the model nor the transcript.
func logUnconsumedSteers(run *claudeCodeRun) {
	run.stdinMu.Lock()
	pending := run.pendingSteers
	run.pendingSteers = nil
	run.stdinMu.Unlock()
	if len(pending) == 0 {
		utils.LogWithFields(utils.LevelDebug, "backend.claude_code", "no unconsumed steers at exit", map[string]any{
			"request_id": run.requestID,
		})
		return
	}
	for _, steer := range pending {
		utils.LogWithFields(utils.LevelWarn, "backend.claude_code", "cli exited without consuming steer", map[string]any{
			"request_id":        run.requestID,
			"count":             len(steer.text),
			"kind":              steer.kind,
			"client_message_id": steer.clientMessageID,
		})
	}
}
