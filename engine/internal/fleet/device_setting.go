package fleet

import (
	"encoding/json"

	"github.com/dsswift/ion/engine/internal/utils"
)

// OpenAtLoginKey is the desktop's device setting that has the operating
// system open Ion when its person signs in.
const OpenAtLoginKey = "openAtLogin"

// SetDeviceSetting writes one desktop device setting into desktop.json,
// every other key kept. With ifUnset, a value someone already chose stands.
// It reports the value now in force and whether this call wrote it. A
// running desktop watches the file and applies the change.
func (c *Catalog) SetDeviceSetting(key string, value bool, ifUnset bool) (now bool, wrote bool, err error) {
	settings, err := c.readSettings()
	if err != nil {
		return false, false, err
	}
	if raw, ok := settings[key]; ok && ifUnset {
		var chosen bool
		if json.Unmarshal(raw, &chosen) == nil {
			utils.LogWithFields(utils.LevelInfo, logTag, "device setting left as chosen", map[string]any{"key": key, "value": chosen, "path": c.settingsPath})
			return chosen, false, nil
		}
	}
	raw, err := json.Marshal(value)
	if err != nil {
		return false, false, err
	}
	settings[key] = raw
	if err := c.writeSettings(settings); err != nil {
		return false, false, err
	}
	utils.LogWithFields(utils.LevelInfo, logTag, "device setting written", map[string]any{"key": key, "value": value, "path": c.settingsPath})
	return value, true, nil
}
