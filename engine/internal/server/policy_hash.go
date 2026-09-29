package server

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
)

// canonicalPolicyHash returns the SHA-256 hex digest of policy's canonical
// JSON encoding (manifest C2's get_enterprise_policy.policyHash). Go's
// encoding/json is already deterministic for this purpose: struct fields
// serialize in declaration order and map keys are sorted, so two calls with
// an unchanged policy value always produce identical bytes and therefore an
// identical hash, and a genuinely changed policy always produces a
// different one. A nil policy hashes the empty JSON object so a server with
// no enterprise policy configured still returns a stable, well-defined hash
// rather than an empty string a consumer might mistake for "not computed".
func canonicalPolicyHash(policy interface{}) string {
	if policy == nil {
		policy = map[string]interface{}{}
	}
	encoded, err := json.Marshal(policy)
	if err != nil {
		// Marshal failure on an already-validated in-memory config is not
		// expected; hash the error string so callers still get a stable
		// (if diagnostic) value rather than a crash or an empty string.
		encoded = []byte(err.Error())
	}
	sum := sha256.Sum256(encoded)
	return hex.EncodeToString(sum[:])
}
