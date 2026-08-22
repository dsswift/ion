package agents

// UpdateDispatchEntry finds the dispatch entry in the metadata "dispatches"
// array and updates its lifecycle state. `waitingOn` is additive per-dispatch
// context: an empty value removes stale park metadata on revive and terminal
// transitions, while "children" and "shell" preserve exact parked-work reason.
func UpdateDispatchEntry(
	metadata map[string]interface{},
	agentID string,
	status string,
	elapsed float64,
	conversationID string,
	waitingOn ...string,
) {
	dispatches, ok := metadata["dispatches"].([]interface{})
	if !ok {
		return
	}
	for i, d := range dispatches {
		dm, ok := d.(map[string]interface{})
		if !ok || dm["id"] != agentID {
			continue
		}
		dm["status"] = status
		dm["elapsed"] = elapsed
		if len(waitingOn) > 0 && (waitingOn[0] == "children" || waitingOn[0] == "shell") {
			dm["waitingOn"] = waitingOn[0]
		} else {
			delete(dm, "waitingOn")
		}
		if conversationID != "" {
			dm["conversationId"] = conversationID
		}
		dispatches[i] = dm
		return
	}
}
