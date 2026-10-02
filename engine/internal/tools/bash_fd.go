package tools

import (
	"github.com/dsswift/ion/engine/internal/procres"
	"github.com/dsswift/ion/engine/internal/utils"
)

// logFdPressure logs the engine process's descriptor count and limit. Called
// before each subprocess spawn so descriptor growth is visible in the log
// before the process reaches its limit.
func logFdPressure() {
	fields := map[string]any{}
	procres.ReadDescriptors().Fields(fields)
	utils.LogWithFields(utils.LevelDebug, "tools.bash", "fd pressure", fields)
}
