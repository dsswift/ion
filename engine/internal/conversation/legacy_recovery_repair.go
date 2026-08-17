package conversation

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

var legacyRecoveryMapEnvelope = regexp.MustCompile(`(?s)^\[map\[text:(.*) type:text\]\]$`)
var legacyRecoveryAttachmentMarker = regexp.MustCompile(`\[Attachment: ([a-f0-9]{64}\.(?:png|jpe?g|gif|webp|heic|heif)) \(content attached\)\]`)
var legacyParkedReviveOne = "[SYSTEM] Your dispatched agent has completed. Its result is below. Continue your task from where you parked — your earlier work is in this conversation; do NOT restart from the beginning.\n"
var legacyParkedReviveMany = regexp.MustCompile(`^\[SYSTEM\] All [1-9][0-9]* dispatched agents you were waiting on have completed\. Their results are below\. Continue your task from where you parked — your earlier work is in this conversation; do NOT restart from the beginning\.\n`)
var legacyRootDispatchCompletion = regexp.MustCompile(`(?s)^\[Agent [^\]\r\n]+ (?:completed|failed|recalled)\]\r?\nDispatch ID: dispatch-[^\s\r\n]+\r?\nElapsed: [0-9]+(?:\.[0-9]+)?s(?:\r?\n|$)`)

const legacyParkedReviveEmpty = "[SYSTEM] You have been revived from a parked state. The work you were waiting on has settled, but no child results were recorded — check your dispatch state (or the conversation above) and continue from where you left off. Do NOT restart the task from the beginning; your earlier work is in this conversation."

const recoveryRepairVersion = 1

// repairLegacyRecoveryState repairs only signatures emitted by the short-lived
// recovery implementation. It never guesses from ordinary user prose: malformed
// map envelopes, content-addressed attachment markers, and parked-revival text
// each have a precise, independently-verifiable shape.
func repairLegacyRecoveryState(conv *Conversation) bool {
	if conv == nil || conv.RecoveryRepairVersion >= recoveryRepairVersion {
		return false
	}
	repairedAny := false

	for i := range conv.Entries {
		entry := &conv.Entries[i]
		if entry.Type != EntryMessage {
			continue
		}
		message := asMessageData(entry.Data)
		if message == nil {
			continue
		}

		content, repaired := repairLegacyRecoveryContent(message.Content, conv.ID)
		if repaired {
			repairedAny = true
			message.Content = content
			entry.Data = *message
			utils.LogWithFields(utils.LevelInfo, "conversation.recovery_repair", "repaired legacy recovery entry content", map[string]any{
				"conversation_id": conv.ID,
				"entry_id":        entry.ID,
			})
		}
		if message.LlmContent != nil {
			llmContent, llmRepaired := repairLegacyRecoveryContent(message.LlmContent, conv.ID)
			if llmRepaired {
				repairedAny = true
				message.LlmContent = llmContent
				entry.Data = *message
				utils.LogWithFields(utils.LevelInfo, "conversation.recovery_repair", "repaired legacy recovery entry LLM content", map[string]any{
					"conversation_id": conv.ID,
					"entry_id":        entry.ID,
				})
			}
		}

		if message.Role == "user" && message.InjectionKind == "" {
			kind := legacyDispatchInjectionKind(legacyRecoveryMessageText(message.Content))
			if kind == "" {
				continue
			}
			message.InjectionKind = kind
			repairedAny = true
			message.MachineAuthored = true
			entry.Data = *message
			utils.LogWithFields(utils.LevelInfo, "conversation.recovery_repair", "classified legacy dispatch delivery", map[string]any{
				"conversation_id": conv.ID,
				"entry_id":        entry.ID,
				"injection_kind":  kind,
			})
		}
	}

	for i := range conv.Messages {
		content, repaired := repairLegacyRecoveryContent(conv.Messages[i].Content, conv.ID)
		if !repaired {
			continue
		}
		repairedAny = true
		conv.Messages[i].Content = content
		utils.LogWithFields(utils.LevelInfo, "conversation.recovery_repair", "repaired legacy recovery provider content", map[string]any{
			"conversation_id": conv.ID,
			"index":           i,
		})
	}
	conv.RecoveryRepairVersion = recoveryRepairVersion
	conv._recoveryRepairPending = true
	// Returning true includes the version stamp. Load persists this marker before
	// returning, so later loads skip this full legacy sweep.
	return repairedAny || conv.RecoveryRepairVersion == recoveryRepairVersion
}

func repairLegacyRecoveryContent(content any, conversationID string) (any, bool) {
	blocks := contentToBlocks(content)
	if len(blocks) == 0 {
		return content, false
	}

	repaired := false
	out := make([]types.LlmContentBlock, 0, len(blocks))
	for _, block := range blocks {
		if block.Type != "text" {
			out = append(out, block)
			continue
		}
		match := legacyRecoveryMapEnvelope.FindStringSubmatch(block.Text)
		if len(match) == 0 {
			out = append(out, block)
			continue
		}

		block.Text = match[1]
		out = append(out, block)
		repaired = true
		for _, marker := range legacyRecoveryAttachmentMarker.FindAllStringSubmatch(match[1], -1) {
			attachment, ok := legacyRecoveryAttachment(marker[1])
			if !ok {
				utils.LogWithFields(utils.LevelWarn, "conversation.recovery_repair", "legacy attachment marker could not be verified", map[string]any{
					"conversation_id": conversationID,
					"name":            marker[1],
				})
				continue
			}
			out = append(out, attachment)
		}
	}
	if !repaired {
		return content, false
	}
	return out, true
}

func legacyRecoveryAttachment(name string) (types.LlmContentBlock, bool) {
	ext := filepath.Ext(name)
	mediaType := map[string]string{
		".png":  "image/png",
		".jpg":  "image/jpeg",
		".jpeg": "image/jpeg",
		".gif":  "image/gif",
		".webp": "image/webp",
		".heic": "image/heic",
		".heif": "image/heif",
	}[ext]
	if mediaType == "" {
		return types.LlmContentBlock{}, false
	}

	path := filepath.Join(filepath.Dir(DefaultConversationsDir()), "user-images", name)
	data, err := os.ReadFile(path)
	if err != nil {
		return types.LlmContentBlock{}, false
	}
	digest := sha256.Sum256(data)
	if hex.EncodeToString(digest[:]) != strings.TrimSuffix(name, ext) {
		return types.LlmContentBlock{}, false
	}
	return types.LlmContentBlock{Type: "image", Source: &types.ImageSource{
		Type:      "base64",
		MediaType: mediaType,
		Data:      base64.StdEncoding.EncodeToString(data),
	}}, true
}

// legacyRecoveryMessageText returns the row's leading text for signature
// matching. It reads the FIRST text block rather than requiring a singleton:
// a dispatch delivery frequently carries a trailing structural block (a
// skill_listing, for instance), and gating on len(blocks)==1 left every such
// row unclassified even though its text matched exactly.
func legacyRecoveryMessageText(content any) string {
	for _, block := range contentToBlocks(content) {
		if block.Type == "text" {
			return block.Text
		}
	}
	return ""
}

func legacyDispatchInjectionKind(text string) string {
	if legacyRootDispatchCompletion.MatchString(text) {
		return string(types.InjectionKindAgentCompletion)
	}
	return legacyParkedRevivalKind(text)
}

func legacyParkedRevivalKind(text string) string {
	if text == legacyParkedReviveEmpty {
		return string(types.InjectionKindRevive)
	}
	if (strings.HasPrefix(text, legacyParkedReviveOne) || legacyParkedReviveMany.MatchString(text)) && strings.Contains(text, "\n--- [") {
		return string(types.InjectionKindAgentCompletion)
	}
	return ""
}
