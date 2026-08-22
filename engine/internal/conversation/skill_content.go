package conversation

import (
	"encoding/json"
	"sort"
	"strings"

	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// SkillContentBlockType carries one invoked skill's rendered instruction body.
// It is internal structure: providers receive Text, while persistence uses the
// metadata to restore only invoked skills after compaction.
const SkillContentBlockType = "skill_content"

// SkillListingBlockType carries a one-time or delta announcement of available
// skills. It is never a human prompt or transcript row.
const SkillListingBlockType = "skill_listing"

const (
	MaxRestoredSkillTokensPerSkill = 5000
	MaxRestoredSkillTokensTotal    = 25000
	skillTruncationMarker          = "\n\n[Skill content truncated for compaction. Read the source path above for full instructions.]"
)

// AppendSkillListingToLastUser adds an initial/delta announcement to the run's
// inbound user turn. Providers require role alternation, so a standalone second
// user message would be invalid after every submitted prompt. The listing stays
// structural in both display and LLM content; slash display entries retain their
// raw invocation while their LlmContent receives the marker.
func AppendSkillListingToLastUser(conv *Conversation, names []string, text string) bool {
	if conv == nil || len(names) == 0 || text == "" {
		return false
	}
	listing := types.LlmContentBlock{Type: SkillListingBlockType, Text: text, SkillNames: append([]string(nil), names...)}
	conv.lock()
	defer conv.unlock()
	if len(conv.Messages) == 0 || conv.Messages[len(conv.Messages)-1].Role != "user" {
		utils.LogWithFields(utils.LevelWarn, "conversation.skill", "skill listing has no inbound user carrier", map[string]any{"conversation_id": conv.ID, "count": len(names)})
		return false
	}
	appendListing := func(content any) any {
		blocks := toContentBlocks(content)
		return append(blocks, listing)
	}
	conv.Messages[len(conv.Messages)-1].Content = appendListing(conv.Messages[len(conv.Messages)-1].Content)
	entryID := conv.Messages[len(conv.Messages)-1].EntryID
	if entryID != "" {
		for i := len(conv.Entries) - 1; i >= 0; i-- {
			if conv.Entries[i].ID != entryID || conv.Entries[i].Type != EntryMessage {
				continue
			}
			md := asMessageData(conv.Entries[i].Data)
			if md == nil || md.Role != "user" {
				break
			}
			if md.LlmContent != nil {
				md.LlmContent = appendListing(md.LlmContent)
			} else {
				md.Content = appendListing(md.Content)
			}
			conv.Entries[i].Data = *md
			utils.LogWithFields(utils.LevelInfo, "conversation.skill", "skill listing appended to inbound user turn", map[string]any{"conversation_id": conv.ID, "count": len(names), "entry_id": entryID})
			return true
		}
		utils.LogWithFields(utils.LevelWarn, "conversation.skill", "skill listing inbound entry missing", map[string]any{"conversation_id": conv.ID, "entry_id": entryID})
		return false
	}
	// LLM-only conversations have no tree identity but still need a legal
	// same-message provider payload for this live call.
	utils.LogWithFields(utils.LevelInfo, "conversation.skill", "skill listing appended to transient inbound user turn", map[string]any{"conversation_id": conv.ID, "count": len(names)})
	return true
}

// AnnouncedSkillNames reads only typed listing blocks on active context. User
// prose cannot suppress a skill announcement.
func AnnouncedSkillNames(conv *Conversation) map[string]bool {
	seen := make(map[string]bool)
	if conv == nil {
		return seen
	}
	for _, msg := range conv.Messages {
		for _, block := range skillBlocks(msg) {
			if block.Type != SkillListingBlockType {
				continue
			}
			for _, name := range block.SkillNames {
				if name != "" {
					seen[name] = true
				}
			}
		}
	}
	return seen
}

// CollectInvokedSkills returns latest invocation per skill, including bounded
// skills restored by prior compaction boundaries. Sorting is deterministic.
func CollectInvokedSkills(messages []types.LlmMessage) []types.SkillInvocation {
	byName := make(map[string]types.SkillInvocation)
	for _, msg := range messages {
		for _, block := range skillBlocks(msg) {
			switch block.Type {
			case SkillContentBlockType:
				if block.SkillName != "" && block.Text != "" {
					putNewerSkill(byName, types.SkillInvocation{Name: block.SkillName, Source: block.SkillSource, Content: block.Text, InvokedAt: block.SkillInvokedAt})
				}
			case CompactBoundaryBlockType:
				for _, skill := range block.RestoredSkills {
					if skill.Name != "" && skill.Content != "" {
						putNewerSkill(byName, skill)
					}
				}
			}
		}
	}
	out := make([]types.SkillInvocation, 0, len(byName))
	for _, skill := range byName {
		out = append(out, skill)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].InvokedAt == out[j].InvokedAt {
			return out[i].Name < out[j].Name
		}
		return out[i].InvokedAt > out[j].InvokedAt
	})
	return out
}

func putNewerSkill(byName map[string]types.SkillInvocation, next types.SkillInvocation) {
	old, exists := byName[next.Name]
	if !exists || next.InvokedAt >= old.InvokedAt {
		byName[next.Name] = next
	}
}

// BoundRestoredSkills keeps newest invoked skills within Claude Code parity
// budgets. It never drops a newer skill to retain an older one.
func BoundRestoredSkills(skills []types.SkillInvocation) []types.SkillInvocation {
	used := 0
	bounded := make([]types.SkillInvocation, 0, len(skills))
	for _, skill := range skills {
		content := truncateSkillContent(skill.Content, skill.Source, MaxRestoredSkillTokensPerSkill)
		tokens := estimateSkillTokens(content)
		if used+tokens > MaxRestoredSkillTokensTotal {
			continue
		}
		skill.Content = content
		bounded = append(bounded, skill)
		used += tokens
	}
	utils.LogWithFields(utils.LevelInfo, "conversation.skill", "bounded invoked skills for compaction", map[string]any{"count": len(bounded), "tokens": used, "available": len(skills)})
	return bounded
}

func truncateSkillContent(content, source string, limit int) string {
	if estimateSkillTokens(content) <= limit {
		return content
	}
	chars := limit*4 - len(skillTruncationMarker) - len(source)
	if chars < 0 {
		chars = 0
	}
	if chars > len(content) {
		chars = len(content)
	}
	return content[:chars] + "\n\nSource: " + source + skillTruncationMarker
}

func estimateSkillTokens(content string) int {
	return (len(content) + 3) / 4
}

func skillBlocks(msg types.LlmMessage) []types.LlmContentBlock {
	switch blocks := msg.Content.(type) {
	case []types.LlmContentBlock:
		return blocks
	case []interface{}:
		out := make([]types.LlmContentBlock, 0, len(blocks))
		for _, item := range blocks {
			m, ok := item.(map[string]interface{})
			if !ok {
				continue
			}
			typeName, _ := m["type"].(string) //nolint:errcheck // malformed blocks are ignored
			if typeName != SkillContentBlockType && typeName != SkillListingBlockType && typeName != CompactBoundaryBlockType {
				continue
			}
			encoded, err := json.Marshal(m)
			if err != nil {
				utils.LogWithFields(utils.LevelWarn, "conversation.skill", "skill metadata marshal failed", map[string]any{"error": utils.ErrStr(err), "type": typeName})
				continue
			}
			var block types.LlmContentBlock
			if err := json.Unmarshal(encoded, &block); err != nil {
				utils.LogWithFields(utils.LevelWarn, "conversation.skill", "skill metadata decode failed", map[string]any{"error": utils.ErrStr(err), "type": typeName})
				continue
			}
			out = append(out, block)
		}
		return out
	default:
		return nil
	}
}

func isSkillMetaBlocks(blocks []types.LlmContentBlock) bool {
	return len(blocks) > 0 && (blocks[0].Type == SkillContentBlockType || blocks[0].Type == SkillListingBlockType)
}

func skillLoadingText(skill types.SkillInvocation) string {
	name := strings.TrimSpace(skill.Name)
	if name == "" {
		name = "unnamed"
	}
	return "<command-name>" + name + "</command-name>\n<skill-format>true</skill-format>\n" + skill.Content
}
