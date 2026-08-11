// agent_tools.go — turn agent markdown files into dispatch tools.
//
// An extension that ships agents/ *.md files can expose each one to the model
// as its own tool, so the model dispatches a named specialist rather than
// calling a generic dispatch tool with a name argument.
//
// The frontmatter parser here is deliberately hand-rolled rather than a YAML
// dependency. Agent frontmatter is a flat key/value block with optional inline
// arrays, the engine's own parser
// (engine/internal/agentdiscovery/frontmatter.go) reads exactly that subset,
// and matching its behaviour matters more than accepting YAML this SDK would
// then interpret differently from the engine. It also keeps the module
// dependency-free.
package ion

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// wellKnownFrontmatterKeys are consumed as typed fields on DiscoveredAgent.
// Everything else lands in Meta. Mirrors the engine's own switch so an
// SDK-discovered agent looks like an engine-discovered one.
var wellKnownFrontmatterKeys = map[string]bool{
	"name": true, "parent": true, "description": true, "model": true, "tools": true,
}

// RegisterAgentToolsOpts customises the generated tools.
type RegisterAgentToolsOpts struct {
	// Dir is the directory to scan. Empty scans "agents" under the process
	// working directory, which is the extension directory at load time.
	Dir string
	// Filter decides which agents get a tool. Nil keeps the default: exclude
	// root agents (those with no parent), because a root agent *is* the
	// conversation rather than something to dispatch into.
	Filter func(DiscoveredAgent) bool
	// ToolName names the generated tool. Nil produces
	// "dispatch_<name with dashes as underscores>".
	ToolName func(DiscoveredAgent) string
	// Description describes the generated tool to the model. Nil produces a
	// sentence from the agent's description.
	Description func(DiscoveredAgent) string
}

// RegisterAgentTools scans the agents directory and registers a dispatch tool
// per agent.
//
// Each generated tool carries the agent's persona and model on its closure, so
// the dispatched child is fully configured rather than a generic LLM with a
// name. Call it before [SDK.Run] so the tools ride the init handshake.
//
// A missing agents directory is not an error: an extension with no agents is
// perfectly normal, and this returns cleanly.
func (s *SDK) RegisterAgentTools(opts RegisterAgentToolsOpts) error {
	dir := opts.Dir
	if dir == "" {
		cwd, err := os.Getwd()
		if err != nil {
			return fmt.Errorf("ion: cannot resolve working directory for agent discovery: %w", err)
		}
		dir = filepath.Join(cwd, "agents")
	}

	entries, err := os.ReadDir(dir)
	if err != nil {
		if os.IsNotExist(err) {
			s.logger.Debug("no agents directory; registered no dispatch tools",
				map[string]any{"dir": dir})
			return nil
		}
		return fmt.Errorf("ion: cannot read agents directory %s: %w", dir, err)
	}

	filter := opts.Filter
	if filter == nil {
		filter = func(a DiscoveredAgent) bool { return a.Parent != "" }
	}

	registered := 0
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".md") {
			continue
		}
		path := filepath.Join(dir, entry.Name())
		content, err := os.ReadFile(path)
		if err != nil {
			// One unreadable file must not abort discovery of the rest — log
			// it and carry on, so a permissions problem on one agent does not
			// silently remove every other agent's tool.
			s.logger.Warn("skipping unreadable agent file", map[string]any{
				"path": path, "error": err.Error(),
			})
			continue
		}

		agent := parseAgentFile(path, entry.Name(), string(content))
		if !filter(agent) {
			continue
		}

		toolName := defaultToolName(agent)
		if opts.ToolName != nil {
			toolName = opts.ToolName(agent)
		}
		toolDesc := defaultToolDescription(agent)
		if opts.Description != nil {
			toolDesc = opts.Description(agent)
		}

		s.registerDispatchTool(toolName, toolDesc, agent)
		registered++

		// One line per agent at wire time. The persona length and meta count
		// are the load-bearing values: a zero systemPrompt on an agent whose
		// file has a body means the parser dropped it.
		s.logger.Info("registered agent dispatch tool", map[string]any{
			"agent":        agent.Name,
			"tool":         toolName,
			"model":        agent.Model,
			"sysPromptLen": len(agent.SystemPrompt),
			"metaKeys":     len(agent.Meta),
			"parent":       agent.Parent,
		})
	}

	s.logger.Info("agent tool registration complete",
		map[string]any{"dir": dir, "registered": registered})
	return nil
}

// registerDispatchTool adds one agent's dispatch tool, capturing the persona
// and model on the closure.
func (s *SDK) registerDispatchTool(toolName, toolDesc string, agent DiscoveredAgent) {
	s.RegisterTool(ToolDef{
		Name:        toolName,
		Description: toolDesc,
		Parameters: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"task": map[string]any{
					"type":        "string",
					"description": "The task for the specialist to perform",
				},
			},
			"required": []string{"task"},
		},
		Execute: func(c context.Context, ctx *Context, input json.RawMessage) (ToolResult, error) {
			var args struct {
				Task string `json:"task"`
			}
			if len(input) > 0 {
				if err := json.Unmarshal(input, &args); err != nil {
					return ToolResult{}, fmt.Errorf("decode task argument: %w", err)
				}
			}

			// Per-call trace at debug: dispatch-heavy sessions would drown in
			// this at info. The once-per-agent info line above is the record
			// that the tool exists and carries a persona.
			ctx.Log().Debug("dispatching agent", map[string]any{
				"agent":        agent.Name,
				"model":        agent.Model,
				"sysPromptLen": len(agent.SystemPrompt),
				"taskLen":      len(args.Task),
			})

			result, err := ctx.DispatchAgent(c, DispatchAgentOpts{
				Name:         agent.Name,
				Task:         args.Task,
				SystemPrompt: agent.SystemPrompt,
				Model:        agent.Model,
			})
			if err != nil {
				return ToolResult{}, err
			}
			return ToolResult{
				Content: "Dispatched " + agent.Name + " specialist (" + result.DispatchID + ").",
			}, nil
		},
	})
}

func defaultToolName(agent DiscoveredAgent) string {
	return "dispatch_" + strings.ReplaceAll(agent.Name, "-", "_")
}

func defaultToolDescription(agent DiscoveredAgent) string {
	if agent.Description != "" {
		return "Dispatch the " + agent.Description + " specialist"
	}
	return "Dispatch the " + agent.Name + " specialist"
}

// parseAgentFile turns one markdown file into a DiscoveredAgent.
func parseAgentFile(path, filename, content string) DiscoveredAgent {
	fields, body := splitFrontmatter(content)

	name := firstString(fields["name"])
	if name == "" {
		name = strings.TrimSuffix(filename, ".md")
	}

	meta := map[string]string{}
	for key, val := range fields {
		if wellKnownFrontmatterKeys[key] {
			continue
		}
		// Join list values so Meta stays a flat string map, matching the
		// engine's AgentDef.Meta shape.
		meta[key] = strings.Join(val, ", ")
	}

	agent := DiscoveredAgent{
		Name:         name,
		Path:         path,
		Source:       "extension",
		Parent:       firstString(fields["parent"]),
		Description:  firstString(fields["description"]),
		Model:        firstString(fields["model"]),
		Tools:        fields["tools"],
		SystemPrompt: body,
	}
	if len(meta) > 0 {
		agent.Meta = meta
	}
	return agent
}

// splitFrontmatter separates a markdown file's YAML frontmatter from its body.
//
// Every value is returned as a slice: a bare value is a one-element slice and
// an inline array (`[a, b]`) is a multi-element one, so callers do not have to
// branch on the shape. Only the first `---` delimiter pair counts, so a
// horizontal rule in the body is not mistaken for a closing fence.
//
// With no frontmatter fence the whole file is the body, which makes a
// body-only agent file valid — the name then falls back to the filename stem.
func splitFrontmatter(content string) (fields map[string][]string, body string) {
	fields = map[string][]string{}

	normalized := strings.ReplaceAll(content, "\r\n", "\n")
	if !strings.HasPrefix(normalized, "---\n") {
		return fields, strings.TrimLeft(normalized, " \t\n")
	}

	rest := normalized[len("---\n"):]
	end := strings.Index(rest, "\n---")
	if end < 0 {
		// An unterminated fence is not frontmatter; treat the file as a body.
		return fields, strings.TrimLeft(normalized, " \t\n")
	}

	block := rest[:end]
	after := rest[end+len("\n---"):]
	after = strings.TrimPrefix(after, "\n")

	for _, line := range strings.Split(block, "\n") {
		colon := strings.Index(line, ":")
		if colon < 0 {
			continue
		}
		key := strings.TrimSpace(line[:colon])
		val := strings.TrimSpace(line[colon+1:])
		if key == "" {
			continue
		}
		if strings.HasPrefix(val, "[") && strings.HasSuffix(val, "]") {
			var items []string
			for _, item := range strings.Split(val[1:len(val)-1], ",") {
				if trimmed := strings.TrimSpace(item); trimmed != "" {
					items = append(items, trimmed)
				}
			}
			fields[key] = items
			continue
		}
		fields[key] = []string{val}
	}

	// Trim leading whitespace so a persona starting with a blank line still
	// begins at its first real paragraph. Trailing whitespace is preserved:
	// some personas end with a deliberate blank line so the engine's
	// system-prompt concatenation lands cleanly.
	return fields, strings.TrimLeft(after, " \t\n")
}

func firstString(vals []string) string {
	if len(vals) == 0 {
		return ""
	}
	return vals[0]
}
