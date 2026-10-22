package acpagent

import (
	"strings"
	"testing"
)

// A pinned harness is the agent: it names itself after the harness, loads
// only the harness, and offers the model but no profile choice.
func TestPinnedHarnessIsTheAgent(t *testing.T) {
	f := newFakeEngine(t)
	defer f.close()
	_, c := startAgent(t, f, Options{
		Version: "v1", Profile: "cos2", Profiles: testProfiles,
		Harness: &Harness{Name: "cos2", Title: "Chief of Staff", Path: "/ext/cos2"},
	})
	init := c.initialize(ClientCapabilities{})
	if init.AgentInfo != (Implementation{Name: "cos2", Title: "Chief of Staff", Version: "v1"}) {
		t.Fatalf("agentInfo = %+v", init.AgentInfo)
	}
	res := c.newSession("/work")
	start := f.waitCmd("start_session")
	cfg := start["config"].(map[string]any)
	if exts, _ := cfg["extensions"].([]any); len(exts) != 1 || exts[0] != "/ext/cos2" {
		t.Fatalf("extensions = %v", cfg["extensions"])
	}
	if _, ok := cfg["profileId"]; ok {
		t.Fatalf("a pinned harness sends no profile id: %v", cfg)
	}
	if len(res.ConfigOptions) != 1 || res.ConfigOptions[0].ID != ConfigModel {
		t.Fatalf("config options = %+v", res.ConfigOptions)
	}
	code, msg := c.callErr(MethodSessionSetConfigOption, SetConfigOptionRequest{SessionID: res.SessionID, ConfigID: ConfigProfile, Value: []byte(`"p-jar"`)})
	if code != codeInternalError || !strings.Contains(msg, "cos2 harness") {
		t.Fatalf("profile change = %d %q", code, msg)
	}
}

// Without a title the harness's name is its title.
func TestPinnedHarnessTitleDefaultsToItsName(t *testing.T) {
	info := Options{Version: "v", Harness: &Harness{Name: "jarvis", Path: "/ext/jarvis"}}.agentInfo()
	if info.Title != "jarvis" || info.Name != "jarvis" {
		t.Fatalf("agentInfo = %+v", info)
	}
	if engine := (Options{Version: "v"}).agentInfo(); engine.Name != "ion" || engine.Title != "Ion Engine" {
		t.Fatalf("engine agentInfo = %+v", engine)
	}
}
