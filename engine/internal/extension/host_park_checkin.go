package extension

import (
	"encoding/json"
	"fmt"
	"time"

	"github.com/dsswift/ion/engine/internal/utils"
)

// parkCheckInReplyTimeout bounds how long the engine waits for a dispatcher
// to answer one dispatch_park_checkin notification. The parked dispatch
// cannot observe its revive or recall while the answer is outstanding, so an
// extension that never answers must not hold the park.
const parkCheckInReplyTimeout = 30 * time.Second

// makeOnParkCheckIn returns a DispatchAgentOpts.OnParkCheckIn callback that
// asks the dispatching extension what to tell a parked dispatch.
//
// It sends a dispatch_park_checkin notification carrying a requestId and
// blocks until the extension answers through ext/answer_dispatch_park_checkin,
// the subprocess dies, or parkCheckInReplyTimeout elapses. The last two return
// an error, which the park treats as a skip.
func (h *Host) makeOnParkCheckIn(agentName, callbackID string) func(DispatchParkCheckInInfo) (DispatchParkCheckInReply, error) {
	return func(info DispatchParkCheckInInfo) (DispatchParkCheckInReply, error) {
		info.Name = agentName
		info.CallbackID = callbackID
		requestID := fmt.Sprintf("pc-%d", time.Now().UnixNano())
		key := info.DispatchID + ":" + requestID

		replyCh := make(chan DispatchParkCheckInReply, 1)
		h.parkCheckIns.Store(key, replyCh)
		defer h.parkCheckIns.Delete(key)

		payload := struct {
			DispatchParkCheckInInfo
			RequestID string `json:"requestId"`
		}{DispatchParkCheckInInfo: info, RequestID: requestID}
		data, err := json.Marshal(payload)
		if err != nil {
			utils.LogWithFields(utils.LevelError, "extension", "dispatch_park_checkin: marshal failed", map[string]any{"dispatch_id": info.DispatchID, "error": err.Error()})
			return DispatchParkCheckInReply{}, err
		}

		fields := map[string]any{"agent_name": agentName, "dispatch_id": info.DispatchID, "checkin_request_id": requestID, "checkin_count": info.CheckInCount, "parked_ms": info.ParkedMs}
		utils.LogWithFields(utils.LevelInfo, "extension", "dispatch_park_checkin asking dispatcher", fields)
		h.sendNotification("dispatch_park_checkin", data)

		timer := time.NewTimer(parkCheckInReplyTimeout)
		defer timer.Stop()
		select {
		case reply := <-replyCh:
			fields["skip"] = reply.Skip
			fields["count"] = len(reply.Prompt)
			utils.LogWithFields(utils.LevelInfo, "extension", "dispatch_park_checkin answered", fields)
			return reply, nil
		case <-h.deadCh:
			utils.LogWithFields(utils.LevelWarn, "extension", "dispatch_park_checkin: subprocess died before answering", fields)
			return DispatchParkCheckInReply{}, fmt.Errorf("extension died before answering park check-in")
		case <-timer.C:
			fields["timeout"] = parkCheckInReplyTimeout.String()
			utils.LogWithFields(utils.LevelWarn, "extension", "dispatch_park_checkin: no answer before timeout", fields)
			return DispatchParkCheckInReply{}, fmt.Errorf("no park check-in answer within %s", parkCheckInReplyTimeout)
		}
	}
}

// handleAnswerDispatchParkCheckIn processes ext/answer_dispatch_park_checkin.
// A missing key (already answered, timed out, or torn down) is logged and
// answered ok so a late reply is harmless. The reply channel is buffered, so
// this never blocks.
func (h *Host) handleAnswerDispatchParkCheckIn(id int64, raw []byte) {
	var req struct {
		Params struct {
			DispatchID string `json:"dispatchId"`
			RequestID  string `json:"requestId"`
			Prompt     string `json:"prompt,omitempty"`
			Skip       bool   `json:"skip,omitempty"`
		} `json:"params"`
	}
	if err := json.Unmarshal(raw, &req); err != nil {
		h.sendResponse(id, nil, &jsonrpcError{Code: -32602, Message: "parse error: " + err.Error()})
		return
	}
	key := req.Params.DispatchID + ":" + req.Params.RequestID
	if ch, ok := h.parkCheckIns.Load(key); ok {
		ch.(chan DispatchParkCheckInReply) <- DispatchParkCheckInReply{ //nolint:errcheck // map only ever stores chan DispatchParkCheckInReply
			Prompt: req.Params.Prompt,
			Skip:   req.Params.Skip,
		}
		utils.LogWithFields(utils.LevelInfo, "extension", "ext/answer_dispatch_park_checkin delivered", map[string]any{"key": key, "skip": req.Params.Skip})
	} else {
		utils.LogWithFields(utils.LevelInfo, "extension", "ext/answer_dispatch_park_checkin: no pending check-in (already answered, timed out, or torn down)", map[string]any{"key": key})
	}
	h.sendResponse(id, json.RawMessage(`{"ok":true}`), nil)
}
