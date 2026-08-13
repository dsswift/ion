package session

import "github.com/dsswift/ion/engine/internal/utils"

const dispatchTaskLabelMaxBytes = 256

// dispatchTaskLabel keeps repeated dispatch-index labels bounded. The complete
// task is retained in the durable top-level dispatch record.
func dispatchTaskLabel(task string) string {
	return utils.FirstLineUTF8(task, dispatchTaskLabelMaxBytes)
}
