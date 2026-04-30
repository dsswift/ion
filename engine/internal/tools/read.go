package tools

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/dsswift/ion/engine/internal/pdf"
	"github.com/dsswift/ion/engine/internal/types"
)

// ReadTool returns a ToolDef that reads file content with line numbers (cat -n format).
func ReadTool() *types.ToolDef {
	return &types.ToolDef{
		Name:        "Read",
		Description: "Read a file from the filesystem. Returns file content with line numbers.",
		InputSchema: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"file_path": map[string]any{"type": "string", "description": "Absolute path to file"},
				"offset":    map[string]any{"type": "number", "description": "Line number to start from (1-based)"},
				"limit":     map[string]any{"type": "number", "description": "Max lines to read"},
				"pages":     map[string]any{"type": "string", "description": "Page range for PDF files (e.g. \"1-5\", \"3\"). Max 20 pages per request."},
			},
			"required": []string{"file_path"},
		},
		Execute: executeRead,
	}
}

func executeRead(ctx context.Context, input map[string]any, cwd string) (*types.ToolResult, error) {
	filePath, _ := input["file_path"].(string)
	if filePath == "" {
		return &types.ToolResult{Content: "Error: file_path is required", IsError: true}, nil
	}

	filePath = resolvePath(cwd, filePath)

	if err := ctx.Err(); err != nil {
		return &types.ToolResult{Content: "Error: Read cancelled.", IsError: true}, nil
	}

	info, err := os.Stat(filePath)
	if err != nil {
		return &types.ToolResult{Content: fmt.Sprintf("Error reading file: %s", err), IsError: true}, nil
	}
	if info.IsDir() {
		return &types.ToolResult{Content: fmt.Sprintf("Error: %s is a directory, not a file", filePath), IsError: true}, nil
	}

	// PDF files: validate and extract pages or encode as base64
	if strings.EqualFold(filepath.Ext(filePath), ".pdf") {
		return readPdf(filePath, input, info)
	}

	if err := ctx.Err(); err != nil {
		return &types.ToolResult{Content: "Error: Read cancelled.", IsError: true}, nil
	}
	data, err := os.ReadFile(filePath)
	if err != nil {
		return &types.ToolResult{Content: fmt.Sprintf("Error reading file: %s", err), IsError: true}, nil
	}

	lines := strings.Split(string(data), "\n")

	offset := intFromInput(input, "offset", 1) - 1
	if offset < 0 {
		offset = 0
	}
	limit := intFromInput(input, "limit", len(lines))

	if offset > len(lines) {
		offset = len(lines)
	}
	end := offset + limit
	if end > len(lines) {
		end = len(lines)
	}

	slice := lines[offset:end]
	numbered := make([]string, len(slice))
	for i, line := range slice {
		numbered[i] = fmt.Sprintf("%6d\t%s", offset+i+1, line)
	}

	return &types.ToolResult{Content: strings.Join(numbered, "\n")}, nil
}

// resolvePath resolves a potentially relative path against cwd.
func resolvePath(cwd, path string) string {
	if filepath.IsAbs(path) {
		return path
	}
	return filepath.Join(cwd, path)
}

// intFromInput extracts an integer from a map[string]any, with a default value.
// Handles both float64 (from JSON) and int types.
func intFromInput(input map[string]any, key string, defaultVal int) int {
	v, ok := input[key]
	if !ok {
		return defaultVal
	}
	switch n := v.(type) {
	case float64:
		return int(n)
	case int:
		return n
	case int64:
		return int(n)
	default:
		return defaultVal
	}
}

// stringFromInput extracts a string from a map[string]any, with a default.
func stringFromInput(input map[string]any, key string, defaultVal string) string {
	v, ok := input[key]
	if !ok {
		return defaultVal
	}
	if s, ok := v.(string); ok {
		return s
	}
	return defaultVal
}

// boolFromInput extracts a bool from a map[string]any, with a default.
func boolFromInput(input map[string]any, key string, defaultVal bool) bool {
	v, ok := input[key]
	if !ok {
		return defaultVal
	}
	if b, ok := v.(bool); ok {
		return b
	}
	return defaultVal
}

// maxPdfSizeForBase64 is the max file size (10 MB) for base64-encoding an
// entire PDF when no page range is specified.
const maxPdfSizeForBase64 = 10 * 1024 * 1024

// readPdf handles PDF file reads: validates, then extracts pages or encodes.
func readPdf(filePath string, input map[string]any, info os.FileInfo) (*types.ToolResult, error) {
	if err := pdf.ValidatePdf(filePath); err != nil {
		return &types.ToolResult{Content: fmt.Sprintf("Error: %s", err), IsError: true}, nil
	}

	pages := stringFromInput(input, "pages", "")
	if pages != "" {
		extracted, err := pdf.ExtractPdfPages(filePath, pages)
		if err != nil {
			return &types.ToolResult{Content: fmt.Sprintf("Error extracting PDF pages: %s", err), IsError: true}, nil
		}
		if len(extracted) == 0 {
			return &types.ToolResult{Content: "No pages extracted from PDF"}, nil
		}
		var sb strings.Builder
		for i, page := range extracted {
			if i > 0 {
				sb.WriteString("\n---\n")
			}
			sb.WriteString(fmt.Sprintf("[Page %d image (base64 PNG)]\n%s", i+1, page))
		}
		return &types.ToolResult{Content: sb.String()}, nil
	}

	// No pages specified: encode whole file if small enough
	if info.Size() > maxPdfSizeForBase64 {
		return &types.ToolResult{
			Content: fmt.Sprintf("Error: PDF is %d bytes (max %d for full encoding). Specify a page range with the 'pages' parameter.", info.Size(), maxPdfSizeForBase64),
			IsError: true,
		}, nil
	}

	encoded, err := pdf.EncodePdf(filePath)
	if err != nil {
		return &types.ToolResult{Content: fmt.Sprintf("Error encoding PDF: %s", err), IsError: true}, nil
	}
	return &types.ToolResult{Content: fmt.Sprintf("[PDF base64 encoded, %d bytes]\n%s", info.Size(), encoded)}, nil
}
