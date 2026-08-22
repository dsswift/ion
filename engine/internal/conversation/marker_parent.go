package conversation

import "github.com/dsswift/ion/engine/internal/types"

// parentMessageMachineAuthored resolves a marker's exact parent entry rather
// than inferring its source from marker length or nearby transcript content.
func parentMessageMachineAuthored(conv *Conversation, parentID *string) bool {
	if parentID == nil {
		return false
	}
	for _, entry := range conv.Entries {
		if entry.ID != *parentID || entry.Type != EntryMessage {
			continue
		}
		data := asMessageData(entry.Data)
		return data != nil && (data.MachineAuthored || types.InjectionKind(data.InjectionKind).IsMachineToMachine())
	}
	return false
}
