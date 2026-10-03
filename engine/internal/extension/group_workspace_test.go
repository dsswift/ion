package extension

import "testing"

// workspace_file_changed is high-volume, so it reaches only the hosts that
// registered a handler for it.
func TestFireWorkspaceFileChangedSkipsHostsWithoutHandler(t *testing.T) {
	listening, silent := NewHost(), NewHost()
	var got []WorkspaceFileChangedInfo
	listening.SDK().On(HookWorkspaceFileChanged, func(_ *Context, payload interface{}) (interface{}, error) {
		got = append(got, payload.(WorkspaceFileChangedInfo))
		return nil, nil
	})
	group := NewExtensionGroup()
	group.Add(listening)
	group.Add(silent)

	if !listening.DeclaresHook(HookWorkspaceFileChanged) || silent.DeclaresHook(HookWorkspaceFileChanged) {
		t.Fatal("declaration does not match the registered handlers")
	}
	info := WorkspaceFileChangedInfo{Path: "/w/a.md", RelPath: "a.md", Action: "modify"}
	group.FireWorkspaceFileChanged(&Context{}, info)

	if len(got) != 1 || got[0] != info {
		t.Fatalf("delivered = %+v", got)
	}
}
