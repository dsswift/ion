package extension

import (
	"encoding/json"
	"fmt"
	"time"

	"github.com/dsswift/ion/engine/internal/utils"
)

// makeOnChildQuestion returns a DispatchAgentOpts.OnChildQuestion callback that
// blocks until the TS SDK answers via ext/answer_dispatch_question.
//
// When a dispatched child calls AskUserQuestion, the engine-side dispatch
// machinery (dispatch_agent.go) routes the question through the child run's
// ChildElicitFn, which calls this callback. The callback must block until the
// dispatcher (the TS SDK harness) answers, mirroring the ext/elicit
// block-and-resume contract — but it lives entirely on the Host because
// dispatch callbacks fire outside any hook/tool context (background dispatches
// resolve after the parent run has moved on, so the ctxStack is empty).
//
// Flow:
//  1. Generate a unique requestId so a single dispatch can ask multiple
//     sequential questions without channel-key collisions.
//  2. Register a buffered reply channel keyed by dispatchId+":"+requestId.
//  3. Send a dispatch_child_question notification carrying the question, agent
//     name, dispatchId, depth, and requestId.
//  4. Block on the reply channel — or on h.deadCh, which closes when the
//     subprocess dies / the host is disposed. The dead path returns
//     cancelled=true so the child run terminates cleanly instead of leaking
//     the goroutine forever.
//  5. Clean up the channel entry (deferred) and return the reply.
//
// The TS SDK answers via ext/answer_dispatch_question, handled by
// handleAnswerDispatchQuestion below.
func (h *Host) makeOnChildQuestion(agentName string) func(DispatchChildQuestionInfo) (string, bool, error) {
	return func(info DispatchChildQuestionInfo) (string, bool, error) {
		info.Name = agentName
		requestID := fmt.Sprintf("q-%d", time.Now().UnixNano())
		key := info.DispatchID + ":" + requestID

		replyCh := make(chan childQuestionReply, 1)
		h.childQuestions.Store(key, replyCh)
		defer h.childQuestions.Delete(key)

		// requestId is carried so the TS SDK can echo it back on
		// ext/answer_dispatch_question.
		payload := struct {
			Name       string `json:"name"`
			DispatchID string `json:"dispatchId"`
			RequestID  string `json:"requestId"`
			Question   string `json:"question"`
			Depth      int    `json:"depth"`
		}{
			Name:       agentName,
			DispatchID: info.DispatchID,
			RequestID:  requestID,
			Question:   info.Question,
			Depth:      info.Depth,
		}
		data, err := json.Marshal(payload)
		if err != nil {
			utils.LogWithFields(utils.LevelInfo, "extension", "makeonchildquestion: marshal failed", map[string]any{"run_id": info.DispatchID, "error": err})
			return "", true, err
		}

		utils.LogWithFields(utils.LevelInfo, "extension", "dispatch_child_question blocking for answer", map[string]any{"agent_name": agentName, "run_id": info.DispatchID, "count": info.Depth, "run_id_3": requestID, "truncate_str": truncateStr(info.Question, 80)})
		h.sendNotification("dispatch_child_question", data)

		// Block until the dispatcher answers or the subprocess dies. h.deadCh
		// closes on subprocess death / host dispose; the dead path unblocks the
		// child run rather than leaking the goroutine. Both the dead path and a
		// cancelled reply terminate the child run.
		select {
		case reply := <-replyCh:
			utils.LogWithFields(utils.LevelInfo, "extension", "dispatch_child_question answered", map[string]any{"agent_name": agentName, "run_id": info.DispatchID, "run_id_2": requestID, "cancelled": reply.Cancelled, "count": len(reply.Answer)})
			if reply.Cancelled {
				return "", true, nil
			}
			return reply.Answer, false, nil
		case <-h.deadCh:
			utils.LogWithFields(utils.LevelInfo, "extension", "dispatch_child_question: subprocess died before answering ; cancelling", map[string]any{"agent_name": agentName, "run_id": info.DispatchID, "run_id_2": requestID})
			return "", true, nil
		}
	}
}

// handleAnswerDispatchQuestion processes the ext/answer_dispatch_question RPC
// the TS SDK sends to resolve a pending dispatch_child_question. It looks up
// the per-question reply channel by dispatchId+":"+requestId and delivers the
// dispatcher's answer/cancellation. A missing key (already answered or torn
// down) is logged and treated as a no-op so a late answer cannot panic. The
// reply channel is buffered (cap 1) so this never blocks even if the waiting
// goroutine has already unblocked via h.deadCh.
func (h *Host) handleAnswerDispatchQuestion(id int64, raw []byte) {
	var req struct {
		Params struct {
			DispatchID string `json:"dispatchId"`
			RequestID  string `json:"requestId"`
			Answer     string `json:"answer,omitempty"`
			Cancelled  bool   `json:"cancelled,omitempty"`
		} `json:"params"`
	}
	if err := json.Unmarshal(raw, &req); err != nil {
		h.sendResponse(id, nil, &jsonrpcError{Code: -32602, Message: "parse error: " + err.Error()})
		return
	}
	key := req.Params.DispatchID + ":" + req.Params.RequestID
	if ch, ok := h.childQuestions.Load(key); ok {
		ch.(chan childQuestionReply) <- childQuestionReply{ //nolint:errcheck // map only ever stores chan childQuestionReply
			Answer:    req.Params.Answer,
			Cancelled: req.Params.Cancelled,
		}
		utils.LogWithFields(utils.LevelInfo, "extension", "ext/answer_dispatch_question delivered", map[string]any{"key": key, "cancelled": req.Params.Cancelled})
	} else {
		utils.LogWithFields(utils.LevelInfo, "extension", "ext/answer_dispatch_question: no pending question for (already answered or torn down)", map[string]any{"key": key})
	}
	h.sendResponse(id, json.RawMessage(`{"ok":true}`), nil)
}

// truncateStr truncates s to maxLen, appending "..." if truncated.
func truncateStr(s string, maxLen int) string {
	if len(s) <= maxLen {
		return s
	}
	return s[:maxLen] + "..."
}
