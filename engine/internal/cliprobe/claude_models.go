package cliprobe

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// The `claude` CLI exposes no machine-readable model-list command (unlike codex
// `app-server` ModelListAll or the ACP session model state). For a subscription
// login (claude.ai OAuth, no API key) the engine therefore has no live source
// for the Anthropic model list — HTTP /models discovery is skipped for a
// CLI-backed provider, and the probe advertised nothing, so ListModels fell back
// to the stale embedded catalog. The fix: read the OAuth access token the CLI
// stored and query Anthropic's own /v1/models with it, exactly the list the
// account can actually use. The token is READ ONLY — never refreshed or written
// here, because a refresh rotates the single-use grant the CLI owns.

// claudeModelsBaseURL is the Anthropic API host. A package var so a test can
// point the fetch at an httptest server instead of the live API.
var claudeModelsBaseURL = "https://api.anthropic.com"

// readClaudeOAuthToken returns the CLI's stored OAuth access token and its
// expiry (Unix ms, 0 when unknown). A package var so tests inject a token
// without touching the keychain or the network.
var readClaudeOAuthToken = readClaudeOAuthTokenImpl

// claudeModelsProbe fetches the live Anthropic model list for a subscription
// login. A package var so the probe path can be exercised without network in
// tests, and so callers that must stay hermetic can stub it to a no-op.
var claudeModelsProbe = fetchClaudeSubscriptionModels

// claudeCredFile is the shape of the CLI's stored credential. Only the fields
// the fetch needs are declared; the CLI may write more.
type claudeCredFile struct {
	ClaudeAiOauth struct {
		AccessToken string `json:"accessToken"`
		ExpiresAt   int64  `json:"expiresAt"`
	} `json:"claudeAiOauth"`
}

// parseClaudeCred extracts the access token and expiry from the CLI credential
// JSON. Returns ok=false when the payload has no usable token.
func parseClaudeCred(b []byte) (token string, expiresAtMs int64, ok bool) {
	var c claudeCredFile
	if err := json.Unmarshal(b, &c); err != nil {
		return "", 0, false
	}
	if c.ClaudeAiOauth.AccessToken == "" {
		return "", 0, false
	}
	return c.ClaudeAiOauth.AccessToken, c.ClaudeAiOauth.ExpiresAt, true
}

// readClaudeOAuthTokenImpl resolves the CLI's OAuth token. The file store
// (~/.claude/.credentials.json) is checked first because it is the cross-platform
// location and needs no keychain access; on darwin, where the CLI keeps the
// credential in the login keychain instead, it falls back to `security`. Any
// failure returns an error so the caller falls open to the embedded catalog.
func readClaudeOAuthTokenImpl() (string, int64, error) {
	if home, err := os.UserHomeDir(); err == nil {
		path := filepath.Join(home, ".claude", ".credentials.json")
		if b, err := os.ReadFile(path); err == nil {
			if token, exp, ok := parseClaudeCred(b); ok {
				return token, exp, nil
			}
		}
	}
	if runtime.GOOS == "darwin" {
		ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
		defer cancel()
		out, err := exec.CommandContext(ctx, "security", "find-generic-password", "-s", "Claude Code-credentials", "-w").Output()
		if err != nil {
			return "", 0, fmt.Errorf("read claude keychain credential: %w", err)
		}
		if token, exp, ok := parseClaudeCred(out); ok {
			return token, exp, nil
		}
		return "", 0, fmt.Errorf("claude keychain credential has no access token")
	}
	return "", 0, fmt.Errorf("no claude oauth credential found")
}

// claudeCap is the {"supported": bool} shape Anthropic uses for every
// capability leaf in the /v1/models payload.
type claudeCap struct {
	Supported bool `json:"supported"`
}

// claudeModelWire is one entry of Anthropic's /v1/models response. It is a
// richer shape than the OpenAI-style list the generic discovery path decodes,
// so it is decoded here with the field names Anthropic actually emits.
type claudeModelWire struct {
	ID             string `json:"id"`
	MaxInputTokens int    `json:"max_input_tokens"`
	MaxTokens      int    `json:"max_tokens"`
	Capabilities   struct {
		ImageInput claudeCap `json:"image_input"`
		Thinking   struct {
			Supported bool `json:"supported"`
			Types     struct {
				Adaptive claudeCap `json:"adaptive"`
				Enabled  claudeCap `json:"enabled"`
			} `json:"types"`
		} `json:"thinking"`
		Effort struct {
			Low    claudeCap `json:"low"`
			Medium claudeCap `json:"medium"`
			High   claudeCap `json:"high"`
			XHigh  claudeCap `json:"xhigh"`
			Max    claudeCap `json:"max"`
		} `json:"effort"`
	} `json:"capabilities"`
}

// claudeModelToEntry maps one Anthropic model to a ModelEntry. Cost, tokenizer,
// and cache pricing are deliberately left zero: ListModels enriches known ids
// from the embedded catalog (fill-if-zero), and a subscription run is billed by
// plan, not per-token, so a new model with no catalog entry still surfaces
// correctly with its real context window and capabilities.
func claudeModelToEntry(m claudeModelWire) types.ModelEntry {
	entry := types.ModelEntry{
		ID:               m.ID,
		ProviderID:       "anthropic",
		ContextWindow:    m.MaxInputTokens,
		MaxOutputTokens:  m.MaxTokens,
		SupportsImages:   m.Capabilities.ImageInput.Supported,
		SupportsThinking: m.Capabilities.Thinking.Supported,
	}
	if m.Capabilities.Thinking.Supported {
		if m.Capabilities.Thinking.Types.Adaptive.Supported {
			entry.ThinkingMode = "adaptive"
		} else {
			entry.ThinkingMode = "enabled"
		}
	}
	efforts := make([]string, 0, 5)
	for _, e := range []struct {
		name string
		cap  claudeCap
	}{
		{"low", m.Capabilities.Effort.Low},
		{"medium", m.Capabilities.Effort.Medium},
		{"high", m.Capabilities.Effort.High},
		{"xhigh", m.Capabilities.Effort.XHigh},
		{"max", m.Capabilities.Effort.Max},
	} {
		if e.cap.Supported {
			efforts = append(efforts, e.name)
		}
	}
	if len(efforts) > 0 {
		entry.ThinkingEfforts = efforts
	}
	return entry
}

// fetchClaudeSubscriptionModels queries Anthropic's /v1/models with the CLI's
// OAuth token and returns the account's live model list. Returns an error (and
// no entries) on a missing/expired token or any non-200 response, so the caller
// falls open to the embedded catalog rather than showing an empty picker.
func fetchClaudeSubscriptionModels(ctx context.Context) ([]types.ModelEntry, error) {
	token, expMs, err := readClaudeOAuthToken()
	if err != nil {
		return nil, err
	}
	if expMs > 0 && time.Now().UnixMilli() >= expMs {
		// The CLI refreshes the token on its own next use; a re-probe picks up
		// the fresh one. We never refresh here — that would rotate a grant we
		// do not own.
		return nil, fmt.Errorf("claude oauth token expired")
	}

	url := strings.TrimRight(claudeModelsBaseURL, "/") + "/v1/models?limit=1000"
	req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
	if err != nil {
		return nil, err
	}
	// Subscription tokens authenticate as a Bearer credential; the x-api-key
	// path the generic Anthropic discovery uses returns 401 for an OAuth token.
	req.Header.Set("authorization", "Bearer "+token)
	req.Header.Set("anthropic-version", "2023-06-01")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("http error: %w", err)
	}
	defer func() { _ = resp.Body.Close() }() //nolint:errcheck // resource close
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("status %d", resp.StatusCode)
	}

	var result struct {
		Data []claudeModelWire `json:"data"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, fmt.Errorf("decode error: %w", err)
	}
	entries := make([]types.ModelEntry, 0, len(result.Data))
	for _, m := range result.Data {
		if m.ID == "" {
			continue
		}
		entries = append(entries, claudeModelToEntry(m))
	}
	utils.LogWithFields(utils.LevelInfo, "cliprobe", "claude-code models fetched from anthropic /v1/models", map[string]any{"count": len(entries)})
	return entries, nil
}
