package server

import (
	"context"
	"fmt"
	"net"
	"path/filepath"
	"sort"
	"time"

	"github.com/dsswift/ion/engine/internal/auth"
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

// dispatchLoadSessionHistory loads a session chain's stored messages
// (load_session_history). Extracted from dispatch.go's switch to keep that
// file under the 800-line cap; logs entry/exit at INFO (not DEBUG) because
// this path had zero dedicated logging before a missing entry here once
// meant a request silently never appeared in the log at all, indistinguishable
// from "never dispatched" -- see the operator-facing "load_session_history:
// start/done" pair, which now brackets exactly how long the disk read took.
func (s *Server) dispatchLoadSessionHistory(conn net.Conn, cmd *protocol.ClientCommand) {
	utils.LogWithFields(utils.LevelInfo, "server", "load_session_history: start", map[string]any{
		"request_id": cmd.RequestID, "session_id_count": len(cmd.SessionIDs), "key": cmd.Key,
	})
	startedAt := time.Now()
	var messages []types.SessionMessage
	var err error
	if len(cmd.SessionIDs) > 0 {
		messages, err = conversation.LoadChainMessages(cmd.SessionIDs, "")
	} else {
		messages, err = conversation.LoadMessages(cmd.Key, "")
	}
	errMsg := "none"
	if err != nil {
		errMsg = err.Error()
	}
	utils.LogWithFields(utils.LevelInfo, "server", "load_session_history: done", map[string]any{
		"request_id": cmd.RequestID, "message_count": len(messages), "duration_ms": time.Since(startedAt).Milliseconds(),
		"error": errMsg,
	})
	s.sendResult(conn, cmd, err, messages)
}

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
// render in their model pickers. Four responsibilities packed into the
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
//
//  4. When cmd.Principal is present (FR-05, R-12, R-50), filter models
//     to the acting principal's discovered entitlement and declare the
//     scope on the response (SC-5, additive: {models, providers} is
//     unchanged, {scope} is new). An unattributed request (cmd.Principal
//     nil, the pre-existing shape) returns principalScoped=false and
//     today's unfiltered content -- R-51: list_models answers per
//     connection regardless of tenancy mode, so an unattributed caller on
//     a partitioned instance is unaffected.
//
// The SAME CredentialContext built for entitlement filtering is also passed
// into buildProviderEntries (child 06, R-13), so HasAuth/effective-backend in
// the providers half of this response agree with the models half and with
// what the acting principal's next run will actually pick.
func (s *Server) dispatchListModels(conn net.Conn, cmd *protocol.ClientCommand) {
	models := providers.ListModels()
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

	subject := ""
	var cc *auth.CredentialContext
	if cmd.Principal != nil {
		subject = cmd.Principal.Subject
	}
	if subject != "" && s.authResolver != nil {
		cc = auth.NewCredentialContext(cmd.Principal, s.authResolver, auth.NewTenancyFallThroughPolicy(s.config))
		providers.WireEntitlement(cc, s.providerConfigsForEntitlement())
		models = filterModelsByEntitlement(models, cc)
	}
	providerEntries := s.buildProviderEntries(cc)

	s.sendResult(conn, cmd, nil, map[string]interface{}{
		"models":    models,
		"providers": providerEntries,
		"scope": map[string]interface{}{
			"principalScoped": subject != "",
			"subject":         subject,
		},
	})
}

// filterModelsByEntitlement filters models to the ids cc.Entitlement returns
// for each model's provider. A nil entitlement (not yet discovered) does not
// filter that provider's models -- the honest "unknown" answer, not "entitled
// to nothing".
func filterModelsByEntitlement(models []types.ModelEntry, cc *auth.CredentialContext) []types.ModelEntry {
	if cc == nil || cc.Entitlement == nil {
		return models
	}
	entitledCache := map[string][]string{}
	knownCache := map[string]bool{}
	out := make([]types.ModelEntry, 0, len(models))
	for _, m := range models {
		ids, known := entitledCache[m.ProviderID]
		if !known {
			resolved := cc.Entitlement(m.ProviderID)
			knownCache[m.ProviderID] = resolved != nil
			entitledCache[m.ProviderID] = resolved
			ids = resolved
		}
		if !knownCache[m.ProviderID] {
			// Not yet discovered for this provider: do not filter (B-17
			// spirit, per-principal now).
			out = append(out, m)
			continue
		}
		for _, id := range ids {
			if id == m.ID {
				out = append(out, m)
				break
			}
		}
	}
	return out
}

// providerConfigsForEntitlement returns the provider configs entitlement
// discovery needs to resolve a base URL, or nil when no config is loaded.
func (s *Server) providerConfigsForEntitlement() map[string]types.ProviderConfig {
	if s.config == nil {
		return nil
	}
	return s.config.Providers
}

// buildProviderEntries assembles a ProviderEntry for each known provider,
// filling in auth status from the resolver and applying special-case rules
// for ollama (no auth needed) and CLI-capable anthropic fallback. Extracted
// from dispatchListModels to allow direct testing of auth-resolution logic.
// buildProviderEntries assembles one ProviderEntry per provider. cc is the
// acting principal's CredentialContext (nil for an unattributed request);
// when non-nil, HasAuth/AuthSource and the effective backend are evaluated
// for that principal rather than the process as a whole (child 06, R-13),
// so listing agrees with what that principal's next run will actually pick.
func (s *Server) buildProviderEntries(cc *auth.CredentialContext) []types.ProviderEntry {
	providerEntries := make([]types.ProviderEntry, 0)
	for _, pid := range providerEntryIDs() {
		entry := types.ProviderEntry{ID: pid}
		if cc != nil {
			entry.HasAuth, entry.AuthSource = cc.HasCredential(context.Background(), pid)
		} else if s.authResolver != nil {
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
		cliStatus, effectiveBackend := s.providerCliStatus(pid, cc)
		if effectiveBackend != "" {
			entry.Backend = effectiveBackend
		}
		entry.Cli = cliStatus
		if kind, ok := ionconfig.CliBackendKind(pid); ok {
			entry.LoginFlow = loginFlowForCliKind(kind)
		}

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
		utils.LogWithFields(utils.LevelDebug, "server", "provider entry", map[string]any{
			"provider": pid, "subject": cc.Subject(), "has_auth": entry.HasAuth, "backend": entry.Backend,
		})
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

// loginFlowForCliKind maps a delegated-CLI backend kind onto the
// ProviderEntry.LoginFlow a client needs to decide whether a sign-in can be
// driven from another machine. The mapping follows each driver in
// internal/cliprobe: claude_login.go scrapes an authorize URL and accepts a
// pasted code; loginCodex emits await_browser or await_device_code depending
// on what the app-server offers; loginACP lets the grok/cursor CLI drive its
// own browser with a loopback callback.
func loginFlowForCliKind(kind string) string {
	switch kind {
	case "claude-code":
		return types.LoginFlowBrowserCode
	case "codex":
		return types.LoginFlowBrowserOrDeviceCode
	case "grok", "cursor":
		return types.LoginFlowBrowserCallback
	default:
		utils.LogWithFields(utils.LevelWarn, "server", "no login flow known for cli backend kind", map[string]any{"kind": kind})
		return ""
	}
}
