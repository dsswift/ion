package extcontext

import "unicode/utf8"

const dispatchTaskLabelMaxBytes = 256

// dispatchTaskLabel returns the first task line as a bounded UI label. The
// complete task remains in top-level agent metadata and conversation storage;
// dispatches[] is a repeated snapshot index and must not duplicate a large
// prompt once per emission.
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
	return cutTaskLabelUTF8(task, dispatchTaskLabelMaxBytes)
}

func cutTaskLabelUTF8(value string, limit int) string {
	if limit >= len(value) {
		return value
	}
	cut := value[:limit]
	for len(cut) > 0 {
		r, size := utf8.DecodeLastRuneInString(cut)
		if r != utf8.RuneError || size > 1 {
			break
		}
		cut = cut[:len(cut)-1]
	}
	return cut
}
