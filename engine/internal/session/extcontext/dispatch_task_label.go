package extcontext

import "github.com/dsswift/ion/engine/internal/utils"

const dispatchTaskLabelMaxBytes = 256

// dispatchTaskLabel keeps repeated dispatch-index labels bounded. The complete
// task remains in top-level metadata and conversation storage.
func dispatchTaskLabel(task string) string {
	return utils.FirstLineUTF8(task, dispatchTaskLabelMaxBytes)
}
