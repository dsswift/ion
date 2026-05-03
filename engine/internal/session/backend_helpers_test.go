package session

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/backend"
)

func TestNewChildBackend_ApiParent(t *testing.T) {
	mgr := NewManager(backend.NewApiBackend())
	child := mgr.newChildBackend()
	if _, ok := child.(*backend.ApiBackend); !ok {
		t.Errorf("expected *ApiBackend child, got %T", child)
	}
}

func TestNewChildBackend_CliParent(t *testing.T) {
	mgr := NewManager(backend.NewCliBackend())
	child := mgr.newChildBackend()
	if _, ok := child.(*backend.CliBackend); !ok {
		t.Errorf("expected *CliBackend child, got %T", child)
	}
}

func TestNewChildBackend_MockParent(t *testing.T) {
	mgr := NewManager(newMockBackend())
	child := mgr.newChildBackend()
	// Mock is neither CliBackend nor ApiBackend; should default to ApiBackend
	if _, ok := child.(*backend.ApiBackend); !ok {
		t.Errorf("expected *ApiBackend child for unknown parent, got %T", child)
	}
}
