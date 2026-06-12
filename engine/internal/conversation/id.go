package conversation

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"sync/atomic"
	"time"
)

// convSuffixCounter is a fallback used only when crypto/rand fails (it never
// has, but the disk could be full at exactly the wrong moment). Combined with
// the millisecond timestamp it still produces unique conversation IDs.
var convSuffixCounter uint64

// NewConvSuffix returns a 12-hex-char random suffix. Callers prepend a
// millisecond timestamp; the combined id is the conversation file name.
// Two runs that begin in the same millisecond see different suffixes, so
// their conversation files cannot collide.
func NewConvSuffix() string {
	var b [6]byte
	if _, err := rand.Read(b[:]); err != nil {
		return fmt.Sprintf("%012x", atomic.AddUint64(&convSuffixCounter, 1))
	}
	return hex.EncodeToString(b[:])
}

// NewConversationID generates a conversation ID in the canonical format:
// {unix_millis}-{12_hex_chars}. Used by both the backend runloop (when no
// SessionID is supplied) and the session manager (to pre-mint an ID at
// StartSession time so clients receive it before the first prompt).
func NewConversationID() string {
	return fmt.Sprintf("%d-%s", time.Now().UnixMilli(), NewConvSuffix())
}
