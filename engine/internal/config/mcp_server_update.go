package config

// mcp_server_update.go — edit one existing mcpServers entry in place.
//
// Add replaces a whole entry, which is right for a new server and wrong for an
// edit: a consumer that only knows the fields it shows would silently drop the
// rest (headers, env, timeouts, token forwarding). Update patches the raw
// decoded entry instead, touching only the keys the patch names, so everything
// else in the entry survives byte-for-byte.

import (
	"encoding/json"
	"fmt"
	"reflect"
	"time"

	"github.com/dsswift/ion/engine/internal/durablefile"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// McpServerPatch names the changes to one server. Empty strings and a nil
// slice or pointer mean "leave as is".
type McpServerPatch struct {
	// Transport, when set, replaces the entry's type.
	Transport string
	// URL, when set, makes the entry a network server at this endpoint and
	// drops any command and args.
	URL string
	// Command, when set, makes the entry a stdio server and drops any url.
	Command string
	// Args, when non-nil, replaces the stdio arguments; an empty slice clears
	// them.
	Args []string
	// OAuth, when non-nil, replaces the operator-configured OAuth client.
	OAuth *McpOAuthPatch
}

// McpOAuthPatch is the complete set of OAuth client settings a consumer edits.
// An empty string removes that setting, leaving it to discovery. Keys the patch
// does not cover (redirect_uri, client_metadata_uri, unknown keys) are kept.
type McpOAuthPatch struct {
	ClientID string
	// ClientSecret is nil to keep the stored secret, empty to remove it, or the
	// new secret. A consumer never sees the stored value, so "keep" must be
	// expressible without sending it back.
	ClientSecret *string
	AuthURL      string
	TokenURL     string
	Scope        string
	Resource     string
}

// McpServerUpdate reports what an update did.
type McpServerUpdate struct {
	// Changed is false when the patch matched what was already stored; nothing
	// was written.
	Changed bool
	// CredentialsInvalidated is true when the url or the OAuth client changed.
	// A stored token was minted for the old client and resource, so it no
	// longer applies.
	CredentialsInvalidated bool
}

// UpdateMcpServer applies a patch to a server already in ~/.ion/engine.json.
// A server defined only in a project config is not editable here: the error
// says so rather than creating a global entry that would shadow it.
func UpdateMcpServer(name string, patch McpServerPatch) (McpServerUpdate, error) {
	var result McpServerUpdate
	if patch.URL != "" && patch.Command != "" {
		return result, fmt.Errorf("an MCP server takes a url or a command, not both")
	}

	path := globalConfigPath()
	err := durablefile.Transaction(path, 5*time.Second, func(_ string) error {
		raw, err := readRawConfig(path)
		if err != nil {
			return err
		}
		servers, _ := raw["mcpServers"].(map[string]any) //nolint:errcheck // missing/non-map handled below
		entry, ok := servers[name].(map[string]any)
		if !ok {
			return fmt.Errorf("MCP server %q is not configured in %s", name, path)
		}

		dropEmptyOAuthKeys(entry)
		before, err := cloneJSONMap(entry)
		if err != nil {
			return fmt.Errorf("read MCP server %q: %w", name, err)
		}
		applyTransportPatch(entry, patch)
		applyOAuthPatch(entry, patch.OAuth)
		after, err := cloneJSONMap(entry)
		if err != nil {
			return fmt.Errorf("encode MCP server %q: %w", name, err)
		}

		cfg, err := decodeMcpServerEntry(after)
		if err != nil {
			return fmt.Errorf("MCP server %q: %w", name, err)
		}
		if err := NormalizeMcpServerConfig(&cfg); err != nil {
			return err
		}
		if err := CheckMcpServerAllowed(name, cfg); err != nil {
			return err
		}

		result.Changed = !reflect.DeepEqual(before, after)
		result.CredentialsInvalidated = !reflect.DeepEqual(before["url"], after["url"]) ||
			!reflect.DeepEqual(before["oauth"], after["oauth"])
		if !result.Changed {
			utils.LogWithFields(utils.LevelInfo, "config", "mcp server update matched stored entry; nothing written", map[string]any{"server": name, "path": path})
			return nil
		}

		servers[name] = after
		raw["mcpServers"] = servers
		if err := writeRawConfig(path, raw); err != nil {
			return err
		}
		utils.LogWithFields(utils.LevelInfo, "config", "mcp server updated in engine.json", map[string]any{
			"server": name, "path": path, "transport": cfg.Type, "url": cfg.URL, "command": cfg.Command,
			"oauth_configured": cfg.OAuth != nil, "credentials_invalidated": result.CredentialsInvalidated,
		})
		return nil
	})
	return result, err
}

func applyTransportPatch(entry map[string]any, patch McpServerPatch) {
	switch {
	case patch.URL != "":
		entry["url"] = patch.URL
		delete(entry, "command")
		delete(entry, "args")
		if entry["type"] == "stdio" {
			entry["type"] = "http"
		}
	case patch.Command != "":
		entry["command"] = patch.Command
		delete(entry, "url")
		entry["type"] = "stdio"
	}
	if patch.Args != nil {
		if len(patch.Args) == 0 {
			delete(entry, "args")
		} else {
			entry["args"] = patch.Args
		}
	}
	if patch.Transport != "" {
		entry["type"] = patch.Transport
	}
}

func applyOAuthPatch(entry map[string]any, patch *McpOAuthPatch) {
	if patch == nil {
		return
	}
	oauth, _ := entry["oauth"].(map[string]any) //nolint:errcheck // absent or malformed block starts fresh
	if oauth == nil {
		oauth = make(map[string]any)
	}
	setOrDelete(oauth, "client_id", patch.ClientID)
	setOrDelete(oauth, "auth_url", patch.AuthURL)
	setOrDelete(oauth, "token_url", patch.TokenURL)
	setOrDelete(oauth, "scope", patch.Scope)
	setOrDelete(oauth, "resource", patch.Resource)
	if patch.ClientSecret != nil {
		setOrDelete(oauth, "client_secret", *patch.ClientSecret)
	}
	if len(oauth) == 0 {
		delete(entry, "oauth")
		return
	}
	entry["oauth"] = oauth
}

// oauthPatchKeys are the oauth keys a patch manages.
var oauthPatchKeys = []string{"client_id", "client_secret", "auth_url", "token_url", "scope", "resource"}

// dropEmptyOAuthKeys removes managed oauth keys stored as "". Add writes the
// typed struct, whose endpoint fields have no omitempty, so an entry can carry
// "auth_url": "" that means the same as an absent key. Without this, an edit
// that changes nothing would read as a change and clear the stored token.
func dropEmptyOAuthKeys(entry map[string]any) {
	oauth, _ := entry["oauth"].(map[string]any) //nolint:errcheck // absent or malformed block has nothing to drop
	for _, key := range oauthPatchKeys {
		if oauth[key] == "" {
			delete(oauth, key)
		}
	}
}

func setOrDelete(m map[string]any, key, value string) {
	if value == "" {
		delete(m, key)
		return
	}
	m[key] = value
}

// cloneJSONMap deep-copies a decoded JSON object through a marshal round trip,
// which also normalizes Go-typed values ([]string) to their decoded form
// ([]any) so two maps compare equal when their JSON does.
func cloneJSONMap(m map[string]any) (map[string]any, error) {
	data, err := json.Marshal(m)
	if err != nil {
		return nil, err
	}
	var out map[string]any
	if err := json.Unmarshal(data, &out); err != nil {
		return nil, err
	}
	return out, nil
}

func decodeMcpServerEntry(entry map[string]any) (types.McpServerConfig, error) {
	var cfg types.McpServerConfig
	data, err := json.Marshal(entry)
	if err != nil {
		return cfg, err
	}
	if err := json.Unmarshal(data, &cfg); err != nil {
		return cfg, fmt.Errorf("stored entry does not decode: %w", err)
	}
	return cfg, nil
}
