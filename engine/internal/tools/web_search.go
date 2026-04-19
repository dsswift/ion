package tools

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"

	"github.com/dsswift/ion/engine/internal/types"
)

// SearchResult is a single web search result.
type SearchResult struct {
	Title   string `json:"title"`
	URL     string `json:"url"`
	Snippet string `json:"snippet"`
}

// SearchBackend is a pluggable web search provider.
type SearchBackend interface {
	Search(query string, maxResults int) ([]SearchResult, error)
}

// BraveSearchBackend uses the Brave Search API.
type BraveSearchBackend struct {
	APIKey string
}

func (b *BraveSearchBackend) Search(query string, maxResults int) ([]SearchResult, error) {
	u := fmt.Sprintf("https://api.search.brave.com/res/v1/web/search?q=%s&count=%d",
		url.QueryEscape(query), maxResults)

	req, err := http.NewRequest("GET", u, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("X-Subscription-Token", b.APIKey)
	req.Header.Set("Accept", "application/json")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("Brave Search API error: %d", resp.StatusCode)
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}

	var data struct {
		Web struct {
			Results []struct {
				Title       string `json:"title"`
				URL         string `json:"url"`
				Description string `json:"description"`
			} `json:"results"`
		} `json:"web"`
	}
	if err := json.Unmarshal(body, &data); err != nil {
		return nil, err
	}

	results := make([]SearchResult, 0, len(data.Web.Results))
	for _, r := range data.Web.Results {
		results = append(results, SearchResult{
			Title:   r.Title,
			URL:     r.URL,
			Snippet: r.Description,
		})
	}
	return results, nil
}

// TavilyBackend uses the Tavily search API.
type TavilyBackend struct {
	APIKey string
}

func (t *TavilyBackend) Search(query string, maxResults int) ([]SearchResult, error) {
	payload, _ := json.Marshal(map[string]any{
		"api_key":     t.APIKey,
		"query":       query,
		"max_results": maxResults,
	})

	resp, err := http.Post("https://api.tavily.com/search", "application/json", strings.NewReader(string(payload)))
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("Tavily API error: %d", resp.StatusCode)
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}

	var data struct {
		Results []struct {
			Title   string `json:"title"`
			URL     string `json:"url"`
			Content string `json:"content"`
		} `json:"results"`
	}
	if err := json.Unmarshal(body, &data); err != nil {
		return nil, err
	}

	results := make([]SearchResult, 0, len(data.Results))
	for _, r := range data.Results {
		results = append(results, SearchResult{
			Title:   r.Title,
			URL:     r.URL,
			Snippet: r.Content,
		})
	}
	return results, nil
}

// SearXNGBackend uses a self-hosted SearXNG instance.
type SearXNGBackend struct {
	BaseURL string
}

func (s *SearXNGBackend) Search(query string, maxResults int) ([]SearchResult, error) {
	u := fmt.Sprintf("%s/search?q=%s&format=json&pageno=1",
		s.BaseURL, url.QueryEscape(query))

	resp, err := http.Get(u)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("SearXNG error: %d", resp.StatusCode)
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}

	var data struct {
		Results []struct {
			Title   string `json:"title"`
			URL     string `json:"url"`
			Content string `json:"content"`
		} `json:"results"`
	}
	if err := json.Unmarshal(body, &data); err != nil {
		return nil, err
	}

	results := make([]SearchResult, 0, len(data.Results))
	for i, r := range data.Results {
		if i >= maxResults {
			break
		}
		results = append(results, SearchResult{
			Title:   r.Title,
			URL:     r.URL,
			Snippet: r.Content,
		})
	}
	return results, nil
}

// resolveSearchBackend picks a backend from environment variables.
// Priority: BRAVE_SEARCH_API_KEY > TAVILY_API_KEY > SEARXNG_URL.
func resolveSearchBackend() SearchBackend {
	if key := os.Getenv("BRAVE_SEARCH_API_KEY"); key != "" {
		return &BraveSearchBackend{APIKey: key}
	}
	if key := os.Getenv("TAVILY_API_KEY"); key != "" {
		return &TavilyBackend{APIKey: key}
	}
	if u := os.Getenv("SEARXNG_URL"); u != "" {
		return &SearXNGBackend{BaseURL: u}
	}
	return nil
}

// WebSearchTool returns a ToolDef that searches the web using a pluggable
// backend (Brave, Tavily, or SearXNG).
func WebSearchTool() *types.ToolDef {
	return &types.ToolDef{
		Name:        "WebSearch",
		Description: "Search the web for information. Requires one of: BRAVE_SEARCH_API_KEY, TAVILY_API_KEY, or SEARXNG_URL environment variable.",
		InputSchema: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"query":      map[string]any{"type": "string", "description": "Search query"},
				"maxResults": map[string]any{"type": "number", "description": "Maximum number of results (default: 5)"},
			},
			"required": []string{"query"},
		},
		Execute: executeWebSearch,
	}
}

func executeWebSearch(_ context.Context, input map[string]any, _ string) (*types.ToolResult, error) {
	query, _ := input["query"].(string)
	if query == "" {
		return &types.ToolResult{Content: "Error: query is required", IsError: true}, nil
	}

	maxResults := intFromInput(input, "maxResults", 5)

	backend := resolveSearchBackend()
	if backend == nil {
		return &types.ToolResult{
			Content: "No search backend configured. Set one of: BRAVE_SEARCH_API_KEY, TAVILY_API_KEY, or SEARXNG_URL",
			IsError: true,
		}, nil
	}

	results, err := backend.Search(query, maxResults)
	if err != nil {
		return &types.ToolResult{Content: fmt.Sprintf("Search error: %s", err), IsError: true}, nil
	}

	if len(results) == 0 {
		return &types.ToolResult{Content: fmt.Sprintf("No results found for: %s", query)}, nil
	}

	var sb strings.Builder
	for i, r := range results {
		if i > 0 {
			sb.WriteString("\n\n")
		}
		fmt.Fprintf(&sb, "%d. **%s**\n   %s\n   %s", i+1, r.Title, r.URL, r.Snippet)
	}

	return &types.ToolResult{Content: sb.String()}, nil
}
