package protocol

import "encoding/json"

// hasString checks that raw[field] exists and is a JSON string.
func hasString(raw map[string]json.RawMessage, field string) bool {
	v, ok := raw[field]
	if !ok {
		return false
	}
	var s string
	return json.Unmarshal(v, &s) == nil
}

// hasNonEmptyString checks that raw[field] is a non-empty string.
// Mirrors the TS check `!parsed.field` which is falsy for "" and undefined.
func hasNonEmptyString(raw map[string]json.RawMessage, field string) bool {
	v, ok := raw[field]
	if !ok {
		return false
	}
	var s string
	if err := json.Unmarshal(v, &s); err != nil {
		return false
	}
	return s != ""
}

// hasNumber checks that raw[field] exists and is a JSON number.
func hasNumber(raw map[string]json.RawMessage, field string) bool {
	v, ok := raw[field]
	if !ok {
		return false
	}
	var n float64
	return json.Unmarshal(v, &n) == nil
}

// hasBool checks that raw[field] exists and is a JSON boolean.
func hasBool(raw map[string]json.RawMessage, field string) bool {
	v, ok := raw[field]
	if !ok {
		return false
	}
	var b bool
	return json.Unmarshal(v, &b) == nil
}

// hasTrueBool checks that raw[field] is the JSON literal true.
func hasTrueBool(raw map[string]json.RawMessage, field string) bool {
	v, ok := raw[field]
	if !ok {
		return false
	}
	var b bool
	return json.Unmarshal(v, &b) == nil && b
}

// hasArray checks that raw[field] exists and is a JSON array.
func hasArray(raw map[string]json.RawMessage, field string) bool {
	v, ok := raw[field]
	if !ok {
		return false
	}
	var arr []json.RawMessage
	return json.Unmarshal(v, &arr) == nil
}

// hasObject checks that raw[field] exists and is a JSON object.
func hasField(raw map[string]json.RawMessage, field string) bool {
	_, ok := raw[field]
	return ok
}

func hasObject(raw map[string]json.RawMessage, field string) bool {
	v, ok := raw[field]
	if !ok {
		return false
	}
	var obj map[string]json.RawMessage
	return json.Unmarshal(v, &obj) == nil
}

func validateRaw(cmd string, raw map[string]json.RawMessage) bool {
	switch cmd {
	case "start_session":
		return hasNonEmptyString(raw, "key") && hasObject(raw, "config")
	case "send_prompt":
		return hasNonEmptyString(raw, "key") && hasString(raw, "text")
	case "abort", "stop_session", "settle_session", "resume_session", "get_tree":
		return hasNonEmptyString(raw, "key")
	case "abort_agent":
		return hasNonEmptyString(raw, "key") && hasString(raw, "agentName")
	case "abort_dispatch":
		return hasNonEmptyString(raw, "key") && hasNonEmptyString(raw, "dispatchId")
	case "stop_background_task":
		return hasNonEmptyString(raw, "key") && hasNonEmptyString(raw, "taskId")
	case "steer_agent":
		return hasNonEmptyString(raw, "key") && hasString(raw, "agentName") && hasString(raw, "message")
	case "stop_by_prefix":
		return hasNonEmptyString(raw, "prefix")
	case "dialog_response":
		return hasNonEmptyString(raw, "key") && hasNonEmptyString(raw, "dialogId")
	case "command":
		return hasNonEmptyString(raw, "key") && hasString(raw, "command")
	case "fork_session":
		return hasNonEmptyString(raw, "key") && hasNumber(raw, "messageIndex")
	case "set_plan_mode":
		return hasNonEmptyString(raw, "key") && hasBool(raw, "enabled")
	case "branch":
		return hasNonEmptyString(raw, "key") && hasString(raw, "entryId")
	case "branch_before":
		return hasNonEmptyString(raw, "key") && hasNonEmptyString(raw, "entryId")
	case "rewind_session":
		// Exact entry id takes priority when present; otherwise fall back to
		// the legacy ordinal. At least one of the two addressing modes must
		// be supplied.
		return hasNonEmptyString(raw, "key") && (hasNonEmptyString(raw, "entryId") || hasNumber(raw, "userTurnIndex"))
	case "navigate_tree":
		return hasNonEmptyString(raw, "key") && hasString(raw, "targetId")
	case "permission_response":
		return hasNonEmptyString(raw, "key") && hasNonEmptyString(raw, "questionId") && hasNonEmptyString(raw, "optionId")
	case "list_sessions", "shutdown", "list_stored_sessions", "health":
		return true
	case "get_conversation":
		return hasNonEmptyString(raw, "key")
	case "load_session_history":
		return hasNonEmptyString(raw, "key") || hasArray(raw, "sessionIds")
	case "save_session_label":
		return hasNonEmptyString(raw, "key") && hasString(raw, "label")
	case "generate_title":
		return hasString(raw, "text")
	case "elicitation_response":
		return hasNonEmptyString(raw, "key") && hasNonEmptyString(raw, "elicitRequestId")
	case "early_stop_decision_response":
		return hasNonEmptyString(raw, "key") && hasNonEmptyString(raw, "earlyStopRequestId")
	case "tool_gate_response":
		return hasNonEmptyString(raw, "key") && hasNonEmptyString(raw, "gateRequestId")
	case "reconcile_state", "query_session_status", "get_agent_state", "resolve_permission_denials":
		return hasNonEmptyString(raw, "key")
	case "migrate_conversation":
		return hasNonEmptyString(raw, "key") && hasNonEmptyString(raw, "text") && hasNonEmptyString(raw, "message")
	case "list_models", "list_model_tiers", "oidc_begin_login", "oidc_logout", "oidc_identity", "oidc_token", "refresh_models", "get_host_info", "list_directory", "discover_slash_commands", "delete_stored_sessions", "get_enterprise_policy", "plugin_list", "mcp_list":
		return true
	case "delete_stored_conversations":
		return hasArray(raw, "sessionIds")
	case "resolve_model_tier", "remove_model_tier":
		return hasNonEmptyString(raw, "text")
	case "set_model_tier":
		return hasNonEmptyString(raw, "text") && hasNonEmptyString(raw, "model") && (!hasField(raw, "fallbacks") || hasArray(raw, "fallbacks"))
	case "store_credential":
		return hasNonEmptyString(raw, "provider") && hasString(raw, "credential")
	case "provider_login", "provider_login_cancel", "provider_logout":
		return hasNonEmptyString(raw, "provider")
	case "provider_login_code":
		return hasNonEmptyString(raw, "provider") && hasNonEmptyString(raw, "text")
	case "clear_conversation_file":
		return hasNonEmptyString(raw, "key")
	case "resource_subscribe":
		if hasTrueBool(raw, "resourceGlobal") {
			return hasNonEmptyString(raw, "resourceKind")
		}
		return hasNonEmptyString(raw, "key") && hasNonEmptyString(raw, "resourceKind")
	case "resource_unsubscribe":
		return hasNonEmptyString(raw, "key") && hasNonEmptyString(raw, "resourceSubId")
	case "resource_publish":
		return hasNonEmptyString(raw, "key") && hasNonEmptyString(raw, "resourceOp")
	case "resource_get":
		if !hasNonEmptyString(raw, "resourceKind") || !hasNonEmptyString(raw, "resourceId") {
			return false
		}
		if hasTrueBool(raw, "resourceGlobal") {
			return true
		}
		return hasNonEmptyString(raw, "key")
	case "get_plan_content":
		return hasNonEmptyString(raw, "key") && hasNonEmptyString(raw, "path")
	case "get_context_breakdown":
		return hasNonEmptyString(raw, "key")
	case "plugin_install":
		return hasNonEmptyString(raw, "source")
	case "plugin_remove":
		return hasNonEmptyString(raw, "label")
	case "mcp_add":
		return hasNonEmptyString(raw, "mcpName")
	case "mcp_remove", "mcp_login", "mcp_logout":
		return hasNonEmptyString(raw, "mcpName")
	}
	return false
}
