package agents

// UpdateDispatchEntry finds the dispatch entry in the metadata "dispatches"
// array matching agentID and updates its status, elapsed, and (optionally)
// conversationId. When conversationID is empty, the field is left unchanged.
func UpdateDispatchEntry(metadata map[string]interface{}, agentID string, status string, elapsed float64, conversationID string) {
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
		if conversationID != "" {
			dm["conversationId"] = conversationID
		}
		dispatches[i] = dm
		return
	}
}
