package backend

import (
	"errors"

	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/telemetry"
	"github.com/dsswift/ion/engine/internal/types"
)

// conversation_spans.go wraps the conversation store's disk I/O in the
// conversation.persist and conversation.load spans. The conversation package
// cannot record them itself (the telemetry package depends on it), so every
// backend write and the run's load go through these two helpers, which carry
// the run's correlation so each span is run.execute's child.

// persistConversation is conversation.Save recorded as a conversation.persist
// span on the run's collector. A nil run or no collector is a plain Save.
func persistConversation(run *activeRun, conv *conversation.Conversation) error {
	telem := runTelemetry(run)
	if telem == nil || conv == nil {
		return conversation.Save(conv, "")
	}
	span := telem.StartSpanCtx(telemetry.ConversationPersist, map[string]interface{}{
		"messages": len(conv.Messages), "entries": len(conv.Entries),
	}, buildTelemCtx(run))
	err := conversation.Save(conv, "")
	errMsg := ""
	if err != nil {
		errMsg = err.Error()
	}
	span.End(nil, errMsg)
	return err
}

// loadOrCreateConversationSpan is loadOrCreateConversation recorded as a
// conversation.load span. A fresh conversation (not found, then created) is
// not a span error; attribute created says which happened.
func loadOrCreateConversationSpan(run *activeRun, opts types.RunOptions, model string) (*conversation.Conversation, error) {
	telem := runTelemetry(run)
	if telem == nil {
		return loadOrCreateConversation(opts, model)
	}
	span := telem.StartSpanCtx(telemetry.ConversationLoad, map[string]interface{}{"source": "run"}, buildTelemCtx(run))
	conv, err := loadOrCreateConversation(opts, model)
	attrs := map[string]interface{}{}
	errMsg := ""
	switch {
	case err != nil && !errors.Is(err, conversation.ErrNotFound):
		errMsg = err.Error()
	case conv != nil:
		attrs["messages"] = len(conv.Messages)
		attrs["entries"] = len(conv.Entries)
		// Created when the store had no file: the loaded entry count is
		// then zero and the conversation carries only the system prompt.
		attrs["created"] = len(conv.Entries) == 0 && len(conv.Messages) == 0
	}
	span.End(attrs, errMsg)
	return conv, err
}
