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

// WorkspaceResourceSnapshot is one producer-scoped replacement snapshot.
type WorkspaceResourceSnapshot struct {
	Kind      string
	Items     []types.ResourceItem
	Producers []string
}

func (m *Manager) workspaceResourceBrokers() ([]string, map[string]*resource.Broker) {
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
	return keys, brokers
}

func groupWorkspaceProducers(keys []string, brokers map[string]*resource.Broker, kind, producer string) map[string][]workspaceResourceBroker {
	byProducer := make(map[string][]workspaceResourceBroker)
	for _, key := range keys {
		broker := brokers[key]
		for _, name := range broker.ProducerNames(kind) {
			if producer == "" || producer == name {
				byProducer[name] = append(byProducer[name], workspaceResourceBroker{sessionKey: key, broker: broker})
			}
		}
	}
	return byProducer
}

func sortedProducerNames(byProducer map[string][]workspaceResourceBroker) []string {
	producers := make([]string, 0, len(byProducer))
	for name := range byProducer {
		producers = append(producers, name)
	}
	sort.Strings(producers)
	return producers
}

// WorkspaceResourceSnapshots queries producer-owned workspace state across all
// live sessions. A producer is covered only when one of its session-bound query
// handlers succeeds; failed producers are omitted so consumers retain their
// last valid items.
func (m *Manager) WorkspaceResourceSnapshots(filter types.ResourceFilter) []WorkspaceResourceSnapshot {
	keys, brokers := m.workspaceResourceBrokers()
	kindSet := make(map[string]struct{})
	for _, key := range keys {
		for _, kind := range brokers[key].Kinds() {
			if filter.Kind == "" || resource.IsWildcard(filter.Kind) || filter.Kind == kind {
				kindSet[kind] = struct{}{}
			}
		}
	}
	kinds := make([]string, 0, len(kindSet))
	for kind := range kindSet {
		kinds = append(kinds, kind)
	}
	sort.Strings(kinds)

	snapshots := make([]WorkspaceResourceSnapshot, 0, len(kinds))
	for _, kind := range kinds {
		byProducer := groupWorkspaceProducers(keys, brokers, kind, filter.Producer)
		producerNames := sortedProducerNames(byProducer)
		var items []types.ResourceItem
		var covered []string
		for _, producer := range producerNames {
			for _, candidate := range byProducer[producer] {
				producerItems, err := candidate.broker.QueryProducer(kind, producer, types.ResourceFilter{
					Kind: kind, Producer: producer, ConversationID: filter.ConversationID,
				})
				if err != nil {
					utils.LogWithFields(utils.LevelWarn, "resource", "workspace resource snapshot query failed", map[string]any{
						"session_id": candidate.sessionKey, "kind": kind, "producer": producer, "error": err.Error(),
					})
					continue
				}
				for _, item := range producerItems {
					if item.ConversationID == "" {
						items = append(items, item)
					}
				}
				covered = append(covered, producer)
				break
			}
		}
		if len(producerNames) > 0 {
			snapshots = append(snapshots, WorkspaceResourceSnapshot{Kind: kind, Items: items, Producers: covered})
		}
	}
	utils.LogWithFields(utils.LevelInfo, "resource", "workspace resource snapshots built", map[string]any{
		"kind_count": len(snapshots), "producer": filter.Producer,
	})
	return snapshots
}

// GetWorkspaceResourceItem resolves a workspace-scoped Resource through the
// session brokers that own extension producer query handlers. The Manager-level
// global broker is a live fan-out bus and deliberately stores no producers.
func (m *Manager) GetWorkspaceResourceItem(kind, producer, id string) (*types.ResourceItem, error) {
	keys, brokers := m.workspaceResourceBrokers()
	byProducer := groupWorkspaceProducers(keys, brokers, kind, producer)
	producers := sortedProducerNames(byProducer)
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
