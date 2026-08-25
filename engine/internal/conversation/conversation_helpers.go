package conversation

// cloneSlashFrontmatter detaches persisted command provenance from transient
// resolution maps, including maps extensions receive through resolution hooks.
func cloneSlashFrontmatter(frontmatter map[string]any) map[string]any {
	if len(frontmatter) == 0 {
		return nil
	}
	clone := make(map[string]any, len(frontmatter))
	for key, value := range frontmatter {
		clone[key] = value
	}
	return clone
}
