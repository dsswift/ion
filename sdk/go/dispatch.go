// dispatch.go — the inbound request router.
//
// Five families arrive from the engine:
//
//	init                     the handshake; answers with the registration set
//	hook/<name>              a hook firing
//	tool/<name>              a tool invocation
//	command/<name>           a slash-command invocation
//	engine/fire_async        a webhook or schedule firing
//	engine/resolve_token     resolve a lazily-supplied auth token
//	engine/resolve_predicate resolve a schedule's enabled() predicate
//	resource/query           a client subscribed; return the snapshot
//
// Each runs on its own goroutine (see transport.serve), so a handler may call
// back into the engine while the read loop keeps working.
package ion

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
)

// Inbound method names and prefixes.
const (
	methodInit             = "init"
	prefixHook             = "hook/"
	prefixTool             = "tool/"
	prefixCommand          = "command/"
	methodFireAsync        = "engine/fire_async"
	methodResolveToken     = "engine/resolve_token"
	methodResolvePredicate = "engine/resolve_predicate"
	methodResourceQuery    = "resource/query"
)

// dispatch routes one inbound frame. id is nil for a notification.
func (s *SDK) dispatch(id *int64, method string, params json.RawMessage) {
	// A handler panic must not take down the extension: the engine would see
	// the pipe close and report a crash, losing the actual stack. Convert it
	// to an error response plus a log line.
	defer func() {
		if r := recover(); r != nil {
			s.logger.Error("panic in inbound handler", map[string]any{
				"method": method,
				"panic":  fmt.Sprint(r),
			})
			if id != nil {
				s.transport.respondError(*id, CodeInternalError, fmt.Sprintf("handler panic: %v", r))
			}
		}
	}()

	c := context.Background()

	switch {
	case method == methodInit:
		s.handleInit(id, params)
	case strings.HasPrefix(method, prefixHook):
		s.handleHook(id, strings.TrimPrefix(method, prefixHook), params)
	case strings.HasPrefix(method, prefixTool):
		s.handleTool(c, id, strings.TrimPrefix(method, prefixTool), params)
	case strings.HasPrefix(method, prefixCommand):
		s.handleCommand(c, id, strings.TrimPrefix(method, prefixCommand), params)
	case method == methodFireAsync:
		s.async.handleFireAsync(c, id, params)
	case method == methodResolveToken:
		s.async.handleResolveToken(c, id, params)
	case method == methodResolvePredicate:
		s.async.handleResolvePredicate(c, id, params)
	case method == methodResourceQuery:
		s.resources.handleQuery(c, id, params)
	default:
		// Not one of the engine's request methods. A notification with no id
		// may still be a dispatch lifecycle callback, which the router
		// delivers to whichever DispatchAgent call registered for it.
		if id == nil && s.notifications().route(method, params) {
			return
		}
		s.logger.Debug("unknown inbound method", map[string]any{"method": method})
		if id != nil {
			s.transport.respondError(*id, CodeMethodNotFound, "method not found: "+method)
		}
	}
}

// initResult is the handshake response. Field names are pinned by the engine's
// parseInitResult and by the contract manifest's initResult section.
type initResult struct {
	Name      string                 `json:"name,omitempty"`
	Tools     []wireToolDecl         `json:"tools"`
	Commands  map[string]wireCommand `json:"commands"`
	Webhooks  []WebhookRoute         `json:"webhooks,omitempty"`
	Schedules []ScheduleJob          `json:"schedules,omitempty"`
	Resources []ResourceDeclaration  `json:"resources,omitempty"`
}

// wireToolDecl is a tool as the engine reads it at init. Execute stays local.
type wireToolDecl struct {
	Name         string         `json:"name"`
	Description  string         `json:"description"`
	Parameters   map[string]any `json:"parameters"`
	PlanModeSafe bool           `json:"planModeSafe,omitempty"`
}

// wireCommand is a command as the engine reads it at init.
type wireCommand struct {
	Description string `json:"description"`
}

// handleInit answers the handshake. Everything registered up to this point
// rides the response; after it returns, registrations go out as their own
// ext/register_* calls.
func (s *SDK) handleInit(id *int64, params json.RawMessage) {
	var cfg ExtensionConfig
	if len(params) > 0 {
		if err := json.Unmarshal(params, &cfg); err != nil {
			s.logger.Warn("init params did not decode as ExtensionConfig; continuing with defaults",
				map[string]any{"error": err.Error()})
		}
	}
	s.cfgMu.Lock()
	s.cfg = cfg
	s.cfgMu.Unlock()

	s.mu.RLock()
	tools := make([]wireToolDecl, 0, len(s.tools))
	for _, t := range s.tools {
		tools = append(tools, wireToolDecl{
			Name:         t.Name,
			Description:  t.Description,
			Parameters:   t.Parameters,
			PlanModeSafe: t.PlanModeSafe,
		})
	}
	commands := make(map[string]wireCommand, len(s.commands))
	for name, def := range s.commands {
		commands[name] = wireCommand{Description: def.Description}
	}
	hookCount := len(s.hooks)
	s.mu.RUnlock()

	// Sort so the handshake is deterministic — a respawn produces the same
	// payload, which makes engine-side logs diffable.
	sortToolDecls(tools)

	webhooks, schedules := s.async.drainPendingInit()
	resources := s.resources.drainPendingInit()

	// Flip to post-init routing before responding: the engine may fire the
	// veto-capable *_registered hooks the moment it reads this frame, and a
	// handler that registers something in response must take the RPC path.
	s.markInitDone()

	result := initResult{
		Name:      s.name,
		Tools:     tools,
		Commands:  commands,
		Webhooks:  webhooks,
		Schedules: schedules,
		Resources: resources,
	}

	if id != nil {
		s.transport.respond(*id, result)
	}

	s.logger.Info("extension initialized", map[string]any{
		"name":      s.name,
		"tools":     len(tools),
		"commands":  len(commands),
		"hooks":     hookCount,
		"webhooks":  len(webhooks),
		"schedules": len(schedules),
		"resources": len(resources),
	})
}

// handleHook invokes a hook handler and answers with its result, folding in
// any events the handler emitted.
func (s *SDK) handleHook(id *int64, hook string, params json.RawMessage) {
	s.mu.RLock()
	entry, ok := s.hooks[hook]
	s.mu.RUnlock()
	if !ok {
		// Not an error: the engine fires every hook at every extension and
		// most extensions handle a handful. A null result means "no opinion".
		if id != nil {
			s.transport.respond(*id, nil)
		}
		return
	}

	meta, payload := splitEnvelope(params)
	ctx := s.newContext(meta)
	// A hook response is the only one with an events array, so this is the
	// only invocation kind that batches. Everywhere else a Context emits
	// immediately.
	ctx.openEventBatch()
	// Close the batch on every exit path, including the error returns below,
	// flushing anything buffered as individual notifications. The success path
	// closes it earlier (atomically with the drain — see sealAndTakeEvents);
	// closing twice is harmless and idempotent.
	defer ctx.sealEvents()

	result, err := entry.handler(ctx, payload)
	if err != nil {
		// A hook handler error is surfaced both ways: as the RPC error the
		// engine records against this firing, and as a log line, because the
		// engine's own record of a hook error is terse.
		s.logger.Error("hook handler failed", map[string]any{"hook": hook, "error": err.Error()})
		if id != nil {
			s.transport.respondError(*id, CodeHandlerError, err.Error())
		}
		return
	}

	if id == nil {
		return
	}
	// Seal and drain atomically BEFORE responding. A goroutine the handler
	// spawned can Emit at any moment; this ordering guarantees its event either
	// rides this response or goes out as its own ext/emit notification, and
	// never lands in a buffer nothing will read.
	s.transport.respond(*id, wrapHookResult(result, ctx.sealAndTakeEvents()))
}

// wrapHookResult applies the engine's hook-response convention: with no
// buffered events the handler's value is the whole result; with events, the
// value and the events travel together. An object result gains an "events"
// key, a scalar is nested under "value", and a nil result yields events alone.
// Mirrors hook_forwarders.go, which accepts both the bare and wrapped shapes.
func wrapHookResult(result any, events []EngineEvent) any {
	if len(events) == 0 {
		return result
	}
	if result == nil {
		return map[string]any{"events": events}
	}
	if object, ok := appendEventsToJSONObject(result, events); ok {
		return object
	}
	return map[string]any{"value": result, "events": events}
}

// appendEventsToJSONObject preserves the exact JSON representation of a
// structured hook result while adding its events field. Decoding through
// map[string]any would turn integer fields into float64 and corrupt IDs above
// JavaScript's safe-integer range before the engine receives them.
func appendEventsToJSONObject(v any, events []EngineEvent) (json.RawMessage, bool) {
	data, err := json.Marshal(v)
	if err != nil || len(data) < 2 || data[0] != '{' || data[len(data)-1] != '}' {
		return nil, false
	}
	eventData, err := json.Marshal(events)
	if err != nil {
		return nil, false
	}
	out := make([]byte, 0, len(data)+len(eventData)+10)
	out = append(out, data[:len(data)-1]...)
	if len(data) > 2 {
		out = append(out, ',')
	}
	out = append(out, `"events":`...)
	out = append(out, eventData...)
	out = append(out, '}')
	return json.RawMessage(out), true
}

// handleTool invokes a tool and answers with its result.
func (s *SDK) handleTool(c context.Context, id *int64, name string, params json.RawMessage) {
	s.mu.RLock()
	tool, ok := s.tools[name]
	s.mu.RUnlock()
	if !ok {
		s.logger.Warn("tool call for unregistered tool", map[string]any{"tool": name})
		if id != nil {
			s.transport.respondError(*id, CodeMethodNotFound, "tool not found: "+name)
		}
		return
	}

	meta, input := splitEnvelope(params)
	ctx := s.newContext(meta)
	// No batch is opened: a tool response has no events array, so an Emit here
	// goes straight out as its own notification.

	result, err := tool.Execute(c, ctx, input)
	if err != nil {
		// A tool error is reported to the model as tool output, not as an RPC
		// failure: the engine hands IsError results back to the LLM so it can
		// react, whereas an RPC error is an extension malfunction.
		s.logger.Warn("tool execution failed", map[string]any{"tool": name, "error": err.Error()})
		if id != nil {
			s.transport.respond(*id, ToolResult{Content: err.Error(), IsError: true})
		}
		return
	}
	if id != nil {
		s.transport.respond(*id, result)
	}
}

// commandParams is the inbound shape of a slash-command invocation.
type commandParams struct {
	Args string `json:"args"`
}

// handleCommand invokes a slash command. Commands have no return value; the
// engine only needs to know the invocation finished.
func (s *SDK) handleCommand(c context.Context, id *int64, name string, params json.RawMessage) {
	s.mu.RLock()
	cmd, ok := s.commands[name]
	s.mu.RUnlock()
	if !ok {
		s.logger.Warn("invocation of unregistered command", map[string]any{"command": name})
		if id != nil {
			s.transport.respondError(*id, CodeMethodNotFound, "command not found: "+name)
		}
		return
	}

	meta, rest := splitEnvelope(params)
	var cp commandParams
	if len(rest) > 0 {
		if err := json.Unmarshal(rest, &cp); err != nil {
			s.logger.Warn("command params did not decode", map[string]any{"command": name, "error": err.Error()})
		}
	}

	ctx := s.newContext(meta)
	// No batch is opened: a command response has no events array, so an Emit
	// here goes straight out as its own notification.

	if err := cmd.Execute(c, ctx, cp.Args); err != nil {
		s.logger.Error("command failed", map[string]any{"command": name, "error": err.Error()})
		if id != nil {
			s.transport.respondError(*id, CodeHandlerError, err.Error())
		}
		return
	}
	if id != nil {
		s.transport.respond(*id, nil)
	}
}

// splitEnvelope separates the per-invocation _ctx metadata from the payload.
//
// The engine merges an object payload into params at the top level alongside
// _ctx. A non-object payload cannot be merged, so it arrives wrapped as
// {"_payload": value} — unwrap that back to the bare value, which is what a
// handler for a string-payload hook such as before_prompt expects.
func splitEnvelope(params json.RawMessage) (meta json.RawMessage, payload json.RawMessage) {
	if len(params) == 0 {
		return nil, nil
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(params, &fields); err != nil {
		// Not an object: the whole thing is the payload.
		return nil, params
	}
	meta = fields[ctxKey]
	delete(fields, ctxKey)

	if len(fields) == 0 {
		return meta, nil
	}
	if wrapped, ok := fields[payloadWrapperKey]; ok && len(fields) == 1 {
		return meta, wrapped
	}
	rest, err := json.Marshal(fields)
	if err != nil {
		// Re-marshalling a map of already-valid RawMessages cannot fail in
		// practice; fall back to the original params rather than dropping
		// the payload if it somehow does.
		return meta, params
	}
	return meta, rest
}

// sortToolDecls orders tools by name so the init payload is deterministic.
func sortToolDecls(tools []wireToolDecl) {
	for i := 1; i < len(tools); i++ {
		for j := i; j > 0 && tools[j].Name < tools[j-1].Name; j-- {
			tools[j], tools[j-1] = tools[j-1], tools[j]
		}
	}
}
