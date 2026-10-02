package extension

import (
	"bufio"
	"encoding/json"
	"io"
	"sync"
	"testing"
	"time"
)

// TestMakeOnParkCheckIn_BlocksAndResumes pins the Host-level contract: the
// callback sends a dispatch_park_checkin notification carrying the park's
// details and a requestId, blocks, and returns the reply delivered through
// handleAnswerDispatchParkCheckIn.
func TestMakeOnParkCheckIn_BlocksAndResumes(t *testing.T) {
	h := &Host{}
	h.deadCh = make(chan struct{})
	h.deadOnce = &sync.Once{}

	pr, pw := io.Pipe()
	h.stdin = pw

	gotNotif := make(chan map[string]interface{}, 1)
	go func() {
		scanner := bufio.NewScanner(pr)
		for scanner.Scan() {
			var msg struct {
				Method string                 `json:"method"`
				Params map[string]interface{} `json:"params"`
			}
			if err := json.Unmarshal(scanner.Bytes(), &msg); err != nil {
				continue
			}
			if msg.Method == "dispatch_park_checkin" {
				gotNotif <- msg.Params
			}
		}
	}()

	cb := h.makeOnParkCheckIn("dev-lead", "cb-7")

	type result struct {
		reply DispatchParkCheckInReply
		err   error
	}
	resCh := make(chan result, 1)
	go func() {
		reply, err := cb(DispatchParkCheckInInfo{
			DispatchID:          "d-1",
			Depth:               1,
			ParkedMs:            600000,
			CheckInCount:        2,
			AwaitingDispatchIDs: []string{"d-2"},
		})
		resCh <- result{reply, err}
	}()

	var params map[string]interface{}
	select {
	case params = <-gotNotif:
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for dispatch_park_checkin notification")
	}
	if params["name"] != "dev-lead" || params["callbackId"] != "cb-7" || params["dispatchId"] != "d-1" {
		t.Errorf("notification identity = %v", params)
	}
	if params["parkedMs"] != float64(600000) || params["checkInCount"] != float64(2) {
		t.Errorf("notification park fields = %v", params)
	}
	awaiting, _ := params["awaitingDispatchIds"].([]interface{})
	if len(awaiting) != 1 || awaiting[0] != "d-2" {
		t.Errorf("awaitingDispatchIds = %v, want [d-2]", params["awaitingDispatchIds"])
	}
	requestID, _ := params["requestId"].(string)
	if requestID == "" {
		t.Fatal("notification missing requestId")
	}

	answer, _ := json.Marshal(map[string]interface{}{ //nolint:errcheck // static test payload
		"params": map[string]interface{}{"dispatchId": "d-1", "requestId": requestID, "prompt": "look at d-2"},
	})
	h.handleAnswerDispatchParkCheckIn(1, answer)

	select {
	case res := <-resCh:
		if res.err != nil || res.reply.Prompt != "look at d-2" || res.reply.Skip {
			t.Fatalf("reply = %+v, err = %v", res.reply, res.err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("callback did not resume after the answer")
	}
}

// TestMakeOnParkCheckIn_DeadSubprocessErrors pins that a dead extension
// unblocks the park with an error rather than holding it.
func TestMakeOnParkCheckIn_DeadSubprocessErrors(t *testing.T) {
	h := &Host{}
	h.deadCh = make(chan struct{})
	h.deadOnce = &sync.Once{}
	pr, pw := io.Pipe()
	h.stdin = pw
	go func() { _, _ = io.Copy(io.Discard, pr) }() //nolint:errcheck // drain test pipe
	close(h.deadCh)

	if _, err := h.makeOnParkCheckIn("dev-lead", "")(DispatchParkCheckInInfo{DispatchID: "d-1"}); err == nil {
		t.Fatal("expected an error when the subprocess is dead")
	}
}
