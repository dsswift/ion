package tools

// RegisterTaskTools registers the task management tools.
// Call this from harness code to opt-in to task management.
// Task tools are not registered by default; they must be explicitly enabled.
func RegisterTaskTools() {
	RegisterTool(TaskCreateTool())
	RegisterTool(TaskListTool())
	RegisterTool(TaskGetTool())
	RegisterTool(TaskStopTool())
}

// UnregisterTaskTools removes task tools from the registry.
func UnregisterTaskTools() {
	UnregisterTool("TaskCreate")
	UnregisterTool("TaskList")
	UnregisterTool("TaskGet")
	UnregisterTool("TaskStop")
}
