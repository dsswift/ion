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

// legacyHarnessDispatchEnvelope matches the dispatch-result envelope a harness
// wrote through ctx.sendMessage before the SDK carried an injection kind.
//
// Anchored on the shapes real conversation files contain, which are narrower
// than the verb set alone suggests. An operator writes about dispatches
// constantly, and a false positive here silently deletes their own message from
// their transcript — worse than the leak this repairs. So the pattern admits
// exactly two forms:
//
//	[Agent X completed in Ns]      — also: recalled after Ns, timed out after
//	                                 Ns, produced a plan in Ns
//	[Agent X failed]: <reason>     — the only bare-verb form; always a colon
//
// A duration is REQUIRED for every verb except `failed`. That is what keeps a
// bare "[Agent worker completed]" out: the harness never emits it, and the one
// producer that does emit a bare verb is the engine's own envelope, which
// legacyRootDispatchCompletion matches by its "Dispatch ID:" line instead.
//
// What may follow a duration-bearing bracket is limited to the two tails the
// producers actually emit on the same line: a bare snake_case recall reason
// (`recall_agent`, `recalled`) or the fixed phrase "Dispatch timed out". Free
// prose does not match, so "[Agent X completed in 5s] — why so slow?" stays a
// user message.
var legacyHarnessDispatchEnvelope = regexp.MustCompile(
	`^\[Agent [^\]\r\n]+ (?:` +
		`(?:completed|recalled|timed out|produced a plan|produced no output) (?:in|after) [0-9]+(?:\.[0-9]+)?s\]` +
		`(?:\r?\n|$|[ ](?:[a-z][a-z_]*|Dispatch timed out)(?:\r?\n|$))` +
		`|failed\]: [^\r\n]*` +
		`)`)

// legacyHarnessDispatchLost matches the engine-restart loss notice a harness
// posts when a dispatch can never report back. Its own shape because it carries
// no verb from the set above.
//
// Classified as a revive, matching what the live harness path assigns today:
// the notice is a wake telling the parent to reassess, not a child's result.
var legacyHarnessDispatchLost = regexp.MustCompile(`^\[Agent [^\]\r\n]+ was LOST — the engine restarted while it was running\](?:\r?\n|$)`)

// legacyHarnessChildQuestion matches the bubbled child-question notice. It is a
// wake rather than a result — the child is still running and the parent is
// being asked to answer — so it classifies as a revive.
var legacyHarnessChildQuestion = regexp.MustCompile(`^\[Agent [^\]\r\n]+ is waiting for your answer\](?:\r?\n|$)`)

// legacyPlanModeReminder matches the engine's plan-mode steering reminder.
// Transient today (backend.injectSystemMessage always injects it in-memory),
// but earlier versions persisted it, and it is by far the most common leaked
// row in real conversation files.
//
// Requires the sentence to continue past the phrase, so a user asking "[SYSTEM]
// Plan mode still active — but I never entered plan mode?" does not match.
var legacyPlanModeReminder = regexp.MustCompile(`^\[SYSTEM\] Plan mode still active \(see full instructions`)

// legacyDispatchCheckIn matches the harness idle heartbeat. The header line is
// fixed and followed by a blank line and the digest body.
var legacyDispatchCheckIn = regexp.MustCompile(`^\[SYSTEM\] Dispatch check-in\r?\n\r?\n`)

const legacyParkedReviveEmpty = "[SYSTEM] You have been revived from a parked state. The work you were waiting on has settled, but no child results were recorded — check your dispatch state (or the conversation above) and continue from where you left off. Do NOT restart the task from the beginning; your earlier work is in this conversation."

// recoveryRepairVersion gates the legacy sweep: a conversation whose header
// already records this version skips it entirely.
//
// Bump this when the sweep learns to repair a signature it previously missed,
// or conversations swept under the older version keep their unrepaired rows
// forever. Version 2 added the run-recovery continuation signature — files
// swept at version 1 still carry those rows unclassified, so they must be
// re-examined once.
const recoveryRepairVersion = 2

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

// legacyDispatchInjectionKind classifies a legacy user row as a
// machine-authored injection, or returns "" to leave it alone.
//
// Every signature here matches ONE known producer's exact output shape. None of
// them is a prose heuristic: a row wrongly classified is a real user message
// silently removed from the operator's own transcript, which is strictly worse
// than the leaked machine row this repairs. When in doubt, return "".
func legacyDispatchInjectionKind(text string) string {
	switch {
	case legacyRootDispatchCompletion.MatchString(text),
		legacyHarnessDispatchEnvelope.MatchString(text):
		// A child's terminal result arriving at its parent. How it terminated
		// (completed / failed / recalled / timed out) is in the body; the
		// classification only says a dispatch reported back.
		return string(types.InjectionKindAgentCompletion)
	case legacyHarnessDispatchLost.MatchString(text),
		legacyHarnessChildQuestion.MatchString(text):
		// Neither is a result. A loss notice says a result will never arrive;
		// a bubbled question says the child is still running and needs an
		// answer. Both are wakes telling the parent to act.
		return string(types.InjectionKindRevive)
	case legacyDispatchCheckIn.MatchString(text):
		return string(types.InjectionKindCheckIn)
	case legacyPlanModeReminder.MatchString(text):
		return string(types.InjectionKindSystemSteer)
	case text == RecoveryContinuationPrompt():
		// The run-recovery continuation is engine-authored and fixed: it is
		// produced by exactly one call site (RecoveryContinuationPrompt) and
		// compared whole, so no user prose can collide with it.
		//
		// These rows are why this arm exists. Recovery replays the interrupted
		// run's PromptOverrides, and when those carried an image the append
		// took the attachment shape and dropped the classification, persisting
		// the continuation as an ordinary user turn.
		return string(types.InjectionKindRunRecovery)
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
