package server

import (
	"context"
	"fmt"
	"net"
	"path/filepath"
	"runtime"

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
//     conversations) runs in a goroutine with a recover() so a panic in
//     one client's request can't bring the whole server down. The
//     recover captures a stack trace, logs it, and surfaces a generic
//     "internal error" to the client.
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
	go func(c net.Conn, command *protocol.ClientCommand) {
		defer func() {
			if r := recover(); r != nil {
				buf := make([]byte, 4096)
				n := runtime.Stack(buf, false)
				utils.Error("Server", fmt.Sprintf("panic in generate_title: %v\n%s", r, buf[:n]))
				s.sendResult(c, command, fmt.Errorf("internal error"), nil)
			}
		}()
		title, err := titling.GenerateTitle(context.Background(), command.Text)
		if err != nil {
			s.sendResult(c, command, err, nil)
			return
		}
		s.sendResult(c, command, nil, map[string]string{"title": title})
	}(conn, cmd)
}

// dispatchMigrateConversation converts a conversation between the Ion
// and Claude Code on-disk formats. Runs async because the conversion
// can touch large message lists and we want to validate the output
// before returning. Validation is bidirectional: the helper extracts
// canonical messages from the source, performs the conversion, then
// re-reads the destination and compares so format-mangling bugs are
// caught at the call site rather than discovered later when the user
// tries to load the converted file.
func (s *Server) dispatchMigrateConversation(conn net.Conn, cmd *protocol.ClientCommand) {
	go func(c net.Conn, command *protocol.ClientCommand) {
		defer func() {
			if r := recover(); r != nil {
				buf := make([]byte, 4096)
				n := runtime.Stack(buf, false)
				utils.Error("Server", fmt.Sprintf("panic in migrate_conversation: %v\n%s", r, buf[:n]))
				s.sendResult(c, command, fmt.Errorf("internal error"), nil)
			}
		}()

		sourceID := command.Key
		targetFormat := command.Text
		targetDir := command.Message
		newSessionID := conversation.GenEntryID() + "-" + conversation.GenEntryID()

		var result *conversation.MigrateResult
		var sourceMsgs []conversation.ValidationMsg
		var err error

		switch targetFormat {
		case "claude_code":
			var conv *conversation.Conversation
			conv, err = conversation.Load(sourceID, "")
			if err != nil {
				s.sendResult(c, command, fmt.Errorf("load source conversation: %w", err), nil)
				return
			}
			sourceMsgs = conversation.ExtractValidationMsgs(conv)
			result, err = conversation.ConvertIonToClaudeCode(conv, newSessionID, targetDir)
		case "ion":
			// For Claude Code → Ion, key is the source session ID and
			// args contains the source directory for the Claude Code JSONL.
			sourceDir := command.Args
			if sourceDir == "" {
				s.sendResult(c, command, fmt.Errorf("args (source dir) required for ion conversion"), nil)
				return
			}
			sourcePath := filepath.Join(sourceDir, sourceID+".jsonl")
			sourceMsgs, err = conversation.ExtractValidationMsgsFromClaudeCode(sourcePath)
			if err != nil {
				s.sendResult(c, command, fmt.Errorf("load source messages: %w", err), nil)
				return
			}
			result, err = conversation.ConvertClaudeCodeToIon(sourcePath, newSessionID, targetDir)
		default:
			s.sendResult(c, command, fmt.Errorf("unknown target format: %s", targetFormat), nil)
			return
		}

		if err != nil {
			s.sendResult(c, command, err, nil)
			return
		}

		if err := conversation.ValidateConversion(sourceMsgs, result.OutputPath, targetFormat); err != nil {
			s.sendResult(c, command, fmt.Errorf("validation failed: %w", err), nil)
			return
		}

		s.sendResult(c, command, nil, result)
	}(conn, cmd)
}

// dispatchListModels assembles the model + provider listing consumers
// render in their model pickers. Three responsibilities packed into the
// arm:
//
//   1. Build a ProviderEntry per provider with auth status filled in
//      from the resolver (env, keychain, or none). Ollama is special-
//      cased to "no auth needed" since it's a local server.
//
//   2. Surface configured baseURL / APIKeyRef on each provider so
//      consumers can attribute model entries to the gateway they
//      reach (e.g. "via example.com").
//
//   3. For providers with a custom gateway, filter the hardcoded model
//      catalog down to only user-configured or live-discovered models.
//      The hardcoded catalog reflects the public Anthropic/OpenAI/etc
//      offerings and is meaningless when the user has pointed the
//      provider at a private LLM gateway.
func (s *Server) dispatchListModels(conn net.Conn, cmd *protocol.ClientCommand) {
	models := providers.ListModels()
	providerIDs := providers.ListProviderIDs()
	providerEntries := make([]types.ProviderEntry, len(providerIDs))
	for i, pid := range providerIDs {
		entry := types.ProviderEntry{ID: pid}
		if s.authResolver != nil {
			entry.HasAuth, entry.AuthSource = s.authResolver.HasKey(pid)
		}
		// Special case: ollama doesn't need auth
		if pid == "ollama" {
			entry.HasAuth = true
			entry.AuthSource = "none"
		}
		// Populate config details (gateway URL, API key reference)
		if s.config != nil {
			if pc, ok := s.config.Providers[pid]; ok {
				entry.BaseURL = pc.BaseURL
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
		providerEntries[i] = entry
	}
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
		// Build set of discovered model IDs so we don't filter them out
		discoveredIDs := make(map[string]bool)
		for pid := range customGatewayProviders {
			for _, dm := range providers.GetDiscoveredModels(pid) {
				discoveredIDs[dm.ID] = true
			}
		}
		filtered := make([]types.ModelEntry, 0, len(models))
		for _, m := range models {
			if customGatewayProviders[m.ProviderID] && !m.IsCustom && !discoveredIDs[m.ID] {
				continue // skip hardcoded catalog models for custom gateway providers
			}
			filtered = append(filtered, m)
		}
		models = filtered
	}
	s.sendResult(conn, cmd, nil, map[string]interface{}{
		"models":    models,
		"providers": providerEntries,
	})
}
