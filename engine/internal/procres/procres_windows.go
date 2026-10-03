//go:build windows

package procres

import "context"

// ReadDescriptors reports Unknown: Windows has no per-process descriptor
// table with a countable limit.
func ReadDescriptors() Descriptors { return Descriptors{Open: Unknown, Limit: Unknown} }

// ProbeSpawn is a no-op: the descriptor exhaustion it detects does not occur
// on Windows.
func ProbeSpawn(context.Context) error { return nil }
