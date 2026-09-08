package config

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"

	"github.com/dsswift/ion/engine/internal/types"
)

// programDataSourceReport describes whether one ProgramData source was
// present, absent, or present-but-unreadable, so the Windows reader can log
// each outcome at the right level (INFO present, DEBUG absent, WARN error).
type programDataSourceReport struct {
	Source  string // "programdata-main" | "programdata-dropin"
	Path    string
	Present bool
	Error   error
}

// readProgramDataDir reads the ProgramData-rooted enterprise config layout —
// the Windows mirror of Linux's /etc/ion/config.json + config.d/*.json (same
// mergeEnterprisePartial overlay semantics, same drop-in byte-order rule).
// root is %ProgramData% (the caller resolves the env var so this function
// stays pure and unit-testable with a temp directory). Returns nil when
// nothing is present under root.
func readProgramDataDir(root string) (*types.EnterpriseConfig, []programDataSourceReport) {
	var reports []programDataSourceReport
	var cfg *types.EnterpriseConfig

	mainPath := filepath.Join(root, "Ion", "enterprise-config.json")
	if data, err := os.ReadFile(mainPath); err == nil {
		parsed, perr := parseEnterpriseJSON(data)
		if perr != nil {
			reports = append(reports, programDataSourceReport{Source: "programdata-main", Path: mainPath, Present: true, Error: perr})
		} else {
			cfg = parsed
			reports = append(reports, programDataSourceReport{Source: "programdata-main", Path: mainPath, Present: true})
		}
	} else if os.IsNotExist(err) {
		reports = append(reports, programDataSourceReport{Source: "programdata-main", Path: mainPath, Present: false})
	} else {
		reports = append(reports, programDataSourceReport{Source: "programdata-main", Path: mainPath, Present: true, Error: err})
	}

	dropinDir := filepath.Join(root, "Ion", "enterprise-config.d")
	entries, err := os.ReadDir(dropinDir)
	if err != nil {
		reports = append(reports, programDataSourceReport{Source: "programdata-dropin", Path: dropinDir, Present: false})
		return cfg, reports
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].Name() < entries[j].Name() })

	for _, entry := range entries {
		if entry.IsDir() || filepath.Ext(entry.Name()) != ".json" {
			continue
		}
		path := filepath.Join(dropinDir, entry.Name())
		data, rerr := os.ReadFile(path)
		if rerr != nil {
			reports = append(reports, programDataSourceReport{Source: "programdata-dropin", Path: path, Present: true, Error: rerr})
			continue
		}
		partial, perr := parseEnterpriseJSON(data)
		if perr != nil {
			reports = append(reports, programDataSourceReport{Source: "programdata-dropin", Path: path, Present: true, Error: perr})
			continue
		}
		if cfg == nil {
			cfg = partial
		} else {
			cfg = mergeEnterprisePartial(cfg, partial)
		}
		reports = append(reports, programDataSourceReport{Source: "programdata-dropin", Path: path, Present: true})
	}
	return cfg, reports
}

func parseEnterpriseJSON(data []byte) (*types.EnterpriseConfig, error) {
	var cfg types.EnterpriseConfig
	if err := json.Unmarshal(data, &cfg); err != nil {
		return nil, err
	}
	return &cfg, nil
}
