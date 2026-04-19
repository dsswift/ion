package tools

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"strings"

	"github.com/dsswift/ion/engine/internal/types"
)

// notebookCell represents a single Jupyter notebook cell.
type notebookCell struct {
	CellType       string           `json:"cell_type"`
	Source          []string         `json:"source"`
	Outputs        []map[string]any `json:"outputs,omitempty"`
	Metadata       map[string]any   `json:"metadata,omitempty"`
	ExecutionCount *int             `json:"execution_count,omitempty"`
}

// notebook represents a Jupyter .ipynb file.
type notebook struct {
	Cells         []notebookCell `json:"cells"`
	Metadata      map[string]any `json:"metadata"`
	NbFormat      int            `json:"nbformat"`
	NbFormatMinor int            `json:"nbformat_minor"`
}

func parseNotebook(filePath string) (*notebook, error) {
	data, err := os.ReadFile(filePath)
	if err != nil {
		return nil, err
	}
	var nb notebook
	if err := json.Unmarshal(data, &nb); err != nil {
		return nil, err
	}
	return &nb, nil
}

func formatCell(cell notebookCell, index int) string {
	typeLabel := strings.ToUpper(cell.CellType)
	source := strings.Join(cell.Source, "")

	header := fmt.Sprintf("[%d] %s", index, typeLabel)
	if cell.ExecutionCount != nil {
		header += fmt.Sprintf(" (exec: %d)", *cell.ExecutionCount)
	}

	result := header + "\n" + source

	if len(cell.Outputs) > 0 {
		var outputTexts []string
		for _, o := range cell.Outputs {
			if text, ok := o["text"]; ok {
				outputTexts = append(outputTexts, anyToString(text))
			} else if data, ok := o["data"].(map[string]any); ok {
				if tp, ok := data["text/plain"]; ok {
					outputTexts = append(outputTexts, anyToString(tp))
				}
			} else if ename, ok := o["ename"].(string); ok {
				evalue, _ := o["evalue"].(string)
				outputTexts = append(outputTexts, ename+": "+evalue)
			}
		}
		if len(outputTexts) > 0 {
			result += "\n--- Output ---\n" + strings.Join(outputTexts, "\n")
		}
	}

	return result
}

func anyToString(v any) string {
	switch t := v.(type) {
	case string:
		return t
	case []any:
		parts := make([]string, 0, len(t))
		for _, item := range t {
			if s, ok := item.(string); ok {
				parts = append(parts, s)
			}
		}
		return strings.Join(parts, "")
	default:
		return fmt.Sprintf("%v", v)
	}
}

// splitSourceLines splits content into notebook source format (each line
// except the last gets a trailing newline).
func splitSourceLines(content string) []string {
	lines := strings.Split(content, "\n")
	result := make([]string, len(lines))
	for i, line := range lines {
		if i < len(lines)-1 {
			result[i] = line + "\n"
		} else {
			result[i] = line
		}
	}
	return result
}

// NotebookTool returns a ToolDef for reading, editing, running, adding, and
// deleting Jupyter notebook cells.
func NotebookTool() *types.ToolDef {
	return &types.ToolDef{
		Name:        "NotebookEdit",
		Description: "Read, edit, or run Jupyter notebook (.ipynb) cells. Actions: read (show cells), edit (modify cell), run (execute cell via subprocess), add (add new cell), delete (remove cell).",
		InputSchema: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"action":    map[string]any{"type": "string", "enum": []string{"read", "edit", "run", "add", "delete"}, "description": "Action to perform"},
				"path":      map[string]any{"type": "string", "description": "Path to .ipynb file"},
				"cellIndex": map[string]any{"type": "number", "description": "Cell index (0-based) for edit/run/delete"},
				"content":   map[string]any{"type": "string", "description": "New cell content for edit/add"},
				"cellType":  map[string]any{"type": "string", "enum": []string{"code", "markdown"}, "description": "Cell type for add (default: code)"},
			},
			"required": []string{"action", "path"},
		},
		Execute: executeNotebook,
	}
}

func executeNotebook(_ context.Context, input map[string]any, cwd string) (*types.ToolResult, error) {
	action, _ := input["action"].(string)
	path, _ := input["path"].(string)
	if action == "" || path == "" {
		return &types.ToolResult{Content: "Error: action and path are required", IsError: true}, nil
	}

	filePath := resolvePath(cwd, path)

	switch action {
	case "read":
		nb, err := parseNotebook(filePath)
		if err != nil {
			return &types.ToolResult{Content: fmt.Sprintf("Notebook error: %s", err), IsError: true}, nil
		}
		if len(nb.Cells) == 0 {
			return &types.ToolResult{Content: "Notebook has no cells."}, nil
		}
		parts := make([]string, len(nb.Cells))
		for i, cell := range nb.Cells {
			parts[i] = formatCell(cell, i)
		}
		return &types.ToolResult{
			Content: fmt.Sprintf("Notebook: %s (%d cells)\n\n%s", path, len(nb.Cells), strings.Join(parts, "\n\n---\n\n")),
		}, nil

	case "edit":
		cellIndex, hasIdx := input["cellIndex"]
		content, hasCont := input["content"].(string)
		if !hasIdx {
			return &types.ToolResult{Content: "cellIndex required for edit", IsError: true}, nil
		}
		if !hasCont {
			return &types.ToolResult{Content: "content required for edit", IsError: true}, nil
		}
		idx := int(toFloat64(cellIndex))

		nb, err := parseNotebook(filePath)
		if err != nil {
			return &types.ToolResult{Content: fmt.Sprintf("Notebook error: %s", err), IsError: true}, nil
		}
		if idx < 0 || idx >= len(nb.Cells) {
			return &types.ToolResult{
				Content: fmt.Sprintf("Cell index %d out of range (0-%d)", idx, len(nb.Cells)-1),
				IsError: true,
			}, nil
		}

		nb.Cells[idx].Source = splitSourceLines(content)
		return writeNotebook(filePath, nb, fmt.Sprintf("Cell %d updated.", idx))

	case "run":
		cellIndex, hasIdx := input["cellIndex"]
		if !hasIdx {
			return &types.ToolResult{Content: "cellIndex required for run", IsError: true}, nil
		}
		idx := int(toFloat64(cellIndex))

		nb, err := parseNotebook(filePath)
		if err != nil {
			return &types.ToolResult{Content: fmt.Sprintf("Notebook error: %s", err), IsError: true}, nil
		}
		if idx < 0 || idx >= len(nb.Cells) {
			return &types.ToolResult{Content: fmt.Sprintf("Cell index %d out of range", idx), IsError: true}, nil
		}

		cell := nb.Cells[idx]
		if cell.CellType != "code" {
			return &types.ToolResult{
				Content: fmt.Sprintf("Cell %d is not a code cell (type: %s)", idx, cell.CellType),
				IsError: true,
			}, nil
		}

		code := strings.Join(cell.Source, "")
		cmd := exec.Command("python3", "-c", code)
		cmd.Dir = cwd
		out, err := cmd.CombinedOutput()
		if err != nil {
			return &types.ToolResult{
				Content: fmt.Sprintf("Cell %d error:\n%s", idx, string(out)),
				IsError: true,
			}, nil
		}
		output := strings.TrimSpace(string(out))
		if output == "" {
			output = "(no output)"
		}
		return &types.ToolResult{Content: fmt.Sprintf("Cell %d output:\n%s", idx, output)}, nil

	case "add":
		content, hasCont := input["content"].(string)
		if !hasCont {
			return &types.ToolResult{Content: "content required for add", IsError: true}, nil
		}

		cellType := stringFromInput(input, "cellType", "code")

		nb, err := parseNotebook(filePath)
		if err != nil {
			return &types.ToolResult{Content: fmt.Sprintf("Notebook error: %s", err), IsError: true}, nil
		}

		newCell := notebookCell{
			CellType: cellType,
			Source:   splitSourceLines(content),
			Metadata: map[string]any{},
			Outputs:  []map[string]any{},
		}

		insertIdx := len(nb.Cells)
		if ci, ok := input["cellIndex"]; ok {
			idx := int(toFloat64(ci))
			if idx >= 0 && idx <= len(nb.Cells) {
				// Insert at position.
				nb.Cells = append(nb.Cells, notebookCell{})
				copy(nb.Cells[idx+1:], nb.Cells[idx:])
				nb.Cells[idx] = newCell
				insertIdx = idx
			} else {
				nb.Cells = append(nb.Cells, newCell)
			}
		} else {
			nb.Cells = append(nb.Cells, newCell)
		}

		return writeNotebook(filePath, nb, fmt.Sprintf("Cell added at index %d.", insertIdx))

	case "delete":
		cellIndex, hasIdx := input["cellIndex"]
		if !hasIdx {
			return &types.ToolResult{Content: "cellIndex required for delete", IsError: true}, nil
		}
		idx := int(toFloat64(cellIndex))

		nb, err := parseNotebook(filePath)
		if err != nil {
			return &types.ToolResult{Content: fmt.Sprintf("Notebook error: %s", err), IsError: true}, nil
		}
		if idx < 0 || idx >= len(nb.Cells) {
			return &types.ToolResult{
				Content: fmt.Sprintf("Cell index %d out of range", idx),
				IsError: true,
			}, nil
		}

		nb.Cells = append(nb.Cells[:idx], nb.Cells[idx+1:]...)
		return writeNotebook(filePath, nb, fmt.Sprintf("Cell %d deleted. %d cells remaining.", idx, len(nb.Cells)))

	default:
		return &types.ToolResult{Content: fmt.Sprintf("Unknown action: %s", action), IsError: true}, nil
	}
}

func writeNotebook(filePath string, nb *notebook, msg string) (*types.ToolResult, error) {
	data, err := json.MarshalIndent(nb, "", " ")
	if err != nil {
		return &types.ToolResult{Content: fmt.Sprintf("Notebook error: %s", err), IsError: true}, nil
	}
	if err := os.WriteFile(filePath, data, 0o644); err != nil {
		return &types.ToolResult{Content: fmt.Sprintf("Notebook error: %s", err), IsError: true}, nil
	}
	return &types.ToolResult{Content: msg}, nil
}

func toFloat64(v any) float64 {
	switch n := v.(type) {
	case float64:
		return n
	case int:
		return float64(n)
	case int64:
		return float64(n)
	default:
		return 0
	}
}
