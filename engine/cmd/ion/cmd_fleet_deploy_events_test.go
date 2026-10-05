package main

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"

	"github.com/dsswift/ion/engine/internal/fleet"
)

// A program reading --events takes one JSON object per line.
func TestLineOut_EmitsEachEventOnOneLine(t *testing.T) {
	var buf bytes.Buffer
	out := &lineOut{w: &buf}
	out.emit(map[string]any{"event": "stage", "host": "a", "stage": "building", "detail": "line one\nline two"})
	out.emit(map[string]any{"event": "log", "hosts": []string{"a", "b"}, "line": "npm ci"})
	lines := strings.Split(strings.TrimRight(buf.String(), "\n"), "\n")
	if len(lines) != 2 {
		t.Fatalf("two events must be two lines, got %d:\n%s", len(lines), buf.String())
	}
	for _, line := range lines {
		var event map[string]any
		if err := json.Unmarshal([]byte(line), &event); err != nil {
			t.Errorf("a line must be a whole JSON object: %q: %v", line, err)
		}
	}
}

// The plan event carries each host and each build as data, with what stops
// the ones that cannot go ahead.
func TestPlanEvent_CarriesTargetsAndBuildsAsData(t *testing.T) {
	win := fleet.Host{Name: "win", Label: "The PC", Entry: &fleet.Entry{EnvironmentID: "env-win"}}
	p := &fleet.Prepared{
		Request: fleet.Request{Source: fleet.SourceDev, Checkout: "/src/ion"},
		Targets: []fleet.Target{
			{Host: fleet.Host{Name: "mac"}, Component: fleet.ComponentServer, GOOS: "darwin", GOARCH: "arm64", Self: true, Source: fleet.SourceDev},
			{Host: win, Component: fleet.ComponentDesktop, GOOS: "windows", GOARCH: "amd64", Source: fleet.SourceDev, Refusal: "nothing can build the Windows desktop for amd64: win lacks go"},
		},
		Builds: []fleet.BuildPlan{
			{Key: "server/darwin/arm64", Component: fleet.ComponentServer, GOOS: "darwin", GOARCH: "arm64", Hosts: []string{"mac"}},
			{Key: "desktop/windows/amd64", Component: fleet.ComponentDesktop, GOOS: "windows", GOARCH: "amd64", Hosts: []string{"win"}, Refusal: "nothing can build the Windows desktop for amd64: win lacks go",
				Candidates: []fleet.BuilderCheck{{Host: "win", EnvironmentID: "env-win", Problems: []fleet.BuildProblem{{Code: fleet.ProblemMissingTools, Tools: []string{"go"}, Fixable: true, Message: "win lacks go"}}}}},
		},
	}
	data, err := json.Marshal(planEvent(p, "run-1", false))
	if err != nil {
		t.Fatal(err)
	}
	var event struct {
		Event   string `json:"event"`
		RunID   string `json:"runId"`
		Blocked bool   `json:"blocked"`
		Targets []struct {
			Host, Label, EnvironmentID, Source, Refusal string
			Self                                        bool
		} `json:"targets"`
		Builds []struct {
			Key, Builder, Refusal string
			Hosts                 []string
			Candidates            []fleet.BuilderCheck
		} `json:"builds"`
	}
	if err := json.Unmarshal(data, &event); err != nil {
		t.Fatal(err)
	}
	if event.Event != "plan" || event.RunID != "run-1" || event.Blocked || len(event.Targets) != 2 || len(event.Builds) != 2 {
		t.Fatalf("event = %s", data)
	}
	if mac := event.Targets[0]; mac.Label != "mac" || !mac.Self || mac.Refusal != "" || mac.Source != "dev" {
		t.Errorf("mac = %+v", mac)
	}
	if got := event.Targets[1]; got.Label != "The PC" || got.EnvironmentID != "env-win" || got.Refusal == "" {
		t.Errorf("win = %+v", got)
	}
	if local := event.Builds[0]; local.Builder != "" || local.Candidates == nil || len(local.Candidates) != 0 {
		t.Errorf("a build made here names no builder and an empty list of candidates: %+v", local)
	}
	if stuck := event.Builds[1]; stuck.Refusal == "" || len(stuck.Candidates) != 1 || stuck.Candidates[0].Problems[0].Code != fleet.ProblemMissingTools || !stuck.Candidates[0].Problems[0].Fixable {
		t.Errorf("stuck = %+v", stuck)
	}
}
