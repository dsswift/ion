package server

import (
	"context"
	"fmt"
	"net"
	"path/filepath"
	"sort"

	ionconfig "github.com/dsswift/ion/engine/internal/config"
	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/protocol"
	"github.com/dsswift/ion/engine/internal/providers"
	"github.com/dsswift/ion/engine/internal/titling"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// dispatch_data.go owns the dispatch arms for the data-oriented client
// commands — title generation, conversation migration between Ion and
// Claude Code formats, model listing, and credential storage. These arms
// were extracted from server.go's dispatch() to keep that god-file under
// the 800-line cap; the split is by command family, not by line count.
//
// Contract reminders for anyone touching this file:
//
//   - Every arm MUST call s.sendResult exactly once before returning,
//     even on goroutine-async paths. The server's RPC contract is
//     request/response — a missing response leaves the client waiting
//     indefinitely.
//
//   - Long-running work (LLM calls, file I/O against large
//     conversations) stays in the process command lane. The outer dispatch
//     recovery guard catches panics and the dispatch lifecycle owns the one
//     result and timeout for the full request.
//
//   - These arms are called from server.dispatch() and have access to
//     the same fields (s.config, s.authResolver, s.manager) via the
//     receiver. No new state is introduced; this file is mechanical
//     extraction only.

// dispatchGenerateTitle runs the LLM-backed title generation in a
// goroutine and surfaces the result via sendResult. Runs async because
// the LLM call can take a couple of seconds and we don't want to block
// the client's read loop while it's in flight.
func (s *Server) dispatchGenerateTitle(conn net.Conn, cmd *protocol.ClientCommand) {
	title, err := titling.GenerateTitle(context.Background(), cmd.Text)
	if err != nil {
		s.sendResult(conn, cmd, err, nil)
		return
	}
	s.sendResult(conn, cmd, nil, map[string]string{"title": title})
}

// dispatchMigrateConversation converts a conversation between the Ion and
// Claude Code on-disk formats. It runs in the process command lane, which is
// already asynchronous to the socket read loop. Keeping the work in that lane
// lets the dispatch lifecycle deliver one bounded result for this request.
func (s *Server) dispatchMigrateConversation(conn net.Conn, cmd *protocol.ClientCommand) {
	sourceID := cmd.Key
	targetFormat := cmd.Text
	targetDir := cmd.Message
	newSessionID := conversation.GenEntryID() + "-" + conversation.GenEntryID()

	var result *conversation.MigrateResult
	var sourceMsgs []conversation.ValidationMsg
	var err error

	switch targetFormat {
	case "claude_code":
		var conv *conversation.Conversation
		conv, err = conversation.Load(sourceID, "")
		if err != nil {
			s.sendResult(conn, cmd, fmt.Errorf("load source conversation: %w", err), nil)
			return
		}
		sourceMsgs = conversation.ExtractValidationMsgs(conv)
		result, err = conversation.ConvertIonToClaudeCode(conv, newSessionID, targetDir)
	case "ion":
		// For Claude Code → Ion, key is the source session ID and args
		// contains the source directory for the Claude Code JSONL.
		sourceDir := cmd.Args
		if sourceDir == "" {
			s.sendResult(conn, cmd, fmt.Errorf("args (source dir) required for ion conversion"), nil)
			return
		}
		sourcePath := filepath.Join(sourceDir, sourceID+".jsonl")
		sourceMsgs, err = conversation.ExtractValidationMsgsFromClaudeCode(sourcePath)
		if err != nil {
			s.sendResult(conn, cmd, fmt.Errorf("load source messages: %w", err), nil)
			return
		}
		result, err = conversation.ConvertClaudeCodeToIon(sourcePath, newSessionID, targetDir)
	default:
		s.sendResult(conn, cmd, fmt.Errorf("unknown target format: %s", targetFormat), nil)
		return
	}

	if err != nil {
		s.sendResult(conn, cmd, err, nil)
		return
	}

	if err := conversation.ValidateConversion(sourceMsgs, result.OutputPath, targetFormat); err != nil {
		s.sendResult(conn, cmd, fmt.Errorf("validation failed: %w", err), nil)
		return
	}

	s.sendResult(conn, cmd, nil, result)
}

// dispatchListModels assembles the model + provider listing consumers
// render in their model pickers. Three responsibilities packed into the
// arm:
//
//  1. Build a ProviderEntry per provider with auth status filled in
//     from the resolver (env, keychain, or none). Ollama is special-
//     cased to "no auth needed" since it's a local server.
//
//  2. Surface configured baseURL / APIKeyRef on each provider so
//     consumers can attribute model entries to the gateway they
//     reach (e.g. "via example.com").
//
//  3. For providers with a custom gateway, filter the hardcoded model
//     catalog down to only user-configured or live-discovered models.
//     The hardcoded catalog reflects the public Anthropic/OpenAI/etc
//     offerings and is meaningless when the user has pointed the
//     provider at a private LLM gateway.
func (s *Server) dispatchListModels(conn net.Conn, cmd *protocol.ClientCommand) {
	models := providers.ListModels()
	providerEntries := s.buildProviderEntries()
	// For providers with a custom gateway (baseURL), only show
	// user-configured models or live-discovered models — the hardcoded
	// catalog doesn't apply to private gateways.
	customGatewayProviders := make(map[string]bool)
	if s.config != nil {
		for pid, pc := range s.config.Providers {
			if pc.BaseURL != "" {
				customGatewayProviders[pid] = true
			}
		}
	}
	if len(customGatewayProviders) > 0 {
		models = filterCustomGatewayModels(models, customGatewayProviders)
	}
	s.sendResult(conn, cmd, nil, map[string]interface{}{
		"models":    models,
		"providers": providerEntries,
	})
}

// buildProviderEntries assembles a ProviderEntry for each known provider,
// filling in auth status from the resolver and applying special-case rules
// for ollama (no auth needed) and CLI-capable anthropic fallback. Extracted
// from dispatchListModels to allow direct testing of auth-resolution logic.
func (s *Server) buildProviderEntries() []types.ProviderEntry {
	providerEntries := make([]types.ProviderEntry, 0)
	for _, pid := range providerEntryIDs() {
		entry := types.ProviderEntry{ID: pid}
		if s.authResolver != nil {
			entry.HasAuth, entry.AuthSource = s.authResolver.HasKey(pid)
		}
		// Special case: ollama doesn't need auth
		if pid == "ollama" {
			entry.HasAuth = true
			entry.AuthSource = "none"
		}

		// Project the delegated-CLI status (install/auth) and the
		// credential-derived effective backend for providers that have a CLI
		// option. The effective backend comes from the same shared helper
		// routing uses (backend.EffectiveBackendForProvider), so what the UI
		// shows is what the next run will actually pick.
		cliStatus, effectiveBackend := s.providerCliStatus(pid)
		if effectiveBackend != "" {
			entry.Backend = effectiveBackend
		}
		entry.Cli = cliStatus

		// When the effective backend is a delegated CLI and the CLI reports a
		// usable credential, the provider is authed via that CLI (generalizing
		// the former anthropic-only "cli" fallback across codex/grok/cursor).
		if isCliKind(effectiveBackend) && cliStatus != nil && cliStatus.Authenticated && !entry.HasAuth {
			entry.HasAuth = true
			entry.AuthSource = effectiveBackend
			utils.LogWithFields(utils.LevelDebug, "server", "provider cli-auth applied", map[string]any{"provider": pid, "backend": effectiveBackend})
		}

		// Startup fallback for the explicit top-level "claude-code" backend
		// only: every run goes to the Claude CLI there regardless of API keys,
		// so anthropic is reported authed via claude-code before the async
		// probe populates. Hybrid mode is deliberately excluded — its entries
		// are credential-derived above, and claiming claude-code auth pre-probe
		// would contradict the router (which picks api until the probe lands).
		if s.cliCapable && s.hybrid == nil && pid == "anthropic" && !entry.HasAuth {
			entry.HasAuth = true
			entry.AuthSource = "claude-code"
			if entry.Backend == "" {
				entry.Backend = "claude-code"
			}
			utils.LogWithFields(utils.LevelDebug, "server", "provider claude-code-auth fallback applied", map[string]any{"provider": pid})
		}

		// Populate config details (gateway URL, API key reference, display name)
		if s.config != nil {
			if pc, ok := s.config.Providers[pid]; ok {
				entry.BaseURL = pc.BaseURL
				entry.DisplayName = pc.DisplayName
				// Show the API key reference if it looks like an env var
				// (starts with $), otherwise just indicate it's set.
				if pc.APIKey != "" {
					if len(pc.APIKey) > 0 && pc.APIKey[0] == '$' {
						entry.APIKeyRef = pc.APIKey
					} else {
						entry.APIKeyRef = "configured"
					}
				}
			}
		}
		providerEntries = append(providerEntries, entry)
	}
	return providerEntries
}

// providerEntryIDs returns the sorted union of registered providers and the
// CLI-backed providers (e.g. cursor) that have no HTTP registration. The union
// ensures a CLI-only provider still gets a provider entry.
func providerEntryIDs() []string {
	seen := make(map[string]bool)
	var ids []string
	for _, pid := range providers.ListProviderIDs() {
		if !seen[pid] {
			seen[pid] = true
			ids = append(ids, pid)
		}
	}
	for _, pid := range ionconfig.CliBackedProviderIDs() {
		if !seen[pid] {
			seen[pid] = true
			ids = append(ids, pid)
		}
	}
	sort.Strings(ids)
	return ids
}
