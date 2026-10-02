package config

import (
	"errors"
	"sort"

	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// policy_messages.go — resolves the text a Policy Failure shows. The text is
// presentation only: nothing here decides whether the failure happens.

// PolicyMessage returns the text for the Policy Failure id: the replacement
// from messages when one is configured, fallback otherwise. A blank
// replacement counts as not configured.
func PolicyMessage(messages map[string]string, id, fallback string) string {
	if text, ok := messages[id]; ok && text != "" {
		utils.LogWithFields(utils.LevelInfo, "config.policy_messages", "policy failure message overridden", map[string]any{
			"policy_failure": id, "default_message": fallback,
		})
		return text
	}
	utils.LogWithFields(utils.LevelDebug, "config.policy_messages", "policy failure message default used", map[string]any{
		"policy_failure": id,
	})
	return fallback
}

// EnterpriseMessages returns the configured message map, or nil without a
// policy.
func EnterpriseMessages(enterprise *types.EnterpriseConfig) map[string]string {
	if enterprise == nil {
		return nil
	}
	return enterprise.Messages
}

// NewPolicyError wraps cause as the Policy Failure id. Its message is the
// configured replacement, or cause's own text.
func NewPolicyError(messages map[string]string, id string, cause error) *types.PolicyError {
	return &types.PolicyError{Failure: id, Message: PolicyMessage(messages, id, cause.Error()), Cause: cause}
}

// PolicyFailureOf returns the Policy Failure identifier err carries, or "".
func PolicyFailureOf(err error) string {
	var pe *types.PolicyError
	if errors.As(err, &pe) {
		return pe.Failure
	}
	return ""
}

// mergePolicyMessages overlays one message map on another per identifier, so
// a drop-in can replace one message and leave the rest standing.
func mergePolicyMessages(base, overlay map[string]string) map[string]string {
	if len(overlay) == 0 {
		return base
	}
	merged := make(map[string]string, len(base)+len(overlay))
	for id, text := range base {
		merged[id] = text
	}
	for id, text := range overlay {
		merged[id] = text
	}
	return merged
}

// logPolicyMessages records which identifiers a loaded policy overrides, and
// which of its keys the engine itself never reports.
func logPolicyMessages(messages map[string]string) {
	if len(messages) == 0 {
		return
	}
	known := make(map[string]bool, len(types.PolicyFailureIDs))
	for _, id := range types.PolicyFailureIDs {
		known[id] = true
	}
	var overridden, passthrough []string
	for id := range messages {
		if known[id] {
			overridden = append(overridden, id)
		} else {
			passthrough = append(passthrough, id)
		}
	}
	sort.Strings(overridden)
	sort.Strings(passthrough)
	utils.LogWithFields(utils.LevelInfo, "config.policy_messages", "enterprise policy messages loaded", map[string]any{
		"overridden": overridden, "passthrough": passthrough,
	})
}
