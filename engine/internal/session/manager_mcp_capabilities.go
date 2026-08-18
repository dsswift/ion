package session

import "sort"

// flattenedMcpCapabilities projects server capability and extension keys into a
// stable, compact status surface. Values remain protocol-owned maps; consumers
// need names for observability, not a second copy of untrusted capability data.
func flattenedMcpCapabilities(capabilities map[string]any) []string {
	var names []string
	for name := range capabilities {
		if name == "extensions" {
			if extensions, ok := capabilities[name].(map[string]any); ok {
				for extension := range extensions {
					names = append(names, extension)
				}
			}
			continue
		}
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}
