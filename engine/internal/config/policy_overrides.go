package config

import (
	"net/url"
	"sort"

	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// policy_overrides.go — the record of lower-layer values enterprise
// enforcement displaced.
//
// EnforceEnterprise replaces and removes user and project values. Without a
// record, a consumer sees only the correct-by-policy result and cannot tell a
// displaced value from one that was never saved. The collector gathers one
// types.PolicyOverride per displaced value during a single EnforceEnterprise
// pass and stamps the set onto the EnterpriseConfig the result carries.

// overrideCollector gathers the overrides of one EnforceEnterprise pass.
type overrideCollector struct {
	overrides []types.PolicyOverride
}

// replaced records a lower-layer value that policy replaced. It records
// nothing when the lower layer supplied no value or supplied the value that is
// in effect anyway.
func (c *overrideCollector) replaced(field string, reason types.PolicyOverrideReason, userValue, effectiveValue string) {
	if userValue == "" || userValue == effectiveValue {
		return
	}
	c.overrides = append(c.overrides, types.PolicyOverride{
		Field: field, Reason: reason, UserValue: userValue, EffectiveValue: effectiveValue,
	})
}

// replacedSecret records that policy replaced a lower-layer value in a field
// that can hold a secret. Neither value is recorded.
func (c *overrideCollector) replacedSecret(field string, reason types.PolicyOverrideReason, userValue, effectiveValue string) {
	if userValue == "" || userValue == effectiveValue {
		return
	}
	c.overrides = append(c.overrides, types.PolicyOverride{Field: field, Reason: reason})
}

// removed records a lower-layer entry that policy removed outright.
func (c *overrideCollector) removed(field string, reason types.PolicyOverrideReason) {
	c.overrides = append(c.overrides, types.PolicyOverride{Field: field, Reason: reason})
}

// providerPinned records each field of a lower-layer provider definition that
// an enterprise definition for the same key replaced. effective is the
// definition in effect, after any lower-layer API key was carried over.
func (c *overrideCollector) providerPinned(key string, user, effective types.ProviderConfig) {
	prefix := "providers." + key + "."
	reason := types.PolicyOverrideProviderPinned
	userURL, effectiveURL := user.BaseURL, effective.BaseURL
	if userURL != effectiveURL {
		// Compare raw, report redacted: a URL may carry credentials.
		userURL, effectiveURL = redactURL(userURL), redactURL(effectiveURL)
		if userURL == effectiveURL {
			c.replacedSecret(prefix+"baseURL", reason, user.BaseURL, effective.BaseURL)
		} else {
			c.replaced(prefix+"baseURL", reason, userURL, effectiveURL)
		}
	}
	c.replaced(prefix+"authHeader", reason, user.AuthHeader, effective.AuthHeader)
	c.replaced(prefix+"backend", reason, user.Backend, effective.Backend)
	c.replaced(prefix+"displayName", reason, user.DisplayName, effective.DisplayName)
	c.replacedSecret(prefix+"apiKey", reason, user.APIKey, effective.APIKey)
}

// stamp returns a copy of enterprise carrying this pass's overrides, sorted by
// field so the same displaced values always serialize identically. It always
// overwrites Overrides: the set is engine-computed, so a value a policy source
// carried under that key never survives.
func (c *overrideCollector) stamp(enterprise *types.EnterpriseConfig) *types.EnterpriseConfig {
	sort.SliceStable(c.overrides, func(i, j int) bool {
		if c.overrides[i].Field != c.overrides[j].Field {
			return c.overrides[i].Field < c.overrides[j].Field
		}
		return c.overrides[i].Reason < c.overrides[j].Reason
	})
	for _, o := range c.overrides {
		utils.LogWithFields(utils.LevelInfo, "config.merge", "enterprise: policy override recorded", map[string]any{
			"field": o.Field, "reason": string(o.Reason), "user_value": o.UserValue, "effective_value": o.EffectiveValue,
		})
	}
	utils.LogWithFields(utils.LevelDebug, "config.merge", "enterprise: policy overrides stamped", map[string]any{"count": len(c.overrides)})
	stamped := *enterprise
	stamped.Overrides = c.overrides
	return &stamped
}

// redactURL returns raw without the parts of a URL that can carry a
// credential: userinfo, query, and fragment. An unparseable value redacts to
// "", so it is never reported verbatim.
func redactURL(raw string) string {
	if raw == "" {
		return ""
	}
	u, err := url.Parse(raw)
	if err != nil {
		return ""
	}
	u.User = nil
	u.RawQuery = ""
	u.ForceQuery = false
	u.Fragment = ""
	return u.String()
}
