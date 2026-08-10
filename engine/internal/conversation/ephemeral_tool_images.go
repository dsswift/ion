package conversation

import "github.com/dsswift/ion/engine/internal/types"

// DiscardEphemeralToolImages removes model-input-only image blocks after the
// provider has consumed them. They never enter the tree, but keeping them in
// live Messages would replay an MCP blob on later turns in the same run.
func DiscardEphemeralToolImages(conv *Conversation) {
	if conv == nil {
		return
	}
	conv.lock()
	defer conv.unlock()
	for messageIndex := range conv.Messages {
		blocks, ok := conv.Messages[messageIndex].Content.([]types.LlmContentBlock)
		if !ok {
			continue
		}
		filtered := blocks[:0]
		for _, block := range blocks {
			if !block.Ephemeral {
				filtered = append(filtered, block)
			}
		}
		if len(filtered) == len(blocks) {
			continue
		}
		copyBlocks := append([]types.LlmContentBlock(nil), filtered...)
		conv.Messages[messageIndex].Content = copyBlocks
	}
}
