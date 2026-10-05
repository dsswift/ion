package fleet

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestSetDeviceSettingKeepsOtherKeysAndAChoiceAlreadyMade(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "desktop.json")
	if err := os.WriteFile(path, []byte(`{"deviceId":"d-1","environments":[{"kind":"paired"}]}`), 0o644); err != nil {
		t.Fatal(err)
	}
	c := OpenCatalogAt(dir)

	now, wrote, err := c.SetDeviceSetting(OpenAtLoginKey, true, true)
	if err != nil || !now || !wrote {
		t.Fatalf("first write: now=%v wrote=%v err=%v", now, wrote, err)
	}
	var got map[string]json.RawMessage
	data, _ := os.ReadFile(path)
	if err := json.Unmarshal(data, &got); err != nil {
		t.Fatal(err)
	}
	if string(got["deviceId"]) != `"d-1"` || got["environments"] == nil || string(got[OpenAtLoginKey]) != "true" {
		t.Fatalf("other keys were not kept: %s", data)
	}

	// The person turned it off; a later deploy leaves that alone.
	if _, _, err := c.SetDeviceSetting(OpenAtLoginKey, false, false); err != nil {
		t.Fatal(err)
	}
	now, wrote, err = c.SetDeviceSetting(OpenAtLoginKey, true, true)
	if err != nil || now || wrote {
		t.Fatalf("a choice already made must stand: now=%v wrote=%v err=%v", now, wrote, err)
	}
	// Without ifUnset the caller's value wins.
	now, wrote, err = c.SetDeviceSetting(OpenAtLoginKey, true, false)
	if err != nil || !now || !wrote {
		t.Fatalf("explicit write: now=%v wrote=%v err=%v", now, wrote, err)
	}
}

func TestSetDeviceSettingCreatesTheFile(t *testing.T) {
	dir := t.TempDir()
	now, wrote, err := OpenCatalogAt(dir).SetDeviceSetting(OpenAtLoginKey, true, true)
	if err != nil || !now || !wrote {
		t.Fatalf("now=%v wrote=%v err=%v", now, wrote, err)
	}
	if _, err := os.Stat(filepath.Join(dir, "desktop.json")); err != nil {
		t.Fatal(err)
	}
}
