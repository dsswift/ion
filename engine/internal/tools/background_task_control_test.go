package tools

import "testing"

func TestStopBackgroundTaskForOwnerRequiresExactOwner(t *testing.T) {
	tasksMu.Lock()
	original := tasks
	tasks = map[string]*TaskInfo{
		"bash-owner": {ID: "bash-owner", Kind: "bash", Owner: "owner-a", Status: "running"},
	}
	tasksMu.Unlock()
	t.Cleanup(func() {
		tasksMu.Lock()
		tasks = original
		tasksMu.Unlock()
	})

	if got := StopBackgroundTaskForOwner("owner-b", "bash-owner"); got != "ownership_mismatch" {
		t.Fatalf("wrong-owner outcome = %q, want ownership_mismatch", got)
	}
	tasksMu.RLock()
	status := tasks["bash-owner"].Status
	tasksMu.RUnlock()
	if status != "running" {
		t.Fatalf("wrong owner changed task status to %q", status)
	}
}

func TestStopBackgroundTaskForOwnerStopsOnlyTarget(t *testing.T) {
	stopped := 0
	tasksMu.Lock()
	original := tasks
	tasks = map[string]*TaskInfo{
		"bash-one": {ID: "bash-one", Kind: "bash", Owner: "owner", Status: "running", stop: func() { stopped++ }},
		"bash-two": {ID: "bash-two", Kind: "bash", Owner: "owner", Status: "running"},
	}
	tasksMu.Unlock()
	t.Cleanup(func() {
		tasksMu.Lock()
		tasks = original
		tasksMu.Unlock()
	})

	if got := StopBackgroundTaskForOwner("owner", "bash-one"); got != "stopped" {
		t.Fatalf("outcome = %q, want stopped", got)
	}
	if stopped != 1 {
		t.Fatalf("stop calls = %d, want 1", stopped)
	}
	tasksMu.RLock()
	one, two := tasks["bash-one"].Status, tasks["bash-two"].Status
	tasksMu.RUnlock()
	if one != "stopped" || two != "running" {
		t.Fatalf("statuses = (%q, %q), want (stopped, running)", one, two)
	}
}
