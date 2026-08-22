package conversation

// list_flatten.go — the entry-flattening cluster split out of list.go (file-size
// cap). flattenEntries walks a conversation's context path and produces the
// flat SessionMessage list clients render; imageAttachmentFromBlock re-derives
// on-disk image paths from persisted base64 blocks for historical reload.

import (
	"encoding/json"
	"fmt"
	"path/filepath"
	"strings"

	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// flattenEntries walks the context path entries and produces SessionMessages.
// Tool results are merged into their matching tool-call messages (same ToolID)
// so the client receives a single message with both call and result data.
func flattenEntries(conv *Conversation) []types.SessionMessage {
	path := getContextPathEntries(conv)

	// First pass: collect all messages and build a toolID → index map for tool calls.
	var result []types.SessionMessage
	toolCallIndex := map[string]int{} // toolID → index in result

	// rowID assigns the canonical row id: the entry id for the first row an
	// entry produces, "<entryId>:<n>" for subsequent rows. Stable across
	// reloads (entry ids are persisted), so every consumer shares one
	// id-space and history reloads dedup against live rows re-keyed at
	// message_end. The scheme is part of the wire contract — see
	// types.SessionMessage.ID.
	rowID := func(entryID string, rowIdx int) string {
		if rowIdx == 0 {
			return entryID
		}
		return fmt.Sprintf("%s:%d", entryID, rowIdx)
	}

	for _, entry := range path {
		switch entry.Type {
		case EntryCompaction:
			// Replay a persisted compaction event as a system-role marker row so
			// the marker survives historical reload (it renders live via
			// CompactingEvent, but that event is not persisted). Content carries
			// the "[Compaction]" sentinel the iOS detection code already looks
			// for; the structured Marker* fields carry the payload consumers
			// format from. Engine emits data, not display strings.
			cd := asCompactionData(entry.Data)
			if cd == nil {
				continue
			}
			result = append(result, types.SessionMessage{
				ID:                   rowID(entry.ID, 0),
				Role:                 "system",
				Content:              "[Compaction]",
				Timestamp:            entry.Timestamp,
				MarkerKind:           "compaction",
				MarkerSummary:        cd.Summary,
				MarkerMessagesBefore: cd.MessagesBefore,
				MarkerMessagesAfter:  cd.MessagesAfter,
				MarkerClearedBlocks:  cd.ClearedBlocks,
				MarkerStrategy:       cd.Strategy,
				MarkerMicroOnly:      cd.MicroOnly,
			})
			continue
		case EntryPlanMarker:
			// Replay a persisted plan-file-written event as a system-role marker
			// row. Content carries the "──" sentinel the iOS detection code
			// already looks for; the structured MarkerPlan* fields carry the
			// payload consumers format from.
			pd := asPlanMarkerData(entry.Data)
			if pd == nil {
				continue
			}
			result = append(result, types.SessionMessage{
				ID:                  rowID(entry.ID, 0),
				Role:                "system",
				Content:             "──",
				Timestamp:           entry.Timestamp,
				MarkerKind:          "plan",
				MarkerPlanOperation: pd.Operation,
				MarkerPlanFilePath:  pd.PlanFilePath,
				MarkerPlanSlug:      pd.PlanSlug,
			})
			continue
		case EntrySteerMarker:
			// Replay a persisted steer-injection event as a system-role marker
			// row. This is an additional row alongside the injected user message
			// (which flattens separately from its EntryMessage), not a
			// replacement. Content carries the "──" sentinel.
			sd := asSteerMarkerData(entry.Data)
			if sd == nil {
				continue
			}
			result = append(result, types.SessionMessage{
				ID:                    rowID(entry.ID, 0),
				Role:                  "system",
				Content:               "──",
				Timestamp:             entry.Timestamp,
				MarkerKind:            "steer",
				MarkerMessageLength:   sd.MessageLength,
				MarkerMachineAuthored: parentMessageMachineAuthored(conv, entry.ParentID),
			})
			continue
		case EntryCleared:
			// Replay a persisted /clear checkpoint as a system-role marker row.
			// Clients format the "── Cleared at ──" divider from MarkerKind
			// and the entry timestamp. Content carries the "──" sentinel the
			// iOS detection code already looks for; no structured payload
			// fields are needed (ClearedData is empty).
			result = append(result, types.SessionMessage{
				ID:         rowID(entry.ID, 0),
				Role:       "system",
				Content:    "──",
				Timestamp:  entry.Timestamp,
				MarkerKind: "clear",
			})
			continue
		case EntryDispatchError:
			// Replay a terminal dispatch failure discovered after the child
			// backend's final save. Content starts with "Error:" so existing clients
			// render it through their standard system-error treatment; the typed
			// entry carries the durable semantics and keeps the data out of LLM
			// context (buildContextPath ignores this entry type).
			dd := asDispatchErrorData(entry.Data)
			if dd == nil || dd.Message == "" {
				utils.LogWithFields(utils.LevelWarn, "conversation", "flatten: malformed dispatch error dropped", map[string]any{
					"conversation_id": conv.ID,
					"entry_id":        entry.ID,
				})
				continue
			}
			result = append(result, types.SessionMessage{
				ID:        rowID(entry.ID, 0),
				Role:      "system",
				Content:   "Error: " + dd.Message,
				Timestamp: entry.Timestamp,
			})
			continue
		case EntryMessage:
			// falls through to the message-flattening logic below
		default:
			continue
		}
		md := asMessageData(entry.Data)
		if md == nil {
			continue
		}
		legacyWork := legacyBackgroundWork(conv, entry, md)

		blocks := contentToBlocks(md.Content)
		switch md.Role {
		case "user":
			// Discriminate tool-result carriers from genuine user prompts.
			// Tool results ride in user-role messages in the LLM transcript,
			// and their image blocks belong to the owning tool-call row. A
			// user-role entry with NO tool_result blocks is a real user
			// prompt (client attachments via RunOptions.Attachments →
			// buildUserContentBlocks), and its image blocks belong on the
			// user row itself. Without this split, prompt images fell into
			// the legacy last-tool-row heuristic below and were misattached
			// to a prior turn's tool call — or silently dropped when no tool
			// row existed (the first message of a conversation).
			isToolResultCarrier := false
			for _, b := range blocks {
				if b.Type == "tool_result" {
					isToolResultCarrier = true
					break
				}
			}
			var textParts []string
			var promptAttachments []types.SessionMessageAttachment
			for _, b := range blocks {
				switch b.Type {
				case SkillListingBlockType, SkillContentBlockType:
					// Internal lifecycle metadata rides this carrier for provider role
					// alternation but never becomes a transcript row.
					continue
				case "text":
					if b.Text != "" {
						textParts = append(textParts, b.Text)
					}
				case "tool_result":
					// Merge result content into the matching tool-call message.
					if idx, ok := toolCallIndex[b.ToolUseID]; ok {
						result[idx].Content = b.Content
						result[idx].IsError = b.IsError != nil && *b.IsError
						bgID := b.BackgroundTaskID
						if bgID == "" {
							bgID, _ = types.ParseCanonicalBashStartResult(b.Content)
						}
						result[idx].BackgroundTaskID = bgID
					} else {
						// No matching tool call: the orphan result is dropped
						// from the flattened view. Post-repair this should
						// never fire; if it does, the chain is losing data
						// again — say so instead of silently thinning history.
						utils.LogWithFields(utils.LevelWarn, "conversation", "flatten: orphan tool_result dropped", map[string]any{
							"conversation_id": conv.ID,
							"tool_use_id":     b.ToolUseID,
						})
					}
				case "image", "document":
					// A persisted media block. Two provenances share this
					// block type, discriminated by the entry's tool_result
					// blocks (isToolResultCarrier above):
					//
					//   - Tool-result carrier: the live path emitted an
					//     ImageContentEvent per image and clients attached it
					//     to the owning tool message; that event is not
					//     persisted, so on reload we replay the reference
					//     here. The image block carries the owning tool
					//     call's id in ToolUseID (set by AddToolResults).
					//   - Genuine user prompt: the client sent the image as a
					//     prompt attachment (RunOptions.Attachments →
					//     buildUserContentBlocks). It belongs on the user row
					//     built at the end of this branch.
					//
					// Either way, re-derive the on-disk path from the base64
					// bytes (content-addressed, idempotent: this resolves to
					// the same file the live save wrote, creating it only if
					// it was pruned).
					att := imageAttachmentFromBlock(conv.ID, b)
					if att == nil {
						break
					}
					if !isToolResultCarrier {
						// User-prompt attachment: attach to the user row.
						// Non-image media (e.g. a PDF document block) is
						// typed "file" so clients don't try to render it as
						// an image; name/path still flow for display.
						if !strings.HasPrefix(b.Source.MediaType, "image/") {
							att.Type = "file"
						}
						promptAttachments = append(promptAttachments, *att)
						break
					}
					if b.ToolUseID != "" {
						if idx, ok := toolCallIndex[b.ToolUseID]; ok {
							result[idx].Attachments = append(result[idx].Attachments, *att)
						}
						// An image with a non-empty ToolUseID but no matching
						// tool call (orphan) is dropped, mirroring the
						// orphan-tool_result handling above.
					} else {
						// Legacy pre-ToolUseID images: persisted before the
						// ToolUseID stamping was added (commit b9f399e2), so
						// b.ToolUseID is empty and the toolCallIndex lookup
						// above can never match. The persisted block order is
						// [tool_result, tool_result, image, image], so the
						// images belong to the most recent tool-call message.
						// Attach to the last tool-role row in result. This is a
						// positional heuristic for pre-fix data only; new data
						// carries the precise ToolUseID association above.
						for i := len(result) - 1; i >= 0; i-- {
							if result[i].Role == "tool" {
								result[i].Attachments = append(result[i].Attachments, *att)
								break
							}
						}
					}
				}
			}
			if len(textParts) > 0 || len(promptAttachments) > 0 {
				content := strings.Join(textParts, "\n")
				result = append(result, types.SessionMessage{
					ID:        rowID(entry.ID, 0),
					Role:      "user",
					Content:   content,
					Timestamp: entry.Timestamp,
					Internal:  isInternalMessage(content),
					// Slash-command provenance: when this user turn was a
					// resolved slash invocation, Content already holds the raw
					// invocation (the engine stored it as the entry display
					// content; the expanded body lives only in the .llm.jsonl).
					// Forward the provenance so consumers render a command pill.
					SlashCommand:        md.SlashCommand,
					SlashArgs:           md.SlashArgs,
					SlashSource:         md.SlashSource,
					SlashModelAlias:     md.SlashModelAlias,
					SlashModelEffective: md.SlashModelEffective,
					// InjectionKind classifies engine-injected turns. Propagate
					// from the persisted MessageData entry so consumers can
					// classify the turn on historical reload without inspecting
					// the raw entry file.
					InjectionKind: md.InjectionKind,
					// MachineAuthored rides along so a consumer's reload filter
					// reads the same field its live-event filter does. Legacy
					// rows predate the persisted flag, so re-derive from the
					// kind rather than reporting a stored false as authoritative
					// — otherwise every pre-existing agent_completion row would
					// reload as a user-authored turn.
					MachineAuthored: md.MachineAuthored ||
						types.InjectionKind(md.InjectionKind).IsMachineToMachine(),
					BackgroundWork: func() *types.BackgroundWorkInfo {
						if md.BackgroundWork != nil {
							return md.BackgroundWork
						}
						return legacyWork
					}(),
					// Prompt attachments (client-sent images/documents) replayed
					// onto the user row so history loads carry the same
					// structured references the live echo did. Empty for
					// tool-result carriers — their images attach to the owning
					// tool row above.
					Attachments: promptAttachments,
				})
			}

		case "assistant":
			entryRowIdx := 0
			// Tracks the index (in result) of the last assistant text row from
			// THIS entry, so provider-generated image blocks attach to their
			// sibling text row (e.g. the revised prompt) when one exists.
			lastAssistantRowIdx := -1
			for _, b := range blocks {
				switch b.Type {
				case "text":
					if b.Text != "" {
						lastAssistantRowIdx = len(result)
						result = append(result, types.SessionMessage{
							ID:        rowID(entry.ID, entryRowIdx),
							Role:      "assistant",
							Content:   b.Text,
							Timestamp: entry.Timestamp,
						})
						entryRowIdx++
					}
				case "tool_use":
					inputJSON := ""
					if b.Input != nil {
						raw, err := json.Marshal(b.Input)
						if err == nil {
							inputJSON = string(raw)
						}
					}
					toolCallIndex[b.ID] = len(result)
					result = append(result, types.SessionMessage{
						ID:        rowID(entry.ID, entryRowIdx),
						Role:      "tool",
						ToolName:  b.Name,
						ToolID:    b.ID,
						ToolInput: inputJSON,
						Timestamp: entry.Timestamp,
					})
					entryRowIdx++
				case "image", "document":
					// Provider-generated media persisted on the assistant
					// entry (image-generation models via runImageLoop, or
					// inline image output from chat models like GPT-4o).
					// Re-derive the content-addressed on-disk path from the
					// persisted base64 bytes — identical mechanism to the
					// tool-result image replay above — and attach it to the
					// sibling assistant text row when one exists (the revised
					// prompt), else emit a standalone assistant row carrying
					// only the attachment.
					att := imageAttachmentFromBlock(conv.ID, b)
					if att == nil {
						break
					}
					if lastAssistantRowIdx >= 0 {
						result[lastAssistantRowIdx].Attachments = append(result[lastAssistantRowIdx].Attachments, *att)
					} else {
						lastAssistantRowIdx = len(result)
						result = append(result, types.SessionMessage{
							ID:          rowID(entry.ID, entryRowIdx),
							Role:        "assistant",
							Timestamp:   entry.Timestamp,
							Attachments: []types.SessionMessageAttachment{*att},
						})
						entryRowIdx++
					}
				}
			}
		}
	}

	return result
}

// imageAttachmentFromBlock turns a persisted "image" content block into a
// SessionMessageAttachment for historical reload. The persisted block stores
// the image inline as base64 (types.ImageSource); the engine never puts base64
// on the wire, so this re-derives the on-disk file path by saving the bytes
// through the shared content-addressed saver. Because SaveImageToConversation
// is content-addressed and idempotent, this resolves to the exact file the
// live emit-time save already wrote — no duplicate — and only writes when the
// file is missing (e.g. pruned). Returns nil when the block has no image source
// or the save fails (the image is dropped rather than emitting a dangling path).
func imageAttachmentFromBlock(convID string, b types.LlmContentBlock) *types.SessionMessageAttachment {
	if b.Source == nil || b.Source.Data == "" || convID == "" {
		return nil
	}
	contentHash := b.Source.ContentHash
	if contentHash == "" {
		var hashErr error
		contentHash, hashErr = ContentHashFromBase64(b.Source.Data)
		if hashErr != nil {
			utils.LogWithFields(utils.LevelError, "conversation", "reload image attachment hash failed; dropping", map[string]any{
				"conversation_id": convID, "mediaType": b.Source.MediaType, "tool_use_id": b.ToolUseID, "error": utils.ErrStr(hashErr),
			})
			return nil
		}
	}
	path, err := SaveImageToConversation("", convID, b.Source.MediaType, b.Source.Data)
	if err != nil {
		utils.LogWithFields(utils.LevelError, "conversation", "reload image attachment save failed; dropping", map[string]any{
			"conversation_id": convID,
			"mediaType":       b.Source.MediaType,
			"tool_use_id":     b.ToolUseID,
			"error":           utils.ErrStr(err),
		})
		return nil
	}
	name := path
	if i := strings.LastIndex(name, string(filepath.Separator)); i >= 0 {
		name = name[i+1:]
	}
	return &types.SessionMessageAttachment{
		ID:          "img:" + path,
		Type:        "image",
		Name:        name,
		Path:        path,
		MediaType:   b.Source.MediaType,
		ContentHash: contentHash,
	}
}
