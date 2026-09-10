package auth

import (
	"fmt"
	"unicode/utf16"
)

// Windows Credential Manager addresses a generic credential by a single
// TargetName string, where the callers here have a (service, account) pair —
// "ion-engine" and the provider id. Joining them with a colon is the
// convention Windows tooling uses for a service-scoped generic credential,
// and it keeps one provider's entry from colliding with another's.
//
// Kept out of the windows-only file so it is compiled and tested on every
// platform: the mapping is what an operator has to reproduce by hand when
// they store a key in Credential Manager themselves, so it must not drift
// silently.
func credentialTargetName(service, account string) string {
	return fmt.Sprintf("%s:%s", service, account)
}

// Windows stores a generic credential's secret as an opaque byte blob and
// records no encoding for it. The convention every Windows credential tool
// follows — cmdkey, the Credential Manager UI, the PasswordVault API — is
// UTF-16LE, so that is what is written and what is read back. One encoding,
// both directions: guessing at the blob's encoding on read would make a
// credential's value depend on which characters happen to be in it.
func encodeCredentialBlob(secret string) []byte {
	units := utf16.Encode([]rune(secret))
	out := make([]byte, len(units)*2)
	for i, u := range units {
		out[i*2] = byte(u)
		out[i*2+1] = byte(u >> 8)
	}
	return out
}

// decodeCredentialBlob reverses encodeCredentialBlob. An odd-length blob is
// not UTF-16 at all, so it is reported rather than silently truncated — a
// credential decoded to the wrong value is worse than one that fails to
// resolve, because it reaches the provider as a bad key.
func decodeCredentialBlob(blob []byte) (string, error) {
	if len(blob)%2 != 0 {
		return "", fmt.Errorf("credential blob is %d bytes, which is not UTF-16", len(blob))
	}
	units := make([]uint16, len(blob)/2)
	for i := range units {
		units[i] = uint16(blob[i*2]) | uint16(blob[i*2+1])<<8
	}
	return string(utf16.Decode(units)), nil
}
