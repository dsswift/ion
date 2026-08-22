package extcontext

import "testing"

func ownershipRegistry() *DispatchRegistry {
	r := NewDispatchRegistry()
	r.RegisterWithID("a", "parent-a", func() {}, nil, "s", "", 1)
	r.RegisterWithID("a1", "child-a", func() {}, nil, "s", "a", 2)
	r.RegisterWithID("a2", "grandchild-a", func() {}, nil, "s", "a1", 3)
	r.RegisterWithID("b", "parent-b", func() {}, nil, "s", "", 1)
	r.RegisterWithID("b1", "child-b", func() {}, nil, "s", "b", 2)
	// Detached controls parking only. It remains A's child for emergency recall.
	r.RegisterWithID("ad", "detached-a", func() {}, nil, "s", "a", 2)
	r.MarkDetached("ad")
	return r
}

func TestOwnsDispatch_Hierarchy(t *testing.T) {
	r := ownershipRegistry()
	cases := []struct {
		owner, target string
		owned         bool
	}{
		{"", "a2", true}, // root owns every branch
		{"a", "a1", true},
		{"a", "a2", true},
		{"a", "ad", true},  // detached is still owned
		{"a", "a", false},  // agent does not own itself
		{"a1", "a", false}, // agent does not own ancestor
		{"a", "b", false},
		{"a", "b1", false},
	}
	for _, tc := range cases {
		owned, found := r.OwnsDispatch(tc.owner, tc.target)
		if !found || owned != tc.owned {
			t.Errorf("OwnsDispatch(%q, %q) = (%v, %v), want (%v, true)", tc.owner, tc.target, owned, found, tc.owned)
		}
	}
}

func TestOwnedSnapshot_StrictDescendants(t *testing.T) {
	r := ownershipRegistry()
	root := r.OwnedSnapshot("")
	if len(root) != 6 {
		t.Fatalf("root snapshot count = %d, want 6", len(root))
	}
	owned := r.OwnedSnapshot("a")
	got := map[string]bool{}
	for _, entry := range owned {
		got[entry.DispatchID] = true
	}
	for _, id := range []string{"a1", "a2", "ad"} {
		if !got[id] {
			t.Errorf("A-owned snapshot missing %q", id)
		}
	}
	for _, id := range []string{"a", "b", "b1"} {
		if got[id] {
			t.Errorf("A-owned snapshot leaked %q", id)
		}
	}
}

func TestRecallOwnedByID_ImmediateAndScoped(t *testing.T) {
	r := ownershipRegistry()
	cancelled := false
	r.RegisterWithID("a3", "great-grandchild-a", func() { cancelled = true }, nil, "s", "a2", 4)

	found, err := r.RecallOwnedByID("a", "a2", "emergency")
	if err != nil || !found {
		t.Fatalf("RecallOwnedByID = (%v, %v), want (true, nil)", found, err)
	}
	// Cancel fires during recall, not after a steer/checkpoint.
	if !cancelled {
		t.Fatal("descendant cancel did not fire immediately")
	}
	for _, id := range []string{"a2", "a3"} {
		if _, live := r.Get(id); live {
			t.Errorf("recalled target %q remains live", id)
		}
	}
	if _, live := r.Get("b1"); !live {
		t.Error("sibling branch was recalled")
	}
}

func TestRecallOwnedByID_RejectsSibling(t *testing.T) {
	r := ownershipRegistry()
	cancelled := false
	r.RegisterWithID("b2", "grandchild-b", func() { cancelled = true }, nil, "s", "b1", 3)
	found, err := r.RecallOwnedByID("a", "b1", "unauthorized")
	if found || err == nil {
		t.Fatalf("RecallOwnedByID sibling = (%v, %v), want (false, authorization error)", found, err)
	}
	if cancelled {
		t.Fatal("unauthorized recall cancelled sibling descendant")
	}
	if _, live := r.Get("b1"); !live {
		t.Fatal("unauthorized recall removed sibling")
	}
}

func TestOwnsDispatch_CycleFailsClosed(t *testing.T) {
	r := NewDispatchRegistry()
	r.RegisterWithID("a", "a", func() {}, nil, "s", "b", 1)
	r.RegisterWithID("b", "b", func() {}, nil, "s", "a", 2)
	r.RegisterWithID("c", "c", func() {}, nil, "s", "", 1)
	owned, found := r.OwnsDispatch("c", "a")
	if !found || owned {
		t.Fatalf("cycle ownership = (%v, %v), want (false, true)", owned, found)
	}
}
