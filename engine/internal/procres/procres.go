// Package procres reports the engine process's own resource state: how many
// file descriptors it holds, how many it may hold, and whether it can still
// start a subprocess. The engine is one long-lived process, so every run in it
// shares one descriptor table; these primitives let callers observe that table
// and refuse work the process can no longer carry out.
package procres

import (
	"errors"
	"strings"
	"syscall"
)

// Resource kinds reported by ExhaustedResource.
const (
	ResourceFileDescriptors = "file_descriptors"
	ResourceProcesses       = "processes"
	ResourceMemory          = "memory"
)

// Unknown is the value of a Descriptors field the platform cannot report.
const Unknown = -1

// Descriptors is a point-in-time reading of the process's descriptor table.
type Descriptors struct {
	// Open is the number of descriptors the process holds, or Unknown.
	Open int
	// Limit is the number of descriptors the process may hold, or Unknown
	// when the platform imposes no finite limit or cannot report one.
	Limit int64
}

// Delta returns how many descriptors were opened (positive) or closed
// (negative) between an earlier reading and d. The second return is false
// when either reading is Unknown.
func (d Descriptors) Delta(earlier Descriptors) (int, bool) {
	if d.Open == Unknown || earlier.Open == Unknown {
		return 0, false
	}
	return d.Open - earlier.Open, true
}

// Fields adds the reading to a structured log or telemetry attribute map.
// Unknown values are omitted so a consumer never mistakes -1 for a count.
func (d Descriptors) Fields(fields map[string]any) {
	if d.Open != Unknown {
		fields["fd_open"] = d.Open
	}
	if d.Limit != Unknown {
		fields["fd_limit"] = d.Limit
	}
}

// ExhaustedResource reports which process resource err says is exhausted.
// The second return is false when err is not a resource-exhaustion failure.
//
// A failed subprocess start can wrap the errno or flatten it to text, so both
// forms are checked.
func ExhaustedResource(err error) (string, bool) {
	if err == nil {
		return "", false
	}
	switch {
	case errors.Is(err, syscall.EMFILE), errors.Is(err, syscall.ENFILE):
		return ResourceFileDescriptors, true
	case errors.Is(err, syscall.EAGAIN):
		return ResourceProcesses, true
	case errors.Is(err, syscall.ENOMEM):
		return ResourceMemory, true
	}
	msg := err.Error()
	switch {
	case strings.Contains(msg, "too many open files"), strings.Contains(msg, "file table overflow"):
		return ResourceFileDescriptors, true
	case strings.Contains(msg, "resource temporarily unavailable"):
		return ResourceProcesses, true
	case strings.Contains(msg, "cannot allocate memory"):
		return ResourceMemory, true
	}
	return "", false
}
