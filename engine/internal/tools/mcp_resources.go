package tools

import (
	"context"
	"fmt"
	"strings"

	"github.com/dsswift/ion/engine/internal/mcp"
	"github.com/dsswift/ion/engine/internal/types"
)

// ListMcpResourcesTool returns a ToolDef that lists resources from a connected MCP server.
func ListMcpResourcesTool() *types.ToolDef {
	return &types.ToolDef{
		Name:        "ListMcpResources",
		Description: "List resources available from a connected MCP server.",
		InputSchema: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"server": map[string]any{
					"type":        "string",
					"description": "Name of the MCP server to list resources from",
				},
			},
			"required": []string{"server"},
		},
		Execute: executeListMcpResources,
	}
}

// ReadMcpResourceTool returns a ToolDef that reads a resource from a connected MCP server.
func ReadMcpResourceTool() *types.ToolDef {
	return &types.ToolDef{
		Name:        "ReadMcpResource",
		Description: "Read a specific resource from a connected MCP server by URI.",
		InputSchema: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"server": map[string]any{
					"type":        "string",
					"description": "Name of the MCP server",
				},
				"uri": map[string]any{
					"type":        "string",
					"description": "URI of the resource to read",
				},
			},
			"required": []string{"server", "uri"},
		},
		Execute: executeReadMcpResource,
	}
}

func executeListMcpResources(ctx context.Context, input map[string]any, _ string) (*types.ToolResult, error) {
	server, _ := input["server"].(string)
	if server == "" {
		return &types.ToolResult{Content: "Error: server is required", IsError: true}, nil
	}
	if err := ctx.Err(); err != nil {
		return &types.ToolResult{Content: "Error: ListMcpResources cancelled.", IsError: true}, nil
	}

	resources, err := mcp.ListMcpResources(server)
	if err != nil {
		return &types.ToolResult{Content: fmt.Sprintf("Error: %s", err), IsError: true}, nil
	}

	if len(resources) == 0 {
		return &types.ToolResult{Content: "No resources available."}, nil
	}

	var lines []string
	for _, r := range resources {
		line := fmt.Sprintf("- %s: %s", r.URI, r.Name)
		if r.Description != "" {
			line += " -- " + r.Description
		}
		lines = append(lines, line)
	}
	return &types.ToolResult{Content: strings.Join(lines, "\n")}, nil
}

func executeReadMcpResource(ctx context.Context, input map[string]any, _ string) (*types.ToolResult, error) {
	server, _ := input["server"].(string)
	if server == "" {
		return &types.ToolResult{Content: "Error: server is required", IsError: true}, nil
	}
	uri, _ := input["uri"].(string)
	if uri == "" {
		return &types.ToolResult{Content: "Error: uri is required", IsError: true}, nil
	}
	if err := ctx.Err(); err != nil {
		return &types.ToolResult{Content: "Error: ReadMcpResource cancelled.", IsError: true}, nil
	}

	content, err := mcp.ReadMcpResource(server, uri)
	if err != nil {
		return &types.ToolResult{Content: fmt.Sprintf("Error: %s", err), IsError: true}, nil
	}

	if content.Text != "" {
		return &types.ToolResult{Content: content.Text}, nil
	}
	if content.Blob != "" {
		return &types.ToolResult{Content: fmt.Sprintf("[base64 blob, %d chars, mime: %s]", len(content.Blob), content.MimeType)}, nil
	}
	return &types.ToolResult{Content: "Resource returned empty content."}, nil
}
