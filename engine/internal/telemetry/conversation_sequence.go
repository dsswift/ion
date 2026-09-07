package telemetry

import (
	"strings"
	"sync"
	"time"
)

// conversation_sequence.go is the ordering contract for the conversation.*
// stream: every event of a conversation carries a payload "seq" that is
// strictly increasing for that conversation within one engine process, and
// the seq is assigned in the same critical section as the event's ts.
//
// A consumer orders a conversation's events by ts and then by seq. ts alone
// is almost always enough — it is UTC at nanosecond precision — but "almost"
// is not a contract: two emissions from concurrent goroutines can be
// stamped out of the order they were sequenced in if ts and seq are taken
// under different locks, and a wall clock can step backwards under NTP.
// Taking both under one lock makes seq order and ts order agree within a
// process, so a consumer that sorts by (ts, seq) reconstructs the exact
// emission order. seq restarts at 1 when the engine restarts; ts carries
// the order across that boundary.
//
// Only the conversation.* family is sequenced. Other telemetry events are
// not a per-conversation log and get no seq.

// conversationEventPrefix is the family every sequenced event belongs to.
const conversationEventPrefix = "conversation."

// conversationSequencer hands out per-conversation sequence numbers and the
// timestamp that goes with each, atomically.
type conversationSequencer struct {
	mu   sync.Mutex
	next map[string]int64
}

func newConversationSequencer() *conversationSequencer {
	return &conversationSequencer{next: map[string]int64{}}
}

// stamp returns the event's ts and, for a conversation.* event whose
// payload names its conversation, its seq — both taken under one lock so
// they agree. Events outside the family, or without a conversation_id, get
// a ts and seq 0 (meaning "not sequenced"; the caller omits the key).
func (s *conversationSequencer) stamp(name string, payload map[string]any) (ts time.Time, seq int64) {
	id, ok := payload["conversation_id"].(string)
	if !strings.HasPrefix(name, conversationEventPrefix) || !ok || id == "" {
		return time.Now().UTC(), 0
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.next[id]++
	return time.Now().UTC(), s.next[id]
}

// forget drops a conversation's counter once it can never emit again — a
// deleted conversation — so a long-lived daemon does not hold one entry per
// conversation it has ever seen.
func (s *conversationSequencer) forget(conversationID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.next, conversationID)
}

// isTerminalLifecycle reports whether a conversation.lifecycle payload marks
// the conversation as deleted, the one action after which no further event
// for that id can arrive.
func isTerminalLifecycle(name string, payload map[string]any) bool {
	if name != ConversationLifecycle {
		return false
	}
	action, _ := payload["action"].(string) //nolint:errcheck // a missing action is simply not terminal
	return action == string(ActionDeleted)
}
