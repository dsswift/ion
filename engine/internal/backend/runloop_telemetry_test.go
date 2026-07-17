package backend

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/types"
)

// TestBuildTelemCtxAndCorrelationCtxAgreeOnSessionID is the regression test for
// the telemetry correlation-key bug described in the investigation doc:
//
//	departments/development/deliverables/2026-07-05-logging-telemetry-layer-separation-investigation.md
//
// Root cause (pre-fix): buildTelemCtx stamped session_id = opts.ConversationID
// (the conversation-file identity, formerly named opts.SessionID) rather than
// opts.SessionKey (the engine session key). This made tier-4 events
// (tool.failure, provider.*, etc.) stamp the wrong identifier in session_id,
// breaking cross-event-type forensic joins.
//
// The session-layer builder correlationCtx (session/telemetry_ctx.go) is not
// importable here (it is unexported); its logic is a trivial two-field map —
// {session_id: sessionKey, conversation_id: convID} — reproduced inline so the
// test can assert agreement between the two paths without circular imports.
//
// This test asserts:
//
//  1. buildTelemCtx stamps session_id from opts.SessionKey (the engine session
//     key, a UUID for desktop clients) — NOT from opts.ConversationID.
//  2. buildTelemCtx and correlationCtx produce the same session_id value for
//     the same input (sessionKey), confirming the two builders agree.
//  3. buildTelemCtx and correlationCtx produce the same conversation_id value.
//  4. session_id and conversation_id are distinct for a desktop-driven run
//     where the session key is a UUID and the conv ID is {millis}-{hex}.
//  5. The API-backend fallback (empty SessionKey) uses conv.ID as session_id
//     so tier-4 events remain joinable even without a session key.
//
// Must fail on unfixed code: on the pre-fix code, buildTelemCtx reads
// opts.ConversationID as session_id, so assertion 1 fails (expected UUID
// "test-session-key-uuid", got conv-ID string "1780000000000-aabbccddeeff")
// and assertion 2 fails (builders disagree).
func TestBuildTelemCtxAndCorrelationCtxAgreeOnSessionID(t *testing.T) {
	const sessionKey = "test-session-key-uuid"
	const convID = "1780000000000-aabbccddeeff"

	// correlationCtxSim replicates the session-layer correlationCtx builder
	// (session/telemetry_ctx.go) exactly. Used here to assert agreement between
	// the two builders without importing the unexported function.
	correlationCtxSim := func(sk, cid string) map[string]any {
		ctx := map[string]any{"session_id": sk}
		if cid != "" {
			ctx["conversation_id"] = cid
		}
		return ctx
	}

	// ── Desktop-driven path: SessionKey is a UUID, ConversationID is {millis}-{hex} ──

	run := &activeRun{
		requestID: "req-test",
		conv:      &conversation.Conversation{ID: convID},
		opts: &types.RunOptions{
			SessionKey:     sessionKey,
			ConversationID: convID,
		},
	}

	telemCtx := buildTelemCtx(run)
	if telemCtx == nil {
		t.Fatal("buildTelemCtx returned nil for non-nil run")
	}

	// 1. session_id must be the session key, not the conversation ID.
	gotSessionID, _ := telemCtx["session_id"].(string)
	if gotSessionID != sessionKey {
		t.Errorf("buildTelemCtx session_id = %q, want %q (engine session key, not conv ID)",
			gotSessionID, sessionKey)
	}

	// 3 (conversation_id check): conversation_id must be the conv ID.
	gotConvID, _ := telemCtx["conversation_id"].(string)
	if gotConvID != convID {
		t.Errorf("buildTelemCtx conversation_id = %q, want %q", gotConvID, convID)
	}

	// 2. correlationCtx (session-layer builder) must produce the same session_id.
	corrCtx := correlationCtxSim(sessionKey, convID)
	if corrCtx["session_id"] != telemCtx["session_id"] {
		t.Errorf("session_id mismatch: buildTelemCtx=%q correlationCtx=%q — builders disagree",
			telemCtx["session_id"], corrCtx["session_id"])
	}

	// 3. correlationCtx must produce the same conversation_id.
	if corrCtx["conversation_id"] != telemCtx["conversation_id"] {
		t.Errorf("conversation_id mismatch: buildTelemCtx=%q correlationCtx=%q — builders disagree",
			telemCtx["conversation_id"], corrCtx["conversation_id"])
	}

	// 4. session_id and conversation_id must be distinct for desktop-driven sessions.
	if telemCtx["session_id"] == telemCtx["conversation_id"] {
		t.Errorf("session_id == conversation_id (%q) — they must be distinct for desktop sessions",
			telemCtx["session_id"])
	}

	// ── API-backend fallback path: SessionKey is empty, conv.ID is the identifier ──

	apiRun := &activeRun{
		requestID: "req-api",
		conv:      &conversation.Conversation{ID: convID},
		opts: &types.RunOptions{
			SessionKey:     "", // empty — API backend, no session layer
			ConversationID: convID,
		},
	}

	apiCtx := buildTelemCtx(apiRun)
	if apiCtx == nil {
		t.Fatal("buildTelemCtx returned nil for API-backend run")
	}

	// 5. When SessionKey is empty, session_id falls back to conv.ID so events
	// are still joinable. This is the degenerate case: both identifiers carry
	// the same value, which is acceptable for API-backend runs where no session
	// layer sets the key.
	apiSessionID, _ := apiCtx["session_id"].(string)
	if apiSessionID != convID {
		t.Errorf("API-backend fallback: session_id = %q, want %q (conv ID fallback when SessionKey empty)",
			apiSessionID, convID)
	}
	apiConvID, _ := apiCtx["conversation_id"].(string)
	if apiConvID != convID {
		t.Errorf("API-backend fallback: conversation_id = %q, want %q", apiConvID, convID)
	}
}

// TestBuildTelemCtx_ExtensionAttributionCarried verifies that when the run
// has extension identity in its opts (threaded from the session layer), the
// "extension" and "extension_version" keys appear in the telemetry context.
//
// EMISSION-ONLY coverage: opts.ExtensionName is set directly here. How the
// session layer populates it in a real extension-hosted session is pinned by
// session/extension_attribution_population_test.go.
//
// RED on unfixed code: buildTelemCtx (pre-fix) never populated "extension" or
// "extension_version", so these assertions would fail.
func TestBuildTelemCtx_ExtensionAttributionCarried(t *testing.T) {
	const sessionKey = "test-ext-key"
	const convID = "1780000000001-aabbccddeeff"
	const extName = "ion-dev"
	const extVersion = "3.1.0"

	run := &activeRun{
		requestID: "req-ext",
		conv:      &conversation.Conversation{ID: convID},
		opts: &types.RunOptions{
			SessionKey:       sessionKey,
			ConversationID:   convID,
			ExtensionName:    extName,
			ExtensionVersion: extVersion,
		},
	}

	ctx := buildTelemCtx(run)
	if ctx == nil {
		t.Fatal("buildTelemCtx returned nil for non-nil run")
	}
	got, _ := ctx["extension"].(string)
	if got != extName {
		t.Errorf("extension = %q, want %q", got, extName)
	}
	gotVer, _ := ctx["extension_version"].(string)
	if gotVer != extVersion {
		t.Errorf("extension_version = %q, want %q", gotVer, extVersion)
	}
}

// TestBuildTelemCtx_ExtensionAttributionOmittedWhenAbsent verifies that when
// the run has no extension identity (non-extension run), the "extension" and
// "extension_version" keys are absent from the telemetry context.
//
// RED on unfixed code that always stamps the fields: these assertions would
// fail because the keys would be present with empty values.
func TestBuildTelemCtx_ExtensionAttributionOmittedWhenAbsent(t *testing.T) {
	const sessionKey = "test-no-ext-key"
	const convID = "1780000000002-aabbccddeeff"

	run := &activeRun{
		requestID: "req-no-ext",
		conv:      &conversation.Conversation{ID: convID},
		opts: &types.RunOptions{
			SessionKey:     sessionKey,
			ConversationID: convID,
			// ExtensionName and ExtensionVersion intentionally empty
		},
	}

	ctx := buildTelemCtx(run)
	if ctx == nil {
		t.Fatal("buildTelemCtx returned nil for non-nil run")
	}
	if _, ok := ctx["extension"]; ok {
		t.Errorf("extension must be absent for non-extension runs; got %v", ctx["extension"])
	}
	if _, ok := ctx["extension_version"]; ok {
		t.Errorf("extension_version must be absent for non-extension runs; got %v", ctx["extension_version"])
	}
}
