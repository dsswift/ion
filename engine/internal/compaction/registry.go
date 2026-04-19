package compaction

import (
	"fmt"
	"sync"

	"github.com/dsswift/ion/engine/internal/types"
)

// CompactionOptions configures compaction behavior.
type CompactionOptions struct {
	TargetTokens int
	KeepTurns    int
	Model        string
	Summarize    func(text string) (string, error) // LLM summarize callback
	Extra        map[string]interface{}
}

// CompactionResult captures what happened during compaction.
type CompactionResult struct {
	Strategy       string
	MessagesBefore int
	MessagesAfter  int
	TokensSaved    int
}

// CompactionStrategy is the pluggable interface for compaction.
type CompactionStrategy interface {
	Name() string
	Description() string
	CanHandle(messages []types.LlmMessage, options *CompactionOptions) bool
	Compact(messages []types.LlmMessage, options *CompactionOptions) ([]types.LlmMessage, *CompactionResult, error)
}

var (
	mu             sync.RWMutex
	strategies     = make(map[string]CompactionStrategy)
	preferredOrder []string
)

// RegisterStrategy adds a strategy to the registry.
func RegisterStrategy(s CompactionStrategy) {
	mu.Lock()
	defer mu.Unlock()
	strategies[s.Name()] = s
}

// GetStrategy returns the strategy registered under the given name, or nil.
func GetStrategy(name string) CompactionStrategy {
	mu.RLock()
	defer mu.RUnlock()
	return strategies[name]
}

// AllStrategies returns every registered strategy.
func AllStrategies() []CompactionStrategy {
	mu.RLock()
	defer mu.RUnlock()
	out := make([]CompactionStrategy, 0, len(strategies))
	for _, s := range strategies {
		out = append(out, s)
	}
	return out
}

// ListStrategyNames returns the names of all registered strategies.
func ListStrategyNames() []string {
	mu.RLock()
	defer mu.RUnlock()
	out := make([]string, 0, len(strategies))
	for name := range strategies {
		out = append(out, name)
	}
	return out
}

// SetPreferredOrder sets the fallback evaluation order for SelectStrategy.
func SetPreferredOrder(order []string) {
	mu.Lock()
	defer mu.Unlock()
	preferredOrder = make([]string, len(order))
	copy(preferredOrder, order)
}

// GetPreferredOrder returns the current preferred order. If none has been set,
// it returns all registered strategy names in map iteration order.
func GetPreferredOrder() []string {
	mu.RLock()
	defer mu.RUnlock()
	if len(preferredOrder) > 0 {
		out := make([]string, len(preferredOrder))
		copy(out, preferredOrder)
		return out
	}
	out := make([]string, 0, len(strategies))
	for name := range strategies {
		out = append(out, name)
	}
	return out
}

// SelectStrategy returns the first strategy from the preferred order whose
// CanHandle returns true, or nil if none match.
func SelectStrategy(messages []types.LlmMessage, opts *CompactionOptions) CompactionStrategy {
	mu.RLock()
	defer mu.RUnlock()

	order := preferredOrder
	if len(order) == 0 {
		order = make([]string, 0, len(strategies))
		for name := range strategies {
			order = append(order, name)
		}
	}

	for _, name := range order {
		s, ok := strategies[name]
		if ok && s.CanHandle(messages, opts) {
			return s
		}
	}
	return nil
}

// ExecuteCompaction runs compaction using the named strategy. If strategyName
// is empty, SelectStrategy picks the first eligible one. Returns an error if
// no suitable strategy is found.
func ExecuteCompaction(messages []types.LlmMessage, opts *CompactionOptions, strategyName string) ([]types.LlmMessage, *CompactionResult, error) {
	var s CompactionStrategy
	if strategyName != "" {
		s = GetStrategy(strategyName)
		if s == nil {
			return nil, nil, fmt.Errorf("compaction strategy not found: %s", strategyName)
		}
	} else {
		s = SelectStrategy(messages, opts)
		if s == nil {
			return nil, nil, fmt.Errorf("no compaction strategy can handle the current messages")
		}
	}
	return s.Compact(messages, opts)
}

// ClearStrategies resets the registry, removing all strategies and the
// preferred order. Intended for testing.
func ClearStrategies() {
	mu.Lock()
	defer mu.Unlock()
	strategies = make(map[string]CompactionStrategy)
	preferredOrder = nil
}
