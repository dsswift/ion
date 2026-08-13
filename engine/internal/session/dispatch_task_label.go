package session

import "unicode/utf8"

const dispatchTaskLabelMaxBytes = 256

// dispatchTaskLabel keeps repeated dispatch-index labels bounded. The complete
// task is retained in the durable top-level dispatch record.
func dispatchTaskLabel(task string) string {
	for i, r := range task {
		if r == '\n' || r == '\r' {
			task = task[:i]
			break
		}
	}
	if len(task) <= dispatchTaskLabelMaxBytes {
		return task
	}
	cut := task[:dispatchTaskLabelMaxBytes]
	for len(cut) > 0 {
		r, size := utf8.DecodeLastRuneInString(cut)
		if r != utf8.RuneError || size > 1 {
			break
		}
		cut = cut[:len(cut)-1]
	}
	return cut
}
