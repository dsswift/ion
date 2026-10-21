package acpagent

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/dsswift/ion/engine/internal/rpcstdio"
	"github.com/dsswift/ion/engine/internal/utils"
)

// promptTimeout bounds one prompt turn. A run that neither finishes nor
// fails inside it is aborted so the client gets an answer.
const promptTimeout = 2 * time.Hour

func (a *Agent) sessionPrompt(params json.RawMessage) (any, *rpcstdio.RPCError) {
	var req PromptRequest
	if err := json.Unmarshal(params, &req); err != nil {
		return nil, badParams(err)
	}
	s, rpcErr := a.session(req.SessionID)
	if rpcErr != nil {
		return nil, rpcErr
	}
	text, attachments := flattenPrompt(req.Prompt)
	if strings.TrimSpace(text) == "" && len(attachments) == 0 {
		return nil, fmtErr("prompt has no text")
	}
	t := &turn{done: make(chan struct{})}
	s.mu.Lock()
	if s.turn != nil {
		s.mu.Unlock()
		return nil, fmtErr("a prompt is already running in session %s", s.id)
	}
	s.turn = t
	s.mu.Unlock()
	model := s.effectiveModel()

	cmd := s.promptCommand(text, model, attachments)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	_, err := a.engine.Send(ctx, cmd)
	cancel()
	if err != nil {
		s.clearTurn(t)
		return nil, internalError(err)
	}
	utils.LogWithFields(utils.LevelInfo, "acp", "prompt sent", map[string]any{"session_id": s.id, "cmd": cmd["cmd"], "chars": len(text), "attachments": len(attachments)})

	select {
	case <-t.done:
	case <-time.After(promptTimeout):
		s.cancel()
		<-t.done
		if t.err == nil {
			t.err = errors.New("prompt turn timed out")
		}
	}
	if t.err != nil {
		return nil, internalError(t.err)
	}
	return PromptResponse{StopReason: t.reason}, nil
}

// promptCommand picks the engine command for the text: a leading slash that
// names a registered extension command dispatches as `command`, anything
// else as `send_prompt`.
func (s *Session) promptCommand(text, model string, attachments []map[string]any) map[string]any {
	if name, args, ok := s.slashCommand(text); ok {
		return map[string]any{"cmd": "command", "key": s.id, "command": name, "args": args}
	}
	cmd := map[string]any{"cmd": "send_prompt", "key": s.id, "text": text}
	if model != "" {
		cmd["model"] = model
	}
	if len(attachments) > 0 {
		cmd["attachments"] = attachments
	}
	return cmd
}

func (s *Session) slashCommand(text string) (name, args string, ok bool) {
	trimmed := strings.TrimSpace(text)
	if !strings.HasPrefix(trimmed, "/") {
		return "", "", false
	}
	rest := strings.TrimPrefix(trimmed, "/")
	name, args, _ = strings.Cut(rest, " ")
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, c := range s.commands {
		if c.Name == name {
			return name, strings.TrimSpace(args), true
		}
	}
	return "", "", false
}

// flattenPrompt joins the prompt's text blocks and collects image blocks
// as engine attachments. Embedded text resources are appended as fenced
// context so the model sees what the client attached.
func flattenPrompt(blocks []ContentBlock) (string, []map[string]any) {
	var text strings.Builder
	var attachments []map[string]any
	for _, b := range blocks {
		switch b.Type {
		case "text":
			text.WriteString(b.Text)
		case "image":
			if b.Data != "" {
				attachments = append(attachments, map[string]any{"media_type": b.MimeType, "data": b.Data})
			}
		case "resource":
			if b.Resource != nil && b.Resource.Text != "" {
				text.WriteString("\n\n<attached uri=\"" + b.Resource.URI + "\">\n" + b.Resource.Text + "\n</attached>\n")
			}
		case "resource_link":
			if b.URI != "" {
				text.WriteString("\n" + b.URI)
			}
		}
	}
	return text.String(), attachments
}

// finishTurn settles the active prompt, if any, with a stop reason or an
// error. Safe to call when no prompt is running.
func (s *Session) finishTurn(reason string, err error) {
	s.mu.Lock()
	t := s.turn
	s.turn = nil
	s.mu.Unlock()
	if t == nil {
		return
	}
	t.reason = reason
	t.err = err
	close(t.done)
	utils.LogWithFields(utils.LevelInfo, "acp", "prompt turn ended", map[string]any{"session_id": s.id, "stop_reason": reason, "error": utils.ErrStr(err)})
}

func (s *Session) clearTurn(t *turn) {
	s.mu.Lock()
	if s.turn == t {
		s.turn = nil
	}
	s.mu.Unlock()
}
