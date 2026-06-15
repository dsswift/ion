package extension

import (
	"encoding/json"
	"strings"
	"testing"
)

// TestCompactionInfo_JSONTags pins the lowercase JSON keys on CompactionInfo
// and CompactionFact. The TS SDK mirror (engine/extensions/sdk/ion-sdk/types.ts)
// and any non-Go harness consumer reading hook payloads off the JSON-RPC wire
// depends on this exact shape. If a Go field is renamed without updating its
// `json:` tag — or if the tag is dropped entirely so Go field-name casing leaks
// onto the wire — this test fails and the contract drift is caught at PR time.
func TestCompactionInfo_JSONTags(t *testing.T) {
	info := CompactionInfo{
		Strategy:       "auto",
		MessagesBefore: 30,
		MessagesAfter:  10,
		Facts: []CompactionFact{
			{Type: "decision", Content: "x"},
		},
	}
	out, err := json.Marshal(info)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	got := string(out)

	// Required substrings — order is not load-bearing (encoding/json emits
	// fields in struct-declaration order, but we want this test to survive a
	// future field reorder), so check each key/value pair independently.
	mustContain := []string{
		`"strategy":"auto"`,
		`"messagesBefore":30`,
		`"messagesAfter":10`,
		`"facts":[`,
		`"type":"decision"`,
		`"content":"x"`,
	}
	for _, want := range mustContain {
		if !strings.Contains(got, want) {
			t.Errorf("CompactionInfo JSON missing %q\nfull payload: %s", want, got)
		}
	}

	// Forbidden substrings — capitalized Go field names must not leak to the
	// wire. If the json: tag is dropped, encoding/json falls back to the Go
	// name, which would silently break TS/Swift mirrors.
	mustNotContain := []string{
		`"Strategy"`,
		`"MessagesBefore"`,
		`"MessagesAfter"`,
		`"Facts"`,
		`"Type"`,
		`"Content"`,
	}
	for _, bad := range mustNotContain {
		if strings.Contains(got, bad) {
			t.Errorf("CompactionInfo JSON leaks Go field name %q\nfull payload: %s", bad, got)
		}
	}
}

// TestCompactionInfo_FactsOmitEmpty verifies the `facts` key is omitted from
// the wire payload when the slice is empty or nil — older extension consumers
// that don't know about the new field will not see an unexpected key. This is
// the additive-contract invariant in test form.
func TestCompactionInfo_FactsOmitEmpty(t *testing.T) {
	info := CompactionInfo{Strategy: "auto", MessagesBefore: 5, MessagesAfter: 3}
	out, err := json.Marshal(info)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	got := string(out)
	if strings.Contains(got, `"facts"`) {
		t.Errorf("expected facts key omitted when slice is nil; got: %s", got)
	}
}

// TestAgentInfo_IsRootJSONWire pins the wire shape of the AgentInfo.IsRoot
// discriminator (issue #227). before_agent_start is dual-purpose: it fires on
// the root loop with IsRoot=true and on sub-agent launches with IsRoot=false.
// The TS SDK mirror (engine/extensions/sdk/ion-sdk/types.ts) reads `isRoot`
// off the JSON-RPC wire to decide whether to inject a sub-agent-only preamble.
// This test fails if the json tag is renamed/dropped or the casing leaks.
func TestAgentInfo_IsRootJSONWire(t *testing.T) {
	// Root firing: IsRoot=true must serialize as "isRoot":true so a consumer
	// can distinguish it from a sub-agent launch. This is the exact wire field
	// the #227 fix exists to provide.
	rootOut, err := json.Marshal(AgentInfo{IsRoot: true})
	if err != nil {
		t.Fatalf("marshal root AgentInfo: %v", err)
	}
	rootGot := string(rootOut)
	if !strings.Contains(rootGot, `"isRoot":true`) {
		t.Errorf("root AgentInfo missing \"isRoot\":true\nfull payload: %s", rootGot)
	}
	// Capitalized Go field name must never leak to the wire.
	if strings.Contains(rootGot, `"IsRoot"`) {
		t.Errorf("AgentInfo leaks Go field name \"IsRoot\"\nfull payload: %s", rootGot)
	}
}

// TestAgentInfo_IsRootOmitEmpty verifies the `isRoot` key is omitted when
// false — the additive-contract invariant. Sub-agent firings and the
// agent_start / agent_end hooks (which reuse AgentInfo and never set IsRoot)
// must not emit the key, so existing consumers see no unexpected field and
// the absence of the key is itself the "this is not the root loop" signal.
func TestAgentInfo_IsRootOmitEmpty(t *testing.T) {
	subAgentOut, err := json.Marshal(AgentInfo{Name: "researcher", Task: "find X"})
	if err != nil {
		t.Fatalf("marshal sub-agent AgentInfo: %v", err)
	}
	got := string(subAgentOut)
	if strings.Contains(got, `"isRoot"`) {
		t.Errorf("expected isRoot key omitted when false; got: %s", got)
	}
	// Sanity: the populated sub-agent fields are still present.
	if !strings.Contains(got, `"name":"researcher"`) || !strings.Contains(got, `"task":"find X"`) {
		t.Errorf("sub-agent AgentInfo missing name/task; got: %s", got)
	}
}

// TestBeforeAgentStartResult_AgentNameJSONWire pins the `agentName` wire field
// on BeforeAgentStartResult. The Go FireBeforeAgentStart already honors an
// agentName returned by a subprocess (TS) handler via the map path; this test
// guards the struct-result wire shape that the TS SDK mirror declares so the
// field cannot be renamed or dropped without a failing gate.
func TestBeforeAgentStartResult_AgentNameJSONWire(t *testing.T) {
	out, err := json.Marshal(BeforeAgentStartResult{SystemPrompt: "sys", AgentName: "resolved"})
	if err != nil {
		t.Fatalf("marshal BeforeAgentStartResult: %v", err)
	}
	got := string(out)
	if !strings.Contains(got, `"agentName":"resolved"`) {
		t.Errorf("BeforeAgentStartResult missing \"agentName\":\"resolved\"\nfull payload: %s", got)
	}
	if !strings.Contains(got, `"systemPrompt":"sys"`) {
		t.Errorf("BeforeAgentStartResult missing \"systemPrompt\":\"sys\"\nfull payload: %s", got)
	}
	// omitempty: both fields absent when empty.
	emptyOut, err := json.Marshal(BeforeAgentStartResult{})
	if err != nil {
		t.Fatalf("marshal empty BeforeAgentStartResult: %v", err)
	}
	if emptyGot := string(emptyOut); strings.Contains(emptyGot, `"agentName"`) {
		t.Errorf("expected agentName omitted when empty; got: %s", emptyGot)
	}
}
