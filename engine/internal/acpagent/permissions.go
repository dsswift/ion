package acpagent

import (
	"context"
	"encoding/json"
	"strings"
	"time"

	"github.com/dsswift/ion/engine/internal/utils"
)

// clientAnswerTimeout bounds how long one approval or form waits on the
// client. The engine's own gate keeps the tool call blocked meanwhile, so a
// client that never answers must not pin the run forever.
const clientAnswerTimeout = 30 * time.Minute

// permissionRequest forwards an engine "ask" decision to the client as
// session/request_permission and relays the chosen option back. The client
// answers by its own permission mode (T3 Code approves automatically in
// its Auto modes), which is why the engine needs no per-session mode.
func (s *Session) permissionRequest(e map[string]any) {
	questionID := str(e, "questionId")
	toolName := str(e, "permToolName")
	options := permissionOptions(e)
	req := RequestPermissionRequest{
		SessionID: s.id,
		ToolCall:  ToolCallRef{ToolCallID: questionID, Title: toolName, Kind: toolKind(toolName)},
		Options:   options,
	}
	if input, ok := e["permToolInput"].(map[string]any); ok && len(input) > 0 {
		if raw, err := json.Marshal(input); err == nil {
			req.ToolCall.RawInput = raw
		}
		desc := describeTool(bareToolName(toolName), s.cwd, input)
		req.ToolCall.Title = desc.title
		req.ToolCall.Locations = desc.locations
		req.ToolCall.Content = desc.content
	}
	ctx, cancel := context.WithTimeout(context.Background(), clientAnswerTimeout)
	defer cancel()
	raw, err := s.agent.rpc.Request(ctx, ReqRequestPermission, req)
	var optionID string
	if err != nil {
		utils.LogWithFields(utils.LevelWarn, "acp", "permission request failed; denying", map[string]any{"session_id": s.id, "question_id": questionID, "error": err.Error()})
		optionID = denyOption(options)
	} else {
		var res RequestPermissionResponse
		if err := json.Unmarshal(raw, &res); err != nil {
			utils.LogWithFields(utils.LevelWarn, "acp", "permission response unreadable; denying", map[string]any{"session_id": s.id, "question_id": questionID, "error": err.Error()})
		}
		switch res.Outcome.Outcome {
		case "selected":
			optionID = res.Outcome.OptionID
		default:
			optionID = denyOption(options)
		}
	}
	utils.LogWithFields(utils.LevelInfo, "acp", "permission answered", map[string]any{"session_id": s.id, "question_id": questionID, "option_id": optionID, "tool": toolName})
	if _, err := s.agent.engine.Send(context.Background(), map[string]any{"cmd": "permission_response", "key": s.id, "questionId": questionID, "optionId": optionID}); err != nil {
		utils.LogWithFields(utils.LevelWarn, "acp", "permission_response not sent", map[string]any{"session_id": s.id, "error": err.Error()})
	}
}

// permissionOptions converts the engine's options to ACP's, classifying
// each by its kind when the engine set one and by its wording otherwise.
func permissionOptions(e map[string]any) []PermissionOption {
	var out []PermissionOption
	if raw, ok := e["permOptions"].([]any); ok {
		for _, item := range raw {
			m, ok := item.(map[string]any)
			if !ok {
				continue
			}
			id, label := str(m, "id"), str(m, "label")
			if label == "" {
				label = id
			}
			out = append(out, PermissionOption{OptionID: id, Name: label, Kind: permissionKind(str(m, "kind"), id, label)})
		}
	}
	if len(out) == 0 {
		out = []PermissionOption{
			{OptionID: "allow", Name: "Allow", Kind: "allow_once"},
			{OptionID: "deny", Name: "Deny", Kind: "reject_once"},
		}
	}
	return out
}

func permissionKind(kind, id, label string) string {
	switch kind {
	case "allow_once", "allow_always", "reject_once", "reject_always":
		return kind
	}
	text := strings.ToLower(id + " " + label)
	allow := strings.Contains(text, "allow") || strings.Contains(text, "yes") || strings.Contains(text, "approve") || strings.Contains(text, "accept")
	always := strings.Contains(text, "always") || strings.Contains(text, "session") || strings.Contains(text, "don't ask")
	switch {
	case allow && always:
		return "allow_always"
	case allow:
		return "allow_once"
	case always:
		return "reject_always"
	default:
		return "reject_once"
	}
}

func denyOption(options []PermissionOption) string {
	for _, o := range options {
		if o.Kind == "reject_once" {
			return o.OptionID
		}
	}
	for _, o := range options {
		if o.Kind == "reject_always" {
			return o.OptionID
		}
	}
	if len(options) > 0 {
		return options[len(options)-1].OptionID
	}
	return "deny"
}

// elicitationRequest forwards an extension's elicitation (ion.elicit) as a
// form the client renders. A client without form elicitation gets a
// notice and the extension sees a cancelled request.
func (s *Session) elicitationRequest(e map[string]any) {
	requestID := str(e, "requestId")
	message := str(e, "elicitMessage")
	if message == "" {
		message = "The agent needs your input."
	}
	schema, _ := e["schema"].(map[string]any) //nolint:errcheck // a url-mode request has none
	if url := str(e, "url"); url != "" && schema == nil {
		s.notice("info", message+" Open: "+url)
		s.sendElicitation(requestID, nil, true, false)
		return
	}
	answer, ok := s.askForm(message, schema)
	if !ok {
		s.sendElicitation(requestID, nil, true, false)
		return
	}
	switch answer.Action {
	case "accept":
		s.sendElicitation(requestID, answer.Content, false, false)
	case "decline":
		s.sendElicitation(requestID, nil, false, true)
	default:
		s.sendElicitation(requestID, nil, true, false)
	}
}

func (s *Session) sendElicitation(requestID string, response map[string]any, cancelled, declined bool) {
	cmd := map[string]any{"cmd": "elicitation_response", "key": s.id, "elicitRequestId": requestID}
	if response != nil {
		cmd["elicitResponse"] = response
	}
	if cancelled {
		cmd["elicitCancelled"] = true
	}
	if declined {
		cmd["elicitDeclined"] = true
	}
	utils.LogWithFields(utils.LevelInfo, "acp", "elicitation answered", map[string]any{"session_id": s.id, "request_id": requestID, "cancelled": cancelled, "declined": declined})
	if _, err := s.agent.engine.Send(context.Background(), cmd); err != nil {
		utils.LogWithFields(utils.LevelWarn, "acp", "elicitation_response not sent", map[string]any{"session_id": s.id, "error": err.Error()})
	}
}

// dialogRequest forwards an extension dialog (a text prompt or a select)
// as a one-field form.
func (s *Session) dialogRequest(e map[string]any) {
	dialogID := str(e, "dialogId")
	title := str(e, "title")
	field := map[string]any{"type": "string", "title": title}
	if def := str(e, "defaultValue"); def != "" {
		field["default"] = def
	}
	if str(e, "method") == "select" {
		if raw, ok := e["options"].([]any); ok && len(raw) > 0 {
			field["enum"] = raw
		}
	}
	schema := map[string]any{"type": "object", "properties": map[string]any{"value": field}, "required": []string{"value"}}
	answer, ok := s.askForm(title, schema)
	value := any(nil)
	if ok && answer.Action == "accept" {
		value = answer.Content["value"]
	}
	utils.LogWithFields(utils.LevelInfo, "acp", "dialog answered", map[string]any{"session_id": s.id, "dialog_id": dialogID, "answered": value != nil})
	if _, err := s.agent.engine.Send(context.Background(), map[string]any{"cmd": "dialog_response", "key": s.id, "dialogId": dialogID, "value": value}); err != nil {
		utils.LogWithFields(utils.LevelWarn, "acp", "dialog_response not sent", map[string]any{"session_id": s.id, "error": err.Error()})
	}
}

// askForm sends elicitation/create in form mode and returns the client's
// answer. ok is false when the client cannot render forms or did not
// answer.
func (s *Session) askForm(message string, schema map[string]any) (ElicitationCreateResponse, bool) {
	if !s.agent.clientSupportsForms() {
		s.notice("warning", "This client cannot show the form the agent asked for: "+message)
		utils.LogWithFields(utils.LevelWarn, "acp", "form elicitation unsupported by client", map[string]any{"session_id": s.id})
		return ElicitationCreateResponse{}, false
	}
	if schema == nil {
		schema = map[string]any{"type": "object", "properties": map[string]any{}}
	}
	ctx, cancel := context.WithTimeout(context.Background(), clientAnswerTimeout)
	defer cancel()
	raw, err := s.agent.rpc.Request(ctx, ReqElicitationCreate, ElicitationCreateRequest{Mode: "form", Message: message, SessionID: s.id, RequestedSchema: schema})
	if err != nil {
		utils.LogWithFields(utils.LevelWarn, "acp", "elicitation request failed", map[string]any{"session_id": s.id, "error": err.Error()})
		return ElicitationCreateResponse{}, false
	}
	var res ElicitationCreateResponse
	if err := json.Unmarshal(raw, &res); err != nil {
		utils.LogWithFields(utils.LevelWarn, "acp", "elicitation response unreadable", map[string]any{"session_id": s.id, "error": err.Error()})
		return ElicitationCreateResponse{}, false
	}
	return res, true
}
