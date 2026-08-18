package extension

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestScheduleJobCatchUpPolicy(t *testing.T) {
	for _, policy := range []string{"", "auto", "manual", "none"} {
		job := ScheduleJob{JobID: "daily", Kind: ScheduleDaily, Time: "09:00", CatchUp: policy}
		if err := job.Validate(); err != nil {
			t.Fatalf("catchUp=%q rejected: %v", policy, err)
		}
	}
	if err := (ScheduleJob{JobID: "daily", Kind: ScheduleDaily, Time: "09:00", CatchUp: "later"}).Validate(); err == nil {
		t.Fatal("unknown catchUp policy accepted")
	}
	if err := (ScheduleJob{JobID: "poll", Kind: ScheduleInterval, IntervalMs: 1_000, CatchUp: "manual"}).Validate(); err == nil {
		t.Fatal("interval catchUp policy accepted")
	}
}

func TestScheduleJobCatchUpJSON(t *testing.T) {
	data, err := json.Marshal(ScheduleJob{JobID: "brief", Kind: ScheduleDaily, Time: "09:00", CatchUp: "manual"})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if !strings.Contains(string(data), `"catchUp":"manual"`) {
		t.Fatalf("catchUp missing: %s", data)
	}
	data, err = json.Marshal(ScheduleJob{JobID: "brief", Kind: ScheduleDaily, Time: "09:00"})
	if err != nil {
		t.Fatalf("marshal default: %v", err)
	}
	if strings.Contains(string(data), "catchUp") {
		t.Fatalf("empty catchUp must omit: %s", data)
	}
}
