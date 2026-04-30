package tools

import (
	"context"
	"fmt"
	"os"
	"strings"
	"unicode"

	"github.com/dsswift/ion/engine/internal/types"
	"golang.org/x/text/unicode/norm"
)

// EditTool returns a ToolDef that replaces string matches in a file.
// Two-phase: exact match first, then fuzzy (NFKC normalization, smart quotes,
// unicode dashes, special spaces, trailing whitespace).
func EditTool() *types.ToolDef {
	return &types.ToolDef{
		Name:        "Edit",
		Description: "Replace string matches in a file. Supports exact match and fuzzy matching (Unicode normalization for smart quotes, dashes, special spaces).",
		InputSchema: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"file_path":   map[string]any{"type": "string", "description": "Absolute path to file"},
				"old_string":  map[string]any{"type": "string", "description": "String to find and replace"},
				"new_string":  map[string]any{"type": "string", "description": "Replacement string"},
				"replace_all": map[string]any{"type": "boolean", "description": "Replace all occurrences (default: false)"},
			},
			"required": []string{"file_path", "old_string", "new_string"},
		},
		Execute: executeEdit,
	}
}

// NormalizeForFuzzyMatch applies NFKC normalization, smart quote replacement,
// unicode dash normalization, special space normalization, and per-line
// trailing whitespace trimming.
func NormalizeForFuzzyMatch(text string) string {
	// NFKC normalization
	result := norm.NFKC.String(text)

	// Smart quotes -> ASCII
	result = replaceRunes(result, map[rune]rune{
		'\u2018': '\'', '\u2019': '\'', '\u201A': '\'', '\u2039': '\'', '\u203A': '\'',
		'\u201C': '"', '\u201D': '"', '\u201E': '"', '\u00AB': '"', '\u00BB': '"',
	})

	// Unicode dashes -> hyphen
	result = replaceRunes(result, map[rune]rune{
		'\u2013': '-', '\u2014': '-', '\u2015': '-',
		'\u2212': '-', '\u2010': '-', '\u2011': '-',
	})

	// Special spaces -> regular space
	specialSpaces := map[rune]bool{
		'\u00A0': true, '\u2000': true, '\u2001': true, '\u2002': true,
		'\u2003': true, '\u2004': true, '\u2005': true, '\u2006': true,
		'\u2007': true, '\u2008': true, '\u2009': true, '\u200A': true,
		'\u202F': true, '\u205F': true,
	}
	var sb strings.Builder
	for _, r := range result {
		if specialSpaces[r] {
			sb.WriteRune(' ')
		} else {
			sb.WriteRune(r)
		}
	}
	result = sb.String()

	// Per-line trailing whitespace trim
	lines := strings.Split(result, "\n")
	for i, line := range lines {
		lines[i] = strings.TrimRightFunc(line, unicode.IsSpace)
	}
	result = strings.Join(lines, "\n")

	return result
}

func replaceRunes(s string, m map[rune]rune) string {
	var sb strings.Builder
	sb.Grow(len(s))
	for _, r := range s {
		if replacement, ok := m[r]; ok {
			sb.WriteRune(replacement)
		} else {
			sb.WriteRune(r)
		}
	}
	return sb.String()
}

func executeEdit(ctx context.Context, input map[string]any, cwd string) (*types.ToolResult, error) {
	filePath, _ := input["file_path"].(string)
	if filePath == "" {
		return &types.ToolResult{Content: "Error: file_path is required", IsError: true}, nil
	}
	oldString, _ := input["old_string"].(string)
	newString, _ := input["new_string"].(string)
	replaceAll := boolFromInput(input, "replace_all", false)

	filePath = resolvePath(cwd, filePath)

	if err := ctx.Err(); err != nil {
		return &types.ToolResult{Content: "Error: Edit cancelled.", IsError: true}, nil
	}
	data, err := os.ReadFile(filePath)
	if err != nil {
		return &types.ToolResult{Content: fmt.Sprintf("Error editing file: %s", err), IsError: true}, nil
	}
	content := string(data)

	// Phase 1: exact match
	if strings.Contains(content, oldString) {
		if !replaceAll {
			count := strings.Count(content, oldString)
			if count > 1 {
				return &types.ToolResult{
					Content: fmt.Sprintf("Error: old_string found %d times. Use replace_all or provide more context.", count),
					IsError: true,
				}, nil
			}
		}

		var updated string
		if replaceAll {
			updated = strings.ReplaceAll(content, oldString, newString)
		} else {
			updated = strings.Replace(content, oldString, newString, 1)
		}

		if err := os.WriteFile(filePath, []byte(updated), 0o644); err != nil {
			return &types.ToolResult{Content: fmt.Sprintf("Error editing file: %s", err), IsError: true}, nil
		}
		return &types.ToolResult{Content: fmt.Sprintf("Successfully edited %s", filePath)}, nil
	}

	// Phase 2: fuzzy match (normalize both sides)
	normalizedContent := NormalizeForFuzzyMatch(content)
	normalizedSearch := NormalizeForFuzzyMatch(oldString)

	if strings.Contains(normalizedContent, normalizedSearch) {
		if !replaceAll {
			count := strings.Count(normalizedContent, normalizedSearch)
			if count > 1 {
				return &types.ToolResult{
					Content: fmt.Sprintf("Error: old_string found %d times (via fuzzy match). Use replace_all or provide more context.", count),
					IsError: true,
				}, nil
			}
		}

		var updated string
		if replaceAll {
			updated = strings.ReplaceAll(normalizedContent, normalizedSearch, newString)
		} else {
			updated = strings.Replace(normalizedContent, normalizedSearch, newString, 1)
		}

		if err := os.WriteFile(filePath, []byte(updated), 0o644); err != nil {
			return &types.ToolResult{Content: fmt.Sprintf("Error editing file: %s", err), IsError: true}, nil
		}
		return &types.ToolResult{Content: fmt.Sprintf("Successfully edited %s (fuzzy match: Unicode normalization applied)", filePath)}, nil
	}

	return &types.ToolResult{Content: fmt.Sprintf("Error: old_string not found in %s", filePath), IsError: true}, nil
}
