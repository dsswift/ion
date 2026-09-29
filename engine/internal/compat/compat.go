// Package compat is the engine's registry of Format Versions: every versioned
// data format, stored schema, and wire protocol the engine reads or writes,
// with the rule that decides whether two builds can work together over it.
//
// The Studio server keeps the matching registry for its own formats in
// packages/shared/src/compat-registry.ts. Both use the same entry shape and
// rule names, so a consumer (`ion fleet`) can merge them and judge a pair of
// hosts without knowing any one format.
package compat

import (
	"strconv"

	"github.com/dsswift/ion/engine/internal/acp"
	"github.com/dsswift/ion/engine/internal/auth"
	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/mcp"
	"github.com/dsswift/ion/engine/internal/telemetry"
	"github.com/dsswift/ion/engine/internal/telemetryformat"
)

// Rule is how two builds' versions of one format decide compatibility.
type Rule string

const (
	// RuleExact: both ends must write and read the same version.
	RuleExact Rule = "exact"
	// RuleAcceptsPrevious: the receiver accepts its own version and the one
	// before it.
	RuleAcceptsPrevious Rule = "accepts-previous"
	// RuleReaderAtLeast: a reader handles every version up to its own, so it
	// must be at or above the writer.
	RuleReaderAtLeast Rule = "reader-at-least"
	// RuleHostStorage: data stored on the host in this version; a build that
	// writes a lower version would be a downgrade of stored data.
	RuleHostStorage Rule = "host-storage"
	// RuleExternal: a protocol spoken to a third party. Reported, never
	// compared between Ion hosts.
	RuleExternal Rule = "external"
)

// Owner names which Ion component a format belongs to.
const (
	OwnerEngine = "engine"
	OwnerServer = "server"
)

// Format is one registry entry. Version is a string so numeric versions and
// dated or named ones (`2026-07-28`, `ion-remote-v1`) share one shape.
type Format struct {
	ID      string `json:"id"`
	Owner   string `json:"owner"`
	Version string `json:"version"`
	Rule    Rule   `json:"rule"`
	Meaning string `json:"meaning"`
	// Constant is the Go constant the version comes from, `pkg.Name`. The
	// registry test uses it to prove every version constant is registered.
	Constant string `json:"-"`
}

// StatusReportVersion is the shape of `ion studio status --json`
// (engine/internal/studiostatus), which `ion fleet` reads from other hosts.
const StatusReportVersion = 1

// Formats returns the engine's registry, in a stable order.
func Formats() []Format {
	return []Format{
		{
			ID: "conversation-file", Owner: OwnerEngine, Rule: RuleHostStorage,
			Version: strconv.Itoa(conversation.CurrentVersion), Constant: "conversation.CurrentVersion",
			Meaning: "Schema of the conversation files the engine stores",
		},
		{
			ID: "identity-store", Owner: OwnerEngine, Rule: RuleHostStorage,
			Version: strconv.Itoa(auth.IdentityStoreVersion), Constant: "auth.IdentityStoreVersion",
			Meaning: "Schema of the stored operator sign-in",
		},
		{
			ID: "telemetry-schema", Owner: OwnerEngine, Rule: RuleReaderAtLeast,
			Version: strconv.Itoa(telemetry.TelemetrySchemaVersion), Constant: "telemetry.TelemetrySchemaVersion",
			Meaning: "Schema of the telemetry files the engine writes",
		},
		{
			ID: "telemetry-frame", Owner: OwnerEngine, Rule: RuleReaderAtLeast,
			Version: strconv.Itoa(telemetryformat.FrameVersion), Constant: "telemetryformat.FrameVersion",
			Meaning: "Format of one compact telemetry frame",
		},
		{
			ID: "status-report", Owner: OwnerEngine, Rule: RuleReaderAtLeast,
			Version: strconv.Itoa(StatusReportVersion), Constant: "compat.StatusReportVersion",
			Meaning: "Shape of the host status report `ion fleet` reads from each host",
		},
		{
			ID: "mcp-discovery", Owner: OwnerEngine, Rule: RuleExternal,
			Version: mcp.DiscoveryProtocolVersion, Constant: "mcp.DiscoveryProtocolVersion",
			Meaning: "MCP protocol version the engine sends on discovery requests",
		},
		{
			ID: "acp", Owner: OwnerEngine, Rule: RuleExternal,
			Version: strconv.Itoa(acp.ProtocolVersion), Constant: "acp.ProtocolVersion",
			Meaning: "ACP wire version the engine negotiates with agents",
		},
	}
}
