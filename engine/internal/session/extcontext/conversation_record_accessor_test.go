package extcontext

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/extension"
)

type recordSA struct {
	noopSA
	path string
}

func (a recordSA) ConversationRecordPath() string { return a.path }
func (a recordSA) ReadConversation(conversationID string, _, _ int) (*extension.ConversationRecord, error) {
	return &extension.ConversationRecord{Total: len(conversationID)}, nil
}

func TestNewExtContext_WiresConversationRecordAccess(t *testing.T) {
	ctx := NewExtContext(recordSA{path: "/data/conversations/c1.tree.jsonl"}, NewDispatchRegistry())
	if ctx.ConversationRecordPath != "/data/conversations/c1.tree.jsonl" {
		t.Errorf("ConversationRecordPath = %q", ctx.ConversationRecordPath)
	}
	if ctx.ReadConversation == nil {
		t.Fatal("ReadConversation not wired")
	}
	record, err := ctx.ReadConversation("abc", 0, 0)
	if err != nil || record.Total != 3 {
		t.Errorf("ReadConversation = %+v, %v; want the accessor's result", record, err)
	}
}

// An accessor without the capability leaves both unset, so the path stays
// empty and the read RPC reports itself unavailable.
func TestNewExtContext_NoConversationRecordAccessor(t *testing.T) {
	ctx := NewExtContext(noopSA{}, NewDispatchRegistry())
	if ctx.ConversationRecordPath != "" || ctx.ReadConversation != nil {
		t.Errorf("expected no record access, got path %q, reader set %v", ctx.ConversationRecordPath, ctx.ReadConversation != nil)
	}
}
