// Package mcp implements Ion's MCP client adapter.
package mcp

import (
	"bufio"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"iter"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"

	mcpgo "github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/dsswift/ion/engine/internal/sysmetrics"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// ToolDef describes a tool exposed by an MCP server.
type ToolDef struct {
	Name        string                 `json:"name"`
	Description string                 `json:"description"`
	InputSchema map[string]interface{} `json:"inputSchema"`
}

// McpResource describes a resource exposed by an MCP server.
type McpResource struct {
	URI         string `json:"uri"`
	Name        string `json:"name,omitempty"`
	Description string `json:"description,omitempty"`
	MimeType    string `json:"mimeType,omitempty"`
}

// McpResourceContent holds content returned by an MCP resource read.
type McpResourceContent struct {
	URI      string `json:"uri"`
	MimeType string `json:"mimeType,omitempty"`
	Text     string `json:"text,omitempty"`
	Blob     string `json:"blob,omitempty"`
}

const (
	mcpCallTimeoutDefault       = 60 * time.Second
	clientImplementationVersion = "1.0.0"
)

// DefaultCallTimeout is fallback timeout for MCP tool calls.
var DefaultCallTimeout = mcpCallTimeoutDefault

// DefaultMetadataTimeout bounds MCP metadata calls.
var DefaultMetadataTimeout = 30 * time.Second

// SetDefaultCallTimeout overrides the default MCP tool call timeout.
func SetDefaultCallTimeout(d time.Duration) { DefaultCallTimeout = d }

// SetDefaultMetadataTimeout overrides default MCP metadata timeout.
func SetDefaultMetadataTimeout(d time.Duration) { DefaultMetadataTimeout = d }

// ElicitationRequest is an MCP-server request for user input. RequestState is
// intentionally absent: SDK MRTR middleware owns its opaque replay.
type ElicitationRequest struct {
	ServerName string
	Mode       string
	Message    string
	Schema     map[string]any
	URL        string
}

// ElicitationReply maps Ion's user decision onto MCP's three-action model.
type ElicitationReply struct {
	Action   string
	Response map[string]any
}

// ConnectionOptions attach Ion-owned behavior around generic protocol mechanics.
type ConnectionOptions struct {
	Elicit func(context.Context, ElicitationRequest) (ElicitationReply, error)
}

// Connection is a negotiated MCP client session. Protocol mechanics belong to
// the official SDK; this adapter owns Ion routing, observability, and result
// conversion only.
type Connection struct {
	name            string
	session         *mcpgo.ClientSession
	close           func() error
	tools           []ToolDef
	protocolVersion string
	capabilities    map[string]any
	callTimeout     time.Duration
	mu              sync.RWMutex
}

// Connect establishes a dual-era MCP connection using default Ion behavior.
func Connect(name string, config types.McpServerConfig) (*Connection, error) {
	return ConnectContext(context.Background(), name, config, ConnectionOptions{})
}

// ConnectWithOptions establishes a connection and negotiates modern MCP or a
// legacy handshake. The official SDK probes server/discover then falls back to
// initialize for older peers.
func ConnectWithOptions(name string, config types.McpServerConfig, opts ConnectionOptions) (*Connection, error) {
	return ConnectContext(context.Background(), name, config, opts)
}

// ConnectContext is ConnectWithOptions bounded by ctx as well as
// DefaultMetadataTimeout: cancelling ctx abandons the handshake.
func ConnectContext(ctx context.Context, name string, config types.McpServerConfig, opts ConnectionOptions) (*Connection, error) {
	transport, cleanup, err := newSDKTransport(ctx, name, config)
	if err != nil {
		return nil, fmt.Errorf("mcp connect %s: %w", name, err)
	}
	if cleanup == nil {
		cleanup = func() error { return nil }
	}
	// The handshake's cancellation and the connection's Close can both reach
	// cleanup; it runs once.
	var cleanupOnce sync.Once
	var cleanupErr error
	transportCleanup := cleanup
	cleanup = func() error {
		cleanupOnce.Do(func() { cleanupErr = transportCleanup() })
		return cleanupErr
	}

	clientOpts := &mcpgo.ClientOptions{
		Logger: newSDKLogger(name),
		Capabilities: &mcpgo.ClientCapabilities{Elicitation: &mcpgo.ElicitationCapabilities{
			Form: &mcpgo.FormElicitationCapabilities{},
			URL:  &mcpgo.URLElicitationCapabilities{},
		}},
	}
	if opts.Elicit != nil {
		clientOpts.ElicitationHandler = func(ctx context.Context, req *mcpgo.ElicitRequest) (*mcpgo.ElicitResult, error) {
			params := req.Params
			schema, ok := params.RequestedSchema.(map[string]any)
			if !ok && params.RequestedSchema != nil {
				return nil, fmt.Errorf("MCP elicitation schema from %s is not an object", name)
			}
			if params.Mode != "" && params.Mode != "form" && params.Mode != "url" {
				return nil, fmt.Errorf("MCP elicitation mode %q from %s is unsupported", params.Mode, name)
			}
			if params.Mode == "url" && params.URL == "" {
				return nil, fmt.Errorf("MCP URL elicitation from %s lacks URL", name)
			}
			reply, elicitErr := opts.Elicit(ctx, ElicitationRequest{
				ServerName: name,
				Mode:       params.Mode,
				Message:    params.Message,
				Schema:     schema,
				URL:        params.URL,
			})
			if elicitErr != nil {
				return nil, elicitErr
			}
			return &mcpgo.ElicitResult{Action: reply.Action, Content: reply.Response}, nil
		}
	}

	client := mcpgo.NewClient(&mcpgo.Implementation{Name: "ion-engine", Version: clientImplementationVersion}, clientOpts)
	connectCtx, cancel := context.WithTimeout(ctx, DefaultMetadataTimeout)
	defer cancel()
	// A cancelled or timed-out handshake ends the transport at once, so no
	// request it opened waits on a server that does not answer.
	abandonHandshake := context.AfterFunc(connectCtx, func() {
		if err := cleanup(); err != nil {
			utils.LogWithFields(utils.LevelInfo, "mcp", "transport close after abandoned handshake", map[string]any{"serverName": name, "error": err.Error()})
		}
	})
	session, err := client.Connect(connectCtx, transport, nil)
	if err != nil {
		if closeErr := cleanup(); closeErr != nil {
			utils.LogWithFields(utils.LevelInfo, "mcp", "transport close after connection failure", map[string]any{"serverName": name, "error": closeErr.Error()})
		}
		return nil, annotateAuthFailure(name, config, fmt.Errorf("mcp connect %s: %w", name, err))
	}

	// A stdio server's process exists once Connect returns; label it for
	// System Metrics. The transport cleanup unregisters it.
	if ct, ok := transport.(*mcpgo.CommandTransport); ok && ct.Command != nil && ct.Command.Process != nil {
		sysmetrics.RegisterProcess(ct.Command.Process.Pid, types.SystemMetricsRoleMcp, name)
	}
	conn := &Connection{name: name, session: session, close: cleanup}
	if config.TimeoutSeconds > 0 {
		conn.callTimeout = time.Duration(config.TimeoutSeconds) * time.Second
	}
	if init := session.InitializeResult(); init != nil {
		conn.protocolVersion = init.ProtocolVersion
		conn.capabilities = capabilitiesMap(init.Capabilities)
	}
	if err := conn.refreshTools(connectCtx); err != nil {
		if closeErr := session.Close(); closeErr != nil {
			utils.LogWithFields(utils.LevelInfo, "mcp", "SDK session close after tool discovery failure", map[string]any{"serverName": name, "error": closeErr.Error()})
		}
		if closeErr := cleanup(); closeErr != nil {
			utils.LogWithFields(utils.LevelInfo, "mcp", "transport close after tool discovery failure", map[string]any{"serverName": name, "error": closeErr.Error()})
		}
		return nil, annotateAuthFailure(name, config, fmt.Errorf("mcp list tools %s: %w", name, err))
	}
	if !abandonHandshake() {
		// The handshake was abandoned as it finished; the transport is gone.
		if closeErr := session.Close(); closeErr != nil {
			utils.LogWithFields(utils.LevelInfo, "mcp", "SDK session close after abandoned handshake", map[string]any{"serverName": name, "error": closeErr.Error()})
		}
		return nil, fmt.Errorf("mcp connect %s: %w", name, context.Cause(connectCtx))
	}
	utils.LogWithFields(utils.LevelInfo, "mcp", "server connected", map[string]any{
		"serverName": name, "protocolVersion": conn.protocolVersion,
		"toolCount": len(conn.tools), "capabilities": conn.capabilities,
	})
	return conn, nil
}

func capabilitiesMap(v any) map[string]any {
	data, err := json.Marshal(v)
	if err != nil {
		return nil
	}
	var out map[string]any
	if err := json.Unmarshal(data, &out); err != nil {
		return nil
	}
	return out
}

func (c *Connection) refreshTools(ctx context.Context) error {
	tools, err := collect(ctx, c.session.Tools(ctx, nil))
	if err != nil {
		return err
	}
	defs := make([]ToolDef, 0, len(tools))
	for _, tool := range tools {
		if tool == nil {
			continue
		}
		schema, ok := tool.InputSchema.(map[string]any)
		if !ok || schema == nil {
			utils.LogWithFields(utils.LevelWarn, "mcp", "tool excluded because input schema is not an object", map[string]any{"serverName": c.name, "toolName": tool.Name})
			continue
		}
		defs = append(defs, ToolDef{Name: tool.Name, Description: tool.Description, InputSchema: schema})
	}
	c.mu.Lock()
	c.tools = defs
	c.mu.Unlock()
	return nil
}

func collect[T any](ctx context.Context, sequence iter.Seq2[T, error]) ([]T, error) {
	var values []T
	for value, err := range sequence {
		if err != nil {
			return nil, err
		}
		values = append(values, value)
	}
	return values, nil
}

// CallTool invokes an MCP tool and preserves text, image, resource, and
// structured content for the engine tool pipeline.
func (c *Connection) CallTool(ctx context.Context, toolName string, params map[string]interface{}) (*types.ToolResult, error) {
	if params == nil {
		params = map[string]interface{}{}
	}
	callCtx, cancel := c.callContext(ctx)
	defer cancel()
	if suspender := types.DeadlineSuspenderFrom(ctx); suspender != nil {
		suspender.Pause()
		defer suspender.Resume()
	}
	result, err := c.session.CallTool(callCtx, &mcpgo.CallToolParams{Name: toolName, Arguments: params})
	if err != nil {
		// A deadline on callCtx with the caller's ctx still live means the
		// per-call timeout ended the call, not the caller. Name it so the
		// model and the operator can tell a slow server from a cancelled run.
		if errors.Is(err, context.DeadlineExceeded) && ctx.Err() == nil {
			timeout := c.effectiveCallTimeout()
			utils.LogWithFields(utils.LevelWarn, "mcp", "tool call timed out", map[string]any{
				"serverName": c.name, "toolName": toolName, "timeout": timeout.String(),
			})
			return nil, fmt.Errorf("call %s: timeout after %s: %w", toolName, timeout, err)
		}
		utils.LogWithFields(utils.LevelWarn, "mcp", "tool call failed", map[string]any{
			"serverName": c.name, "toolName": toolName, "error": err.Error(),
		})
		return nil, fmt.Errorf("call %s: %w", toolName, err)
	}
	converted := convertToolResult(result)
	utils.LogWithFields(utils.LevelInfo, "mcp", "tool call completed", map[string]any{
		"serverName": c.name, "toolName": toolName, "isError": converted.IsError,
		"imageCount": len(converted.Images),
	})
	return converted, nil
}

// effectiveCallTimeout is the per-server timeout, or the package default when
// the server config set none.
func (c *Connection) effectiveCallTimeout() time.Duration {
	if c.callTimeout == 0 {
		return DefaultCallTimeout
	}
	return c.callTimeout
}

func (c *Connection) callContext(parent context.Context) (context.Context, context.CancelFunc) {
	return context.WithTimeout(parent, c.effectiveCallTimeout())
}

func convertToolResult(result *mcpgo.CallToolResult) *types.ToolResult {
	if result == nil {
		return &types.ToolResult{Content: "MCP server returned no tool result.", IsError: true}
	}
	var text []string
	out := &types.ToolResult{IsError: result.IsError}
	for _, block := range result.Content {
		switch value := block.(type) {
		case *mcpgo.TextContent:
			text = append(text, value.Text)
			out.ContentItems = append(out.ContentItems, types.ToolContent{Type: "text", Text: value.Text})
		case *mcpgo.ImageContent:
			data := base64.StdEncoding.EncodeToString(value.Data)
			out.ContentItems = append(out.ContentItems, types.ToolContent{Type: "image", Data: data, MimeType: value.MIMEType})
		case *mcpgo.EmbeddedResource:
			if value.Resource == nil {
				continue
			}
			blob := base64.StdEncoding.EncodeToString(value.Resource.Blob)
			out.ContentItems = append(out.ContentItems, types.ToolContent{Type: "resource", Resource: &types.EmbeddedResource{URI: value.Resource.URI, MimeType: value.Resource.MIMEType, Text: value.Resource.Text, Blob: blob}})
			if value.Resource.Text != "" {
				text = append(text, value.Resource.Text)
			} else if len(value.Resource.Blob) > 0 {
				text = append(text, fmt.Sprintf("[resource blob, %d bytes, mime: %s]", len(value.Resource.Blob), value.Resource.MIMEType))
			}
		case *mcpgo.ResourceLink:
			out.ContentItems = append(out.ContentItems, types.ToolContent{Type: "resource_link", URI: value.URI, Name: value.Name, Title: value.Title, Description: value.Description, MimeType: value.MIMEType})
			text = append(text, value.URI)
		default:
			encoded, err := json.Marshal(block)
			if err != nil {
				text = append(text, fmt.Sprintf("[unsupported MCP content %T]", block))
			} else {
				out.ContentItems = append(out.ContentItems, types.ToolContent{Type: "unknown", Unknown: encoded})
				text = append(text, string(encoded))
			}
		}
	}
	if result.StructuredContent != nil {
		encoded, err := json.Marshal(result.StructuredContent)
		if err == nil {
			text = append(text, string(encoded))
		}
	}
	if len(text) == 0 {
		text = append(text, "MCP tool returned empty content.")
	}
	out.Content = joinNonEmpty(text)
	out.EphemeralImages = types.ToolContentEphemeralImages(out.ContentItems)
	return out
}

func joinNonEmpty(parts []string) string {
	out := ""
	for _, part := range parts {
		if part == "" {
			continue
		}
		if out != "" {
			out += "\n"
		}
		out += part
	}
	return out
}

func drainStdioStderr(serverName string, stderr io.Reader) {
	scanner := bufio.NewScanner(stderr)
	for scanner.Scan() {
		line := scanner.Text()
		if strings.TrimSpace(line) == "" {
			continue
		}
		utils.LogWithFields(utils.LevelDebug, "mcp.stdio", "server stderr", map[string]any{"serverName": serverName, "line": line})
	}
	if err := scanner.Err(); err != nil {
		utils.LogWithFields(utils.LevelInfo, "mcp.stdio", "server stderr drain ended", map[string]any{"serverName": serverName, "error": err.Error()})
	}
}

// Tools returns a copy of currently discovered tools.
func (c *Connection) Tools() []ToolDef {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return append([]ToolDef(nil), c.tools...)
}

// ListResources returns every page in deterministic server order.
func (c *Connection) ListResources(ctx context.Context) ([]McpResource, error) {
	resources, err := collect(ctx, c.session.Resources(ctx, nil))
	if err != nil {
		return nil, err
	}
	out := make([]McpResource, 0, len(resources))
	for _, resource := range resources {
		if resource == nil {
			continue
		}
		out = append(out, McpResource{URI: resource.URI, Name: resource.Name, Description: resource.Description, MimeType: resource.MIMEType})
	}
	return out, nil
}

// ReadResource reads a resource and joins every returned content item.
func (c *Connection) ReadResource(ctx context.Context, uri string) (*McpResourceContent, error) {
	result, err := c.session.ReadResource(ctx, &mcpgo.ReadResourceParams{URI: uri})
	if err != nil {
		return nil, err
	}
	if len(result.Contents) == 0 {
		return nil, fmt.Errorf("no content returned for resource %s", uri)
	}
	out := &McpResourceContent{URI: uri}
	var texts []string
	for _, content := range result.Contents {
		if content == nil {
			continue
		}
		if out.MimeType == "" {
			out.MimeType = content.MIMEType
		}
		if content.Text != "" {
			texts = append(texts, content.Text)
		}
		if len(content.Blob) > 0 {
			if out.Blob != "" {
				out.Blob += "\n"
			}
			out.Blob += base64.StdEncoding.EncodeToString(content.Blob)
		}
	}
	out.Text = joinNonEmpty(texts)
	return out, nil
}

// Name returns configured server name.
func (c *Connection) Name() string { return c.name }

// ProtocolVersion returns version negotiated for this connection.
func (c *Connection) ProtocolVersion() string { return c.protocolVersion }

// Capabilities returns a defensive copy of advertised server capabilities.
func (c *Connection) Capabilities() map[string]any {
	c.mu.RLock()
	defer c.mu.RUnlock()
	out := make(map[string]any, len(c.capabilities))
	for key, value := range c.capabilities {
		out[key] = value
	}
	return out
}

// Close closes the SDK session then its underlying Ion transport.
func (c *Connection) Close() error {
	var errs []error
	if c.session != nil {
		if err := c.session.Close(); err != nil {
			errs = append(errs, err)
		}
	}
	if c.close != nil {
		if err := c.close(); err != nil {
			errs = append(errs, err)
		}
	}
	return joinErrors(errs)
}

func joinErrors(errs []error) error {
	for _, err := range errs {
		if err != nil {
			return err
		}
	}
	return nil
}

// commandTransport builds the stdio transport. The server inherits the
// engine's environment plus the configured Env; when ctx carries a trace
// (the server is connected under a run) it also receives that trace as
// TRACEPARENT. A nil cmd.Env keeps the plain inherited environment.
func commandTransport(ctx context.Context, config types.McpServerConfig) (*mcpgo.CommandTransport, error) {
	if config.Command == "" {
		return nil, fmt.Errorf("stdio transport requires command")
	}
	cmd := exec.Command(config.Command, config.Args...)
	cmd.Env = commandEnv(ctx, config)
	return &mcpgo.CommandTransport{Command: cmd}, nil
}

// commandEnv is the environment a stdio MCP server starts with: nil (inherit)
// when there is nothing to add, else the inherited set plus the configured
// Env and, under a run, TRACEPARENT.
func commandEnv(ctx context.Context, config types.McpServerConfig) []string {
	traceparent := utils.TraceparentFromContext(ctx)
	if len(config.Env) == 0 && traceparent == "" {
		utils.LogWithFields(utils.LevelDebug, "mcp", "stdio server inherits environment; no trace in flight", map[string]any{"command": config.Command})
		return nil
	}
	env := append([]string(nil), os.Environ()...)
	for key, value := range config.Env {
		env = append(env, key+"="+value)
	}
	if traceparent != "" {
		env = append(env, "TRACEPARENT="+traceparent)
		utils.LogWithFields(utils.LevelDebug, "mcp", "TRACEPARENT set for stdio server", map[string]any{"command": config.Command, "traceparent": traceparent})
	}
	return env
}
