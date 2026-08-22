package extcontext

import "github.com/dsswift/ion/engine/internal/tools"

// AgentStatusGetter adapts the authoritative live dispatch registry snapshot to
// the built-in read-only AgentStatus tool. The adapter keeps tool types out of
// the registry and keeps session internals out of the tools package.
func AgentStatusGetter(registry *DispatchRegistry) tools.AgentStatusGetter {
	return func() []tools.AgentStatusEntry {
		if registry == nil {
			return []tools.AgentStatusEntry{}
		}
		snapshot := registry.Snapshot()
		entries := make([]tools.AgentStatusEntry, len(snapshot))
		for i, dispatch := range snapshot {
			entries[i] = tools.AgentStatusEntry{
				DispatchID:          dispatch.DispatchID,
				Name:                dispatch.Name,
				Status:              dispatch.Status,
				ParentDispatchID:    dispatch.ParentDispatchID,
				Depth:               dispatch.Depth,
				StartedAt:           dispatch.StartedAt.UTC().Format("2006-01-02T15:04:05.999999999Z07:00"),
				ElapsedMs:           dispatch.ElapsedMs,
				ToolCount:           dispatch.ToolCount,
				LastWork:            dispatch.LastWork,
				LastActivityMs:      dispatch.LastActivityMs,
				ChildConversationID: dispatch.ChildConversationID,
				WaitingOn:           mapAgentStatusWaitingOn(dispatch.WaitingOn),
			}
		}
		return entries
	}
}

func mapAgentStatusWaitingOn(waiting *DispatchWaitingOn) *tools.AgentStatusWaitingOn {
	if waiting == nil {
		return nil
	}
	return &tools.AgentStatusWaitingOn{
		TaskIDs:          append([]string(nil), waiting.TaskIDs...),
		ChildDispatchIDs: append([]string(nil), waiting.ChildDispatchIDs...),
	}
}
