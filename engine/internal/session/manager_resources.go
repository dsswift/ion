package session

import (
	"fmt"
	"sort"

	"github.com/dsswift/ion/engine/internal/resource"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

type workspaceResourceBroker struct {
	sessionKey string
	broker     *resource.Broker
}

// GetWorkspaceResourceItem resolves a workspace-scoped Resource through the
// session brokers that own extension producer query handlers. The Manager-level
// global broker is a live fan-out bus and deliberately stores no producers.
func (m *Manager) GetWorkspaceResourceItem(kind, producer, id string) (*types.ResourceItem, error) {
	m.mu.RLock()
	keys := make([]string, 0, len(m.sessions))
	brokers := make(map[string]*resource.Broker, len(m.sessions))
	for key, session := range m.sessions {
		if session.resourceBroker != nil {
			keys = append(keys, key)
			brokers[key] = session.resourceBroker
		}
	}
	m.mu.RUnlock()
	sort.Strings(keys)

	byProducer := make(map[string][]workspaceResourceBroker)
	for _, key := range keys {
		broker := brokers[key]
		for _, name := range broker.ProducerNames(kind) {
			if producer == "" || producer == name {
				byProducer[name] = append(byProducer[name], workspaceResourceBroker{sessionKey: key, broker: broker})
			}
		}
	}
	producers := make([]string, 0, len(byProducer))
	for name := range byProducer {
		producers = append(producers, name)
	}
	sort.Strings(producers)
	if len(producers) == 0 {
		return nil, fmt.Errorf("resource broker: no producer for kind %q producer %q", kind, producer)
	}

	var matches []types.ResourceItem
	for _, name := range producers {
		var producerErr error
		for _, candidate := range byProducer[name] {
			item, err := candidate.broker.GetWorkspaceItemFrom(kind, name, id)
			if err != nil {
				producerErr = err
				utils.LogWithFields(utils.LevelWarn, "resource", "workspace resource query failed", map[string]any{
					"session_id": candidate.sessionKey, "kind": kind, "producer": name, "item_id": id, "error": err.Error(),
				})
				continue
			}
			if item != nil {
				matches = append(matches, *item)
				producerErr = nil
				break
			}
		}
		if producerErr != nil {
			return nil, producerErr
		}
	}
	if len(matches) == 0 {
		return nil, nil
	}
	if producer == "" && len(matches) > 1 {
		return nil, fmt.Errorf("resource broker: item %q in kind %q is ambiguous; specify producer", id, kind)
	}
	return &matches[0], nil
}
