package main

// cmd_studio_windows_task.go — the desktop's engine on Windows runs under a
// per-user Scheduled Task, not launchd or systemd; `ion studio status` reports
// that task the way it reports a launchd unit.

import (
	"encoding/csv"
	"strings"

	"github.com/dsswift/ion/engine/internal/studiostatus"
)

// windowsEngineService reads `schtasks /Query /TN <task> /FO CSV /NH`.
func windowsEngineService(r cmdRunner, task string) studiostatus.Service {
	svc := studiostatus.Service{Label: task}
	out, code, err := r.Run("schtasks", "/Query", "/TN", task, "/FO", "CSV", "/NH")
	switch {
	case err != nil:
		svc.State, svc.Detail = "unknown", err.Error()
	case code != 0:
		svc.State, svc.Detail = "not-installed", strings.TrimSpace(out)
	default:
		svc.State = parseSchtasksState(out)
	}
	return svc
}

// parseSchtasksState maps the task's Status column: Running is running, Ready
// (registered, not running) is stopped, Disabled stays disabled.
func parseSchtasksState(out string) string {
	records, err := csv.NewReader(strings.NewReader(strings.TrimSpace(out))).ReadAll()
	if err != nil || len(records) == 0 || len(records[0]) < 3 {
		return "unknown"
	}
	switch strings.ToLower(strings.TrimSpace(records[0][2])) {
	case "running":
		return "running"
	case "ready", "queued":
		return "stopped"
	case "disabled":
		return "disabled"
	}
	return "unknown"
}
