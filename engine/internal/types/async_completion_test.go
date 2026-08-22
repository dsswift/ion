package types

import (
	"strings"
	"testing"
)

func TestFormatBackgroundTaskCompletion_BasicOutput(t *testing.T) {
	item := BackgroundWorkItem{
		ID: "bash-1", Source: BackgroundWorkSourceBash, Status: "completed",
		ExitCode: 0, ElapsedMs: 1200, OutputPath: "/tmp/bash-1.out",
	}
	got := FormatBackgroundTaskCompletion(item, "make build", "all good", nil)

	for _, want := range []string{
		"Background command bash-1 (completed).",
		"Command: make build",
		"Exit code: 0",
		"Elapsed: 1200ms",
		"Output file: /tmp/bash-1.out",
		"Recent output:\nall good",
		"No background commands remain outstanding.",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("output missing %q\ngot:\n%s", want, got)
		}
	}
}

func TestFormatBackgroundTaskCompletion_WithRemaining(t *testing.T) {
	item := BackgroundWorkItem{ID: "bash-1", Status: "completed"}
	remaining := []BackgroundWorkItem{
		{ID: "bash-2", Label: "npm test"},
		{ID: "bash-3", Label: "go vet"},
	}
	got := FormatBackgroundTaskCompletion(item, "make build", "", remaining)
	if !strings.Contains(got, "Still running (2):") {
		t.Errorf("missing remaining header; got:\n%s", got)
	}
	if !strings.Contains(got, "- bash-2: npm test") {
		t.Errorf("missing remaining entry; got:\n%s", got)
	}
	if strings.Contains(got, "No background commands remain outstanding") {
		t.Error("should not say no remaining when there are remaining")
	}
}

func TestParseLegacyBackgroundTaskCompletion_RoundTrip(t *testing.T) {
	item := BackgroundWorkItem{
		ID: "bash-42", Source: BackgroundWorkSourceBash, Status: "failed",
		ExitCode: 1, ElapsedMs: 3000, OutputPath: "/tmp/bash-42.out",
	}
	text := FormatBackgroundTaskCompletion(item, "go test ./...", "FAIL", nil)

	info, ok := ParseLegacyBackgroundTaskCompletion(text)
	if !ok {
		t.Fatalf("ParseLegacyBackgroundTaskCompletion returned false for canonical format")
	}
	if info.Kind != string(InjectionKindBackgroundTaskCompletion) {
		t.Errorf("Kind = %q", info.Kind)
	}
	if info.DeliveryMode != "legacy" {
		t.Errorf("DeliveryMode = %q, want legacy", info.DeliveryMode)
	}
	if len(info.Items) != 1 {
		t.Fatalf("Items len = %d, want 1", len(info.Items))
	}
	parsed := info.Items[0]
	if parsed.ID != "bash-42" {
		t.Errorf("ID = %q", parsed.ID)
	}
	if parsed.Status != "failed" {
		t.Errorf("Status = %q", parsed.Status)
	}
	if parsed.ExitCode != 1 {
		t.Errorf("ExitCode = %d", parsed.ExitCode)
	}
	if parsed.ElapsedMs != 3000 {
		t.Errorf("ElapsedMs = %d", parsed.ElapsedMs)
	}
	if parsed.OutputPath != "/tmp/bash-42.out" {
		t.Errorf("OutputPath = %q", parsed.OutputPath)
	}
}

func TestParseCanonicalBashStartResult_Positive(t *testing.T) {
	cases := []struct {
		name    string
		content string
		wantID  string
	}{
		{
			"notify style",
			"Background task started: bash-1-1700000000\nOutput file: /tmp/bash-1.out\nCompletion will be delivered to this session when the command finishes — do not poll for it. You may continue working, start more background commands, or end your turn.",
			"bash-1-1700000000",
		},
		{
			"poll style",
			"Background task started: bash-42-9999\nOutput file: /home/user/.ion/tasks/bash-42.out\nUse TaskGet to poll status and recent output, TaskStop to terminate.",
			"bash-42-9999",
		},
		{
			"read style",
			"Background task started: bg-7\nOutput file: /tmp/bg-7.out\nRead the output file to inspect progress.",
			"bg-7",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			id, ok := ParseCanonicalBashStartResult(tc.content)
			if !ok {
				t.Fatal("expected match")
			}
			if id != tc.wantID {
				t.Errorf("ID = %q, want %q", id, tc.wantID)
			}
		})
	}
}

func TestParseCanonicalBashStartResult_Negative(t *testing.T) {
	cases := []struct {
		name    string
		content string
	}{
		{"empty", ""},
		{"random text", "some command output here"},
		{"no newline", "Background task started: bash-1"},
		{"wrong second line", "Background task started: bash-1\nSome other content"},
		{"prefix only", "Background task started: \nOutput file: /tmp/x"},
		{"completion not start", "Background command bash-1 (completed).\nCommand: make\nExit code: 0\nElapsed: 100ms"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if _, ok := ParseCanonicalBashStartResult(tc.content); ok {
				t.Error("should reject non-canonical input")
			}
		})
	}
}

func TestParseLegacyBackgroundTaskCompletion_RejectsNonCanonical(t *testing.T) {
	cases := []struct {
		name string
		text string
	}{
		{"empty", ""},
		{"random text", "hello world\nfoo bar\nbaz"},
		{"missing prefix", "Some command bash-1 (done).\nCommand: x\nExit code: 0\nElapsed: 10ms"},
		{"missing elapsed suffix", "Background command bash-1 (done).\nCommand: x\nExit code: 0\nElapsed: 10"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if _, ok := ParseLegacyBackgroundTaskCompletion(tc.text); ok {
				t.Error("should reject non-canonical input")
			}
		})
	}
}
