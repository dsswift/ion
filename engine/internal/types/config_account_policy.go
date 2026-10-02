package types

// AccountPolicy is one administrator-authored policy that applies only to
// the accounts its Match selects. Account policies live inside the machine
// enterprise policy (EnterpriseConfig.AccountPolicies), so they are written
// through the same administrator-only source as the machine policy itself.
//
// An account policy composes UNDER the machine policy: it may restrict
// further, never relax. See config.ComposeAccountPolicy for the rule each
// field class follows.
type AccountPolicy struct {
	// Name labels the entry in logs and enforcement records. Optional.
	Name string `json:"name,omitempty"`
	// Match selects the accounts this entry applies to.
	Match AccountMatch `json:"match"`
	// AssetScope names an administrator-defined scope for on-disk assets
	// delivered to the matched accounts only. The engine reports the scopes
	// of every matching entry on the resolved policy
	// (EnterpriseConfig.AssetScopes); what a scope maps to on disk is the
	// consumer's concern.
	AssetScope string `json:"assetScope,omitempty"`
	// Policy carries the same keys as the machine policy. Its own
	// accountPolicies, managedMode and assetScopes are ignored.
	Policy *EnterpriseConfig `json:"policy,omitempty"`
}

// AccountMatch selects accounts on two kinds of dimension. Every non-empty
// field must match; an empty field is a wildcard, and a match with every
// field empty selects every account.
//
// The OS dimensions describe the operating-system account the engine process
// runs as. The engine reads them from the operating system, so nothing a
// client sends can change them.
//
// The principal dimensions describe a session's SessionPrincipal and follow
// PrincipalMatch exactly. A principal reaches the engine from the client that
// started the session, so these are as trustworthy as that client.
type AccountMatch struct {
	// OSUsers matches the account's user name or its stable id (a uid, or a
	// SID on Windows). Names compare case-insensitively.
	OSUsers []string `json:"osUsers,omitempty"`
	// OSGroups matches any group the account belongs to, by group name or
	// stable id (a gid, or a SID on Windows). Names compare
	// case-insensitively.
	OSGroups []string `json:"osGroups,omitempty"`

	Subjects  []string            `json:"subjects,omitempty"`
	Providers []string            `json:"providers,omitempty"`
	Claims    map[string][]string `json:"claims,omitempty"`
}

// SessionScoped reports whether the match names a principal dimension. Such
// an entry is resolved for each session against that session's principal;
// an entry with OS dimensions only is resolved once for the engine process.
func (m AccountMatch) SessionScoped() bool {
	return len(m.Subjects) > 0 || len(m.Providers) > 0 || len(m.Claims) > 0
}

// PrincipalMatch returns the principal dimensions as a PrincipalMatch.
func (m AccountMatch) PrincipalMatch() PrincipalMatch {
	return PrincipalMatch{Subjects: m.Subjects, Providers: m.Providers, Claims: m.Claims}
}
