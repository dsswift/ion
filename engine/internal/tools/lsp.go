package tools

import (
	"context"
	"fmt"
	"strings"

	"github.com/dsswift/ion/engine/internal/types"
)

// LspLocation is a file location returned by LSP operations.
type LspLocation struct {
	File string `json:"file"`
	Line int    `json:"line"`
	Col  int    `json:"col"`
}

// LspSymbol is a symbol returned by document/workspace symbol queries.
type LspSymbol struct {
	Name string `json:"name"`
	Kind string `json:"kind"`
	Line int    `json:"line"`
}

// LspWorkspaceSymbol extends LspSymbol with a file path.
type LspWorkspaceSymbol struct {
	Name string `json:"name"`
	Kind string `json:"kind"`
	Path string `json:"path"`
	Line int    `json:"line"`
}

// LspDiagnostic is a diagnostic from an LSP server.
type LspDiagnostic struct {
	Line     int    `json:"line"`
	Severity string `json:"severity"`
	Message  string `json:"message"`
}

// LspManager provides LSP operations. Harness configures this via SetLspManager.
type LspManager interface {
	GoToDefinition(filePath string, line, character int) ([]LspLocation, error)
	FindReferences(filePath string, line, character int) ([]LspLocation, error)
	Hover(filePath string, line, character int) (string, error)
	DocumentSymbols(filePath string) ([]LspSymbol, error)
	WorkspaceSymbols(query string) ([]LspWorkspaceSymbol, error)
	Diagnostics(filePath string) ([]LspDiagnostic, error)
}

var lspManager LspManager

// SetLspManager configures the LSP manager used by the LSP tool.
func SetLspManager(m LspManager) {
	lspManager = m
}

// GetLspManager returns the current LSP manager (may be nil).
func GetLspManager() LspManager {
	return lspManager
}

// LspTool returns a ToolDef for Language Server Protocol operations.
func LspTool() *types.ToolDef {
	return &types.ToolDef{
		Name:        "LSP",
		Description: "Language Server Protocol operations: go-to-definition, find-references, hover, symbols, diagnostics. Requires LspManager to be configured by the harness.",
		InputSchema: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"operation": map[string]any{
					"type":        "string",
					"enum":        []string{"definition", "references", "hover", "symbols", "workspace_symbols", "diagnostics"},
					"description": "LSP operation to perform",
				},
				"file_path": map[string]any{"type": "string", "description": "File path (required for most operations)"},
				"line":      map[string]any{"type": "number", "description": "Line number (0-based, for definition/references/hover)"},
				"character": map[string]any{"type": "number", "description": "Character offset (0-based, for definition/references/hover)"},
				"query":     map[string]any{"type": "string", "description": "Search query (for workspace_symbols)"},
			},
			"required": []string{"operation"},
		},
		Execute: executeLsp,
	}
}

func executeLsp(_ context.Context, input map[string]any, cwd string) (*types.ToolResult, error) {
	if lspManager == nil {
		return &types.ToolResult{
			Content: "LSP not configured. Harness must call SetLspManager() to enable LSP features.",
			IsError: true,
		}, nil
	}

	operation, _ := input["operation"].(string)
	filePath := stringFromInput(input, "file_path", "")
	if filePath != "" {
		filePath = resolvePath(cwd, filePath)
	}

	switch operation {
	case "definition":
		if filePath == "" || !hasKey(input, "line") || !hasKey(input, "character") {
			return &types.ToolResult{Content: "definition requires file_path, line, and character", IsError: true}, nil
		}
		line := intFromInput(input, "line", 0)
		character := intFromInput(input, "character", 0)
		results, err := lspManager.GoToDefinition(filePath, line, character)
		if err != nil {
			return &types.ToolResult{Content: fmt.Sprintf("LSP error: %s", err), IsError: true}, nil
		}
		if len(results) == 0 {
			return &types.ToolResult{Content: "No definition found"}, nil
		}
		return &types.ToolResult{Content: formatLocations(results)}, nil

	case "references":
		if filePath == "" || !hasKey(input, "line") || !hasKey(input, "character") {
			return &types.ToolResult{Content: "references requires file_path, line, and character", IsError: true}, nil
		}
		line := intFromInput(input, "line", 0)
		character := intFromInput(input, "character", 0)
		results, err := lspManager.FindReferences(filePath, line, character)
		if err != nil {
			return &types.ToolResult{Content: fmt.Sprintf("LSP error: %s", err), IsError: true}, nil
		}
		if len(results) == 0 {
			return &types.ToolResult{Content: "No references found"}, nil
		}
		return &types.ToolResult{Content: formatLocations(results)}, nil

	case "hover":
		if filePath == "" || !hasKey(input, "line") || !hasKey(input, "character") {
			return &types.ToolResult{Content: "hover requires file_path, line, and character", IsError: true}, nil
		}
		line := intFromInput(input, "line", 0)
		character := intFromInput(input, "character", 0)
		result, err := lspManager.Hover(filePath, line, character)
		if err != nil {
			return &types.ToolResult{Content: fmt.Sprintf("LSP error: %s", err), IsError: true}, nil
		}
		if result == "" {
			return &types.ToolResult{Content: "No hover information"}, nil
		}
		return &types.ToolResult{Content: result}, nil

	case "symbols":
		if filePath == "" {
			return &types.ToolResult{Content: "symbols requires file_path", IsError: true}, nil
		}
		symbols, err := lspManager.DocumentSymbols(filePath)
		if err != nil {
			return &types.ToolResult{Content: fmt.Sprintf("LSP error: %s", err), IsError: true}, nil
		}
		if len(symbols) == 0 {
			return &types.ToolResult{Content: "No symbols found"}, nil
		}
		lines := make([]string, len(symbols))
		for i, s := range symbols {
			lines[i] = fmt.Sprintf("%s %s (line %d)", s.Kind, s.Name, s.Line)
		}
		return &types.ToolResult{Content: strings.Join(lines, "\n")}, nil

	case "workspace_symbols":
		query := stringFromInput(input, "query", "")
		if query == "" {
			return &types.ToolResult{Content: "workspace_symbols requires query", IsError: true}, nil
		}
		symbols, err := lspManager.WorkspaceSymbols(query)
		if err != nil {
			return &types.ToolResult{Content: fmt.Sprintf("LSP error: %s", err), IsError: true}, nil
		}
		if len(symbols) == 0 {
			return &types.ToolResult{Content: "No symbols found"}, nil
		}
		lines := make([]string, len(symbols))
		for i, s := range symbols {
			lines[i] = fmt.Sprintf("%s %s at %s:%d", s.Kind, s.Name, s.Path, s.Line)
		}
		return &types.ToolResult{Content: strings.Join(lines, "\n")}, nil

	case "diagnostics":
		if filePath == "" {
			return &types.ToolResult{Content: "diagnostics requires file_path", IsError: true}, nil
		}
		diags, err := lspManager.Diagnostics(filePath)
		if err != nil {
			return &types.ToolResult{Content: fmt.Sprintf("LSP error: %s", err), IsError: true}, nil
		}
		if len(diags) == 0 {
			return &types.ToolResult{Content: "No diagnostics"}, nil
		}
		lines := make([]string, len(diags))
		for i, d := range diags {
			lines[i] = fmt.Sprintf("%s line %d: %s", d.Severity, d.Line, d.Message)
		}
		return &types.ToolResult{Content: strings.Join(lines, "\n")}, nil

	default:
		return &types.ToolResult{Content: fmt.Sprintf("Unknown LSP operation: %s", operation), IsError: true}, nil
	}
}

func formatLocations(locs []LspLocation) string {
	lines := make([]string, len(locs))
	for i, loc := range locs {
		lines[i] = fmt.Sprintf("%s:%d:%d", loc.File, loc.Line, loc.Col)
	}
	return strings.Join(lines, "\n")
}

func hasKey(m map[string]any, key string) bool {
	_, ok := m[key]
	return ok
}
