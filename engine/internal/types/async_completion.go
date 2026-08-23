// Package types — background-work delivery metadata shared by the engine and
// its clients. Background task terminal signals and orchestrator delivery are
// intentionally separate: a task may finish under event_only policy without
// ever becoming an LLM-visible completion input.
package types

import (
	"fmt"
	"strconv"
	"strings"
)

const (
	BackgroundWorkSourceBash  = "bash"
	BackgroundWorkSourceAgent = "agent"
)

// BackgroundWorkItem is one completed unit delivered to an orchestrator.
// Content is deliberately absent: the adjacent conversation entry remains the
// single authoritative copy of exactly what the model received.
type BackgroundWorkItem struct {
	ID         string `json:"id"`
	Source     string `json:"source"`
	Label      string `json:"label,omitempty"`
	Status     string `json:"status"`
	ExitCode   int    `json:"exitCode"`
	ElapsedMs  int64  `json:"elapsedMs,omitempty"`
	OutputPath string `json:"outputPath,omitempty"`
}

// BackgroundWorkInfo identifies a delivered background-work result. Multiple
// items occur when a parked agent resumes after several children settle.
type BackgroundWorkInfo struct {
	Kind             string               `json:"kind"`
	DeliveryMode     string               `json:"deliveryMode"`
	Items            []BackgroundWorkItem `json:"items"`
	RemainingTaskIDs []string             `json:"remainingTaskIds,omitempty"`
}

// BackgroundWorkDeliveredData fires when an engine-owned completion result is
// delivered into a session -- routed into the LLM's context as a user turn.
// It carries structured metadata so clients can render a completion row
// without parsing the injected prompt text.
type BackgroundWorkDeliveredEvent struct {
	EntryID string             `json:"entryId"`
	Content string             `json:"content"`
	Work    BackgroundWorkInfo `json:"work"`
}

type BackgroundWorkDelivery struct {
	Content string             `json:"content"`
	Work    BackgroundWorkInfo `json:"work"`
}

// FormatBackgroundTaskCompletion is the canonical model-facing Bash completion
// payload. Keeping this format in types lets legacy migration recognize only
// data the engine itself produced while new writes rely on structured metadata.
func FormatBackgroundTaskCompletion(item BackgroundWorkItem, command, tail string, remaining []BackgroundWorkItem) string {
	var b strings.Builder
	fmt.Fprintf(&b, "Background command %s (%s).\n", item.ID, item.Status)
	fmt.Fprintf(&b, "Command: %s\n", command)
	fmt.Fprintf(&b, "Exit code: %d\n", item.ExitCode)
	fmt.Fprintf(&b, "Elapsed: %dms\n", item.ElapsedMs)
	if item.OutputPath != "" {
		fmt.Fprintf(&b, "Output file: %s\n", item.OutputPath)
	}
	if tail != "" {
		fmt.Fprintf(&b, "Recent output:\n%s\n", tail)
	}
	if len(remaining) == 0 {
		b.WriteString("\nNo background commands remain outstanding.")
		return b.String()
	}
	fmt.Fprintf(&b, "\nStill running (%d):\n", len(remaining))
	for _, pending := range remaining {
		fmt.Fprintf(&b, "- %s: %s\n", pending.ID, pending.Label)
	}
	return strings.TrimRight(b.String(), "\n")
}

// ParseLegacyBackgroundTaskCompletion recognizes only the complete canonical
// prefix persisted by engines before BackgroundWorkInfo existed. It is migration
// support, not a general parser for user-authored text.
func ParseLegacyBackgroundTaskCompletion(text string) (BackgroundWorkInfo, bool) {
	lines := strings.Split(text, "\n")
	if len(lines) < 4 || !strings.HasPrefix(lines[0], "Background command ") || !strings.HasSuffix(lines[0], ").") || !strings.HasPrefix(lines[1], "Command: ") || !strings.HasPrefix(lines[2], "Exit code: ") || !strings.HasPrefix(lines[3], "Elapsed: ") || !strings.HasSuffix(lines[3], "ms") {
		return BackgroundWorkInfo{}, false
	}
	first := strings.TrimSuffix(strings.TrimPrefix(lines[0], "Background command "), ".")
	cut := strings.LastIndex(first, " (")
	if cut <= 0 {
		return BackgroundWorkInfo{}, false
	}
	exitCode, err := strconv.Atoi(strings.TrimPrefix(lines[2], "Exit code: "))
	if err != nil {
		return BackgroundWorkInfo{}, false
	}
	elapsed, err := strconv.ParseInt(strings.TrimSuffix(strings.TrimPrefix(lines[3], "Elapsed: "), "ms"), 10, 64)
	if err != nil {
		return BackgroundWorkInfo{}, false
	}
	item := BackgroundWorkItem{ID: first[:cut], Source: BackgroundWorkSourceBash, Label: strings.TrimPrefix(lines[1], "Command: "), Status: first[cut+2 : len(first)-1], ExitCode: exitCode, ElapsedMs: elapsed}
	for _, line := range lines[4:] {
		if strings.HasPrefix(line, "Output file: ") {
			item.OutputPath = strings.TrimPrefix(line, "Output file: ")
			break
		}
	}
	return BackgroundWorkInfo{Kind: string(InjectionKindBackgroundTaskCompletion), DeliveryMode: "legacy", Items: []BackgroundWorkItem{item}}, true
}

func (BackgroundWorkDeliveredEvent) eventType() string { return EventBackgroundWorkDelivered }

// ParseCanonicalBashStartResult recovers a background task ID from the exact
// canonical start-result format the Bash tool writes:
//
//	Background task started: <ID>
//	Output file: <path>
//	...
//
// Legacy tool results persisted before BackgroundTaskID existed carry the ID
// only in content. This parser is strict: it matches the engine's own format
// and rejects arbitrary user text.
func ParseCanonicalBashStartResult(content string) (string, bool) {
	const prefix = "Background task started: "
	if !strings.HasPrefix(content, prefix) {
		return "", false
	}
	rest := content[len(prefix):]
	nl := strings.IndexByte(rest, '\n')
	if nl <= 0 {
		return "", false
	}
	id := rest[:nl]
	if !strings.HasPrefix(rest[nl+1:], "Output file: ") {
		return "", false
	}
	return id, true
}
