package backend

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/dsswift/ion/engine/internal/auth"
	"github.com/dsswift/ion/engine/internal/providers"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// runloop_telemetry.go holds the shared helpers for the tier-4 telemetry
// emissions threaded through the agent loop (sandbox.block, secret.containment,
// tool.failure, context.pressure, provider.*). Every emission routes through
// run.cfg.Telemetry (a nil-safe TelemetryCollector) so telemetry-disabled runs
// pay only a nil check.

// promptTextForTelemetry extracts a plain-text rendering of a turn's outbound
// messages for the "full" privacy-level llm.call span attribute (LLM prompt
// content, per docs/enterprise/telemetry.md). Only string content and "text"
// content blocks are rendered; non-text blocks (tool_use, tool_result, image)
// are skipped rather than marshaled, since the documented "full" contract is
// prompt/response *text*, not a full wire dump of every message.
func promptTextForTelemetry(messages []types.LlmMessage) string {
	var sb strings.Builder
	for _, msg := range messages {
		switch c := msg.Content.(type) {
		case string:
			sb.WriteString(c)
		case []types.LlmContentBlock:
			for _, blk := range c {
				if blk.Type == "text" {
					sb.WriteString(blk.Text)
				}
			}
		}
	}
	return sb.String()
}

// assistantTextForTelemetry extracts a plain-text rendering of the assistant
// blocks produced by a turn for the "full" privacy-level llm.call span
// attribute (LLM response content). Mirrors promptTextForTelemetry's
// text-only extraction rule.
func assistantTextForTelemetry(blocks []types.LlmContentBlock) string {
	var sb strings.Builder
	for _, blk := range blocks {
		if blk.Type == "text" {
			sb.WriteString(blk.Text)
		}
	}
	return sb.String()
}

// buildTelemCtx builds the standard telemetry context block from an active run.
// Returns nil when run is nil (safe to pass to Collector.Event).
//
// The context block carries the correlation identifiers available on the run:
//   - run_id: the run's requestID.
//   - session_id: the engine session key (opts.SessionKey), the opaque
//     client-supplied key stamped by the session layer (a tab UUID for desktop
//     clients). When opts.SessionKey is empty — the API-backend path where no
//     session layer sets it — this falls back to conv.ID so tier-4 events
//     remain joinable. This matches what the session-layer correlationCtx emits
//     (see session/telemetry_ctx.go), ensuring session_id is consistent across
//     all event families.
//   - conversation_id: the durable conversation-file identity (conv.ID),
//     format {unix-millis}-{12-hex-chars}. Always distinct from session_id in
//     desktop-driven sessions; may coincide in the API-backend fallback path.
//   - extension: the hosting extension's friendly name, omit-when-empty.
//     Present only for extension-hosted runs; absent for direct API runs.
//   - extension_version: the hosting extension's manifest version,
//     omit-when-empty. Present only when the manifest declares a version.
//   - trace_id: the run's W3C trace-context trace-id, read from the run's
//     context (the session layer threads it onto RunOptions.ParentCtx when it
//     mints the run). Omit-when-empty so a run dispatched without one — the
//     direct API-backend path, which has no session layer — is unaffected.
//     Same value the run's log lines carry, so a telemetry event and the log
//     narrative around it join on one identifier.
func buildTelemCtx(run *activeRun) map[string]any {
	if run == nil {
		return nil
	}
	convID := ""
	if run.conv != nil {
		convID = run.conv.ID
	}
	return telemCtxFromOptions(run.requestID, run.opts, convID)
}

// telemCtxFromOptions builds the correlation block from a run's options, for
// a run with no *activeRun (the delegated CLIs). convID is the conversation
// identity; session_id and conversation_id are omitted when it is empty.
func telemCtxFromOptions(requestID string, opts *types.RunOptions, convID string) map[string]any {
	ctx := map[string]any{
		"run_id": requestID,
	}
	if opts != nil && opts.ParentCtx != nil {
		if traceID := utils.TraceIDFromContext(opts.ParentCtx); traceID != "" {
			ctx["trace_id"] = traceID
		}
		// The run's span encloses every span started from this correlation
		// block, so llm.call and tool.execute record it as their parent.
		if spanID := utils.SpanIDFromContext(opts.ParentCtx); spanID != "" {
			ctx["parent_span_id"] = spanID
		}
		// FR-05 child 10 (R-41): the acting principal's attribution, when
		// this run's context carries one (wired at prompt dispatch via
		// utils.WithPrincipalIdentity). telemetry.Event's stamping point
		// reads this key before falling back to the process-wide
		// resolvedUserIdentity() -- see identityForEvent in telemetry.go.
		if identity := utils.PrincipalIdentityFromContext(opts.ParentCtx); identity != "" {
			ctx["principal_identity"] = identity
		}
	}
	if convID != "" {
		// session_id = engine session key (opts.SessionKey, the client-supplied
		// tab UUID or equivalent). conversation_id = durable conversation-file
		// identity. These are always distinct in desktop-driven sessions.
		// Fall back to the conversation ID when SessionKey is empty (API-backend
		// path where no session layer exists) so events remain joinable.
		sessionKey := ""
		if opts != nil {
			sessionKey = opts.SessionKey
		}
		if sessionKey == "" {
			sessionKey = convID
		}
		ctx["session_id"] = sessionKey
		ctx["conversation_id"] = convID
	}
	// Extension attribution: omit-when-empty so non-extension runs are
	// unaffected and old lines group as "unattributed" in dashboards.
	// First exercised additive evolution of the telemetry context (ADR-019).
	if opts != nil && opts.ExtensionName != "" {
		ctx["extension"] = opts.ExtensionName
		if opts.ExtensionVersion != "" {
			ctx["extension_version"] = opts.ExtensionVersion
		}
	}
	return ctx
}

// truncatePreview trims s to at most maxLen bytes so telemetry payloads carry a
// bounded preview of potentially large tool inputs, command strings, or error
// messages. Byte-based (not rune-based) truncation is acceptable for a preview;
// the value is diagnostic, not reconstructed.
func truncatePreview(s string, maxLen int) string {
	if len(s) > maxLen {
		return s[:maxLen]
	}
	return s
}

// telemPreviewLimit is the byte cap for preview fields (command_preview,
// input_preview, error_preview) on tier-4 telemetry events.
const telemPreviewLimit = 200

// emitToolFailure records a tool.failure telemetry event with the failure
// taxonomy category. Nil-safe on telem. Called at each tool-execution failure
// branch in executeTools so consumers get a uniform failure signal regardless
// of which layer rejected the call (permission, sandbox, hook, deadline,
// unknown tool, or execution error).
//
// error_preview is content-shaped (it may echo back user-influenced tool
// arguments embedded in an error message), so it is gated by the configured
// privacy level: omitted entirely at "minimal" (the documented floor —
// truncatePreview is not even called, so no preview string is built only to
// be discarded), present at "standard"/"full".
func emitToolFailure(telem TelemetryCollector, run *activeRun, block toolFailureBlock, category, errorPreview string) {
	if telem == nil {
		return
	}
	// R11: event name is carried by Event.Name at the top level; payload.kind removed.
	payload := map[string]any{
		"tool":             block.Name,
		"tool_use_id":      block.ID,
		"failure_category": category,
		"turn":             run.turnCount.Load(),
	}
	if telem.PrivacyLevel() != "minimal" {
		payload["error_preview"] = truncatePreview(errorPreview, telemPreviewLimit)
	}
	telem.Event("tool.failure", payload, buildTelemCtx(run))
}

// toolFailureBlock is the minimal shape emitToolFailure needs from a tool-use
// content block: the tool name and the tool-use ID. Decoupling from the full
// LlmContentBlock keeps the helper's dependency surface small and its intent
// obvious at each call site.
type toolFailureBlock struct {
	Name string
	ID   string
}

// runTelemetry returns the run's telemetry collector, or nil when the run has
// no config or telemetry is not wired. A nil-safe accessor so callers that only
// have a *activeRun (e.g. processStream) can reach the collector without
// repeating the nil-guard chain.
func runTelemetry(run *activeRun) TelemetryCollector {
	if run == nil || run.cfg == nil {
		return nil
	}
	return run.cfg.Telemetry
}

// streamAttempt returns the retry-attempt index for the stream the run is
// currently consuming. Zero on the first (un-retried) attempt; the real
// attempt number once OnRetryWait has bumped run.currentAttempt before a
// retried stream. nil-safe so processStream can call it unconditionally.
func streamAttempt(run *activeRun) int64 {
	if run == nil {
		return 0
	}
	return run.currentAttempt.Load()
}

// resolveProviderName returns the provider ID for the run's current model, used
// to tag provider.* telemetry events. Falls back to the empty string when the
// model cannot be resolved to a provider (the event still carries the model).
func resolveProviderName(run *activeRun) string {
	if run == nil || run.opts == nil {
		return ""
	}
	return providers.ProviderNameForModel(run.opts.Model)
}

// buildRetryConfig assembles the provider RetryConfig for a turn, including the
// OnRetryWait / OnFallback closures that log the retry/fallback and emit the
// family-4d provider.retry / provider.fallback telemetry events. Extracted from
// runLoop to keep runloop.go under the file-size cap.
//
// runIDCopy/turnCopy are captured (rather than read from run) so the closures
// carry the values from the turn that built them. run.cfg is set once at
// StartRun and never mutated, so reading run.cfg.Telemetry here is safe.
func buildRetryConfig(run *activeRun, opts *types.RunOptions, model, runIDCopy string, turnCopy int) *providers.RetryConfig {
	var retryTelem TelemetryCollector
	if run.cfg != nil {
		retryTelem = run.cfg.Telemetry
	}
	subject := ""
	if run.cfg != nil && run.cfg.CredentialContext != nil {
		subject = run.cfg.CredentialContext.Subject()
	}
	return &providers.RetryConfig{
		MaxRetries:    opts.MaxRetries,
		FallbackChain: opts.FallbackChain,
		Persistent:    opts.Persistent,
		// Subject powers the auth-rejection self-heal (child 07, R-19):
		// InvalidatePrincipal needs to know WHICH principal's cached state
		// to drop before the one-shot re-resolution retry.
		Subject: subject,
		// AttachAuth re-resolves the acting principal's authenticator for
		// whichever provider is about to stream -- the original one, or a
		// fallback-chain hop's provider (R-02, R-03). A nil CredentialContext
		// (unattributed run) means every attempt uses ctx unchanged, which is
		// the pre-existing single-user behavior.
		AttachAuth: func(ctx context.Context, providerID string) context.Context {
			cc := run.cfg
			if cc == nil || cc.CredentialContext == nil {
				return ctx
			}
			a, err := cc.CredentialContext.Authenticator(ctx, providerID)
			if err != nil {
				if errors.Is(err, auth.ErrPrincipalCredentialUnresolved) {
					utils.LogWithFields(utils.LevelInfo, "backend.runloop", "principal credential refused on retry attempt", map[string]any{
						"provider": providerID, "subject": cc.CredentialContext.Subject(),
					})
					return providers.WithCredentialRefusal(ctx, cc.CredentialContext.Subject())
				}
				utils.LogWithFields(utils.LevelInfo, "backend.runloop", "no request credential on retry attempt", map[string]any{
					"provider": providerID, "subject": cc.CredentialContext.Subject(), "error": err.Error(),
				})
				return ctx
			}
			if a == nil {
				return ctx
			}
			return providers.WithRequestCredential(ctx, a)
		},
		OnRetryWait: func(attempt, delayMs int, pe *providers.ProviderError) {
			// Thread the real retry-attempt index onto the run so the next
			// stream's provider.ttft event reports the attempt that produced it
			// (family 4d). OnRetryWait fires immediately before the retried
			// stream begins, so this is the attempt processStream will consume.
			run.currentAttempt.Store(int64(attempt))
			cause := ""
			if pe != nil && pe.Cause != nil {
				cause = fmt.Sprintf(" cause=%v", pe.Cause)
			}
			code := ""
			if pe != nil {
				code = pe.Code
			}
			utils.LogWithFields(utils.LevelWarn, "backend.runloop", "provider retry: ms", map[string]any{
				"run_id":  runIDCopy,
				"turn":    turnCopy,
				"attempt": attempt,
				"delay":   delayMs,
				"code":    code,
				"error":   fmt.Sprint(pe),
				"cause":   cause,
			})
			// provider.retry telemetry (family 4d). R11: payload.kind removed.
			if retryTelem != nil {
				retryAfterMs := int64(0)
				if pe != nil {
					retryAfterMs = pe.RetryAfterMs
				}
				retryTelem.Event("provider.retry", map[string]any{
					"model":          model,
					"turn":           turnCopy,
					"attempt":        attempt,
					"delay_ms":       delayMs,
					"error_code":     code,
					"retry_after_ms": retryAfterMs,
				}, buildTelemCtx(run))
			}
		},
		OnFallback: func(fromModel, toModel string, hop int) {
			utils.LogWithFields(utils.LevelWarn, "backend.runloop", "model fallback: ->", map[string]any{
				"run_id":     runIDCopy,
				"turn":       turnCopy,
				"hop":        hop,
				"from_model": fromModel,
				"to_model":   toModel,
			})
			// provider.fallback telemetry (family 4d), overload-driven path. R11: payload.kind removed.
			if retryTelem != nil {
				retryTelem.Event("provider.fallback", map[string]any{
					"requested_model": fromModel,
					"fallback_model":  toModel,
					"reason":          "overloaded",
					"hop":             hop,
					"turn":            turnCopy,
				}, buildTelemCtx(run))
			}
		},
	}
}
