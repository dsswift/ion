package extension

import (
	"bufio"
	"encoding/json"
	"io"
	"sync"
	"testing"
	"time"
)

// TestMakeOnChildQuestion_BlocksAndResumes verifies the Host-level
// block-and-resume contract: the OnChildQuestion callback sends a
// dispatch_child_question notification, blocks, and resumes with the answer
// delivered via handleAnswerDispatchQuestion. This mirrors the ext/elicit
// pattern but lives entirely on the Host.
func TestMakeOnChildQuestion_BlocksAndResumes(t *testing.T) {
	h := &Host{}
	h.deadCh = make(chan struct{})
	h.deadOnce = &sync.Once{}

	// Capture the dispatch_child_question notification so we can read the
	// requestId the host generated, then answer it.
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
			if msg.Method == "dispatch_child_question" {
				gotNotif <- msg.Params
				return
			}
		}
	}()

	cb := h.makeOnChildQuestion("researcher", "")

	type result struct {
		answer    string
		cancelled bool
		err       error
	}
	resCh := make(chan result, 1)
	go func() {
		a, c, e := cb(DispatchChildQuestionInfo{
			DispatchID: "d-1",
			Question:   "which endpoint?",
			Depth:      2,
		})
		resCh <- result{a, c, e}
	}()

	// Wait for the notification, extract the requestId, and answer.
	var params map[string]interface{}
	select {
	case params = <-gotNotif:
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for dispatch_child_question notification")
	}
	if params["name"] != "researcher" {
		t.Errorf("notification name = %v, want researcher", params["name"])
	}
	if params["question"] != "which endpoint?" {
		t.Errorf("notification question = %v", params["question"])
	}
	requestID, _ := params["requestId"].(string)
	if requestID == "" {
		t.Fatal("notification missing requestId")
	}

	// Answer via the RPC handler (id is irrelevant; sendResponse writes to the
	// same pipe, which we keep draining below).
	go io.Copy(io.Discard, pr)
	answerRaw, _ := json.Marshal(map[string]interface{}{
		"params": map[string]interface{}{
			"dispatchId": "d-1",
			"requestId":  requestID,
			"answer":     "use staging",
		},
	})
	h.handleAnswerDispatchQuestion(1, answerRaw)

	select {
	case r := <-resCh:
		if r.err != nil {
			t.Fatalf("callback error: %v", r.err)
		}
		if r.cancelled {
			t.Error("expected cancelled=false")
		}
		if r.answer != "use staging" {
			t.Errorf("answer = %q, want %q", r.answer, "use staging")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("callback did not resume after answer")
	}
}

// TestMakeOnChildQuestion_DeadChCancels verifies that if the subprocess dies
// (deadCh closes) before an answer arrives, the callback returns cancelled=true
// so the child run terminates cleanly instead of leaking the goroutine.
func TestMakeOnChildQuestion_DeadChCancels(t *testing.T) {
	h := &Host{}
	h.deadCh = make(chan struct{})
	h.deadOnce = &sync.Once{}

	pr, pw := io.Pipe()
	h.stdin = pw
	go io.Copy(io.Discard, pr)

	cb := h.makeOnChildQuestion("agent", "")

	type result struct {
		cancelled bool
		err       error
	}
	resCh := make(chan result, 1)
	go func() {
		_, c, e := cb(DispatchChildQuestionInfo{DispatchID: "d-2", Question: "q", Depth: 1})
		resCh <- result{c, e}
	}()

	// Let the callback register and block, then kill the subprocess.
	time.Sleep(50 * time.Millisecond)
	close(h.deadCh)

	select {
	case r := <-resCh:
		if r.err != nil {
			t.Fatalf("unexpected error: %v", r.err)
		}
		if !r.cancelled {
			t.Error("expected cancelled=true on subprocess death")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("callback did not unblock on deadCh close")
	}
}

// TestHandleAnswerDispatchQuestion_UnknownKeyNoPanic verifies that answering a
// question that has no pending channel (already answered / torn down) is a
// harmless no-op rather than a panic or block.
func TestHandleAnswerDispatchQuestion_UnknownKeyNoPanic(t *testing.T) {
	h := &Host{}
	pr, pw := io.Pipe()
	h.stdin = pw
	go io.Copy(io.Discard, pr)

	raw, _ := json.Marshal(map[string]interface{}{
		"params": map[string]interface{}{
			"dispatchId": "missing",
			"requestId":  "nope",
			"answer":     "ignored",
		},
	})
	// Should not panic or block.
	done := make(chan struct{})
	go func() {
		h.handleAnswerDispatchQuestion(1, raw)
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("handleAnswerDispatchQuestion blocked on unknown key")
	}
}

func TestHandleAnswerDispatchQuestion_ParseError(t *testing.T) {
	h := &Host{}
	pr, pw := io.Pipe()
	h.stdin = pw
	go func() {
		// Drain and look for an error response.
		_, _ = io.ReadAll(pr)
	}()
	h.handleAnswerDispatchQuestion(1, []byte("not json"))
	// Closing stdin flushes; the test passes if no panic occurred.
	_ = pw.Close()
}
