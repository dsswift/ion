package tools

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"

	"github.com/dsswift/ion/engine/internal/types"
)

// Blocked IP ranges for SSRF protection: RFC1918, link-local, loopback.
var blockedRanges = []*regexp.Regexp{
	regexp.MustCompile(`^127\.`),
	regexp.MustCompile(`^10\.`),
	regexp.MustCompile(`^172\.(1[6-9]|2[0-9]|3[01])\.`),
	regexp.MustCompile(`^192\.168\.`),
	regexp.MustCompile(`^169\.254\.`),
	regexp.MustCompile(`^0\.`),
	regexp.MustCompile(`^::1$`),
	regexp.MustCompile(`(?i)^fc00:`),
	regexp.MustCompile(`(?i)^fe80:`),
	regexp.MustCompile(`(?i)^fd`),
}

func isBlockedHost(hostname string) bool {
	for _, re := range blockedRanges {
		if re.MatchString(hostname) {
			return true
		}
	}
	if hostname == "localhost" || hostname == "0.0.0.0" || hostname == "[::]" {
		return true
	}
	return false
}

// Pre-compiled regexps for htmlToText (Go re2 does not support lookahead,
// so we use a simpler pattern that matches <script>...</script> greedily per
// occurrence).
var (
	reScript     = regexp.MustCompile(`(?is)<script[^>]*>.*?</script>`)
	reStyle      = regexp.MustCompile(`(?is)<style[^>]*>.*?</style>`)
	reBlockClose = regexp.MustCompile(`(?i)</(p|div|h[1-6]|li|tr|br\s*/?)>`)
	reBr         = regexp.MustCompile(`(?i)<br\s*/?>`)
	reTags       = regexp.MustCompile(`<[^>]+>`)
	reSpaces     = regexp.MustCompile(`[ \t]+`)
	reNewlines   = regexp.MustCompile(`\n{3,}`)
)

// htmlToText does basic HTML-to-text extraction: strips tags, decodes
// entities, normalizes whitespace.
func htmlToText(html string) string {
	text := html
	// Remove script and style blocks.
	text = reScript.ReplaceAllString(text, "")
	text = reStyle.ReplaceAllString(text, "")
	// Block elements -> newlines.
	text = reBlockClose.ReplaceAllString(text, "\n")
	text = reBr.ReplaceAllString(text, "\n")
	// Strip remaining tags.
	text = reTags.ReplaceAllString(text, "")
	// Decode common entities.
	text = strings.ReplaceAll(text, "&amp;", "&")
	text = strings.ReplaceAll(text, "&lt;", "<")
	text = strings.ReplaceAll(text, "&gt;", ">")
	text = strings.ReplaceAll(text, "&quot;", "\"")
	text = strings.ReplaceAll(text, "&#39;", "'")
	text = strings.ReplaceAll(text, "&nbsp;", " ")
	// Normalize whitespace.
	text = reSpaces.ReplaceAllString(text, " ")
	text = reNewlines.ReplaceAllString(text, "\n\n")
	return strings.TrimSpace(text)
}

// WebFetchTool returns a ToolDef that fetches content from URLs with SSRF
// protection and HTML-to-text conversion.
func WebFetchTool() *types.ToolDef {
	return &types.ToolDef{
		Name:        "WebFetch",
		Description: "Fetch content from a URL. Returns text content from web pages (HTML converted to text) or raw content for APIs. Supports GET and POST methods.",
		InputSchema: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"url":      map[string]any{"type": "string", "description": "The URL to fetch"},
				"method":   map[string]any{"type": "string", "enum": []string{"GET", "POST"}, "description": "HTTP method (default: GET)"},
				"headers":  map[string]any{"type": "object", "description": "Optional HTTP headers", "additionalProperties": map[string]any{"type": "string"}},
				"body":     map[string]any{"type": "string", "description": "Request body for POST requests"},
				"maxBytes": map[string]any{"type": "number", "description": "Max response size in bytes (default: 5MB)"},
			},
			"required": []string{"url"},
		},
		Execute: executeWebFetch,
	}
}

func executeWebFetch(ctx context.Context, input map[string]any, _ string) (*types.ToolResult, error) {
	rawURL, _ := input["url"].(string)
	if rawURL == "" {
		return &types.ToolResult{Content: "Error: url is required", IsError: true}, nil
	}

	method := stringFromInput(input, "method", "GET")
	body := stringFromInput(input, "body", "")
	maxBytes := int64(intFromInput(input, "maxBytes", 5*1024*1024))

	// Parse and validate URL.
	parsed, err := url.Parse(rawURL)
	if err != nil {
		return &types.ToolResult{Content: fmt.Sprintf("Invalid URL: %s", rawURL), IsError: true}, nil
	}

	// SSRF guard.
	if isBlockedHost(parsed.Hostname()) {
		return &types.ToolResult{
			Content: fmt.Sprintf("Blocked: cannot fetch private/reserved addresses (%s)", parsed.Hostname()),
			IsError: true,
		}, nil
	}

	// Only allow http/https.
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return &types.ToolResult{
			Content: fmt.Sprintf("Blocked: only http/https protocols allowed, got %s", parsed.Scheme),
			IsError: true,
		}, nil
	}

	// Build request.
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()

	var bodyReader io.Reader
	if body != "" && method == "POST" {
		bodyReader = strings.NewReader(body)
	}

	req, err := http.NewRequestWithContext(ctx, method, rawURL, bodyReader)
	if err != nil {
		return &types.ToolResult{Content: fmt.Sprintf("Error creating request: %s", err), IsError: true}, nil
	}

	// Apply custom headers.
	if headers, ok := input["headers"].(map[string]any); ok {
		for k, v := range headers {
			if sv, ok := v.(string); ok {
				req.Header.Set(k, sv)
			}
		}
	}

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return &types.ToolResult{Content: "Request timed out after 30s", IsError: true}, nil
		}
		return &types.ToolResult{Content: fmt.Sprintf("Fetch error: %s", err), IsError: true}, nil
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return &types.ToolResult{
			Content: fmt.Sprintf("HTTP %d: %s", resp.StatusCode, resp.Status),
			IsError: true,
		}, nil
	}

	// Read response with size limit.
	limitedReader := io.LimitReader(resp.Body, maxBytes+1)
	data, err := io.ReadAll(limitedReader)
	if err != nil {
		return &types.ToolResult{Content: fmt.Sprintf("Error reading response: %s", err), IsError: true}, nil
	}
	if int64(len(data)) > maxBytes {
		return &types.ToolResult{
			Content: fmt.Sprintf("Response too large: exceeded %d bytes", maxBytes),
			IsError: true,
		}, nil
	}

	text := string(data)

	// Convert HTML to text.
	contentType := resp.Header.Get("Content-Type")
	if strings.Contains(contentType, "text/html") {
		text = htmlToText(text)
	}

	// Truncate if still too large for context.
	if len(text) > 100000 {
		text = text[:100000] + "\n\n[Truncated: content exceeds 100K characters]"
	}

	return &types.ToolResult{Content: text}, nil
}
