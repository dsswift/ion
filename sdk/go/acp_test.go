package ion

import (
	"reflect"
	"testing"
)

func TestACPLaunchServesTheBinarysDirectory(t *testing.T) {
	got := acpLaunch("/opt/ion", "/ext/cos2/main", "Chief of Staff", []string{"--model", "m-1"})
	want := []string{"/opt/ion", "acp", "--harness", "/ext/cos2", "--title", "Chief of Staff", "--model", "m-1"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("argv = %q, want %q", got, want)
	}
	if got := acpLaunch("/opt/ion", "/ext/jarvis/main", "", nil); !reflect.DeepEqual(got, []string{"/opt/ion", "acp", "--harness", "/ext/jarvis"}) {
		t.Fatalf("untitled argv = %q", got)
	}
}

func TestEngineBinaryHonorsTheOverride(t *testing.T) {
	t.Setenv(EngineBinaryEnv, "/custom/ion")
	if bin, err := engineBinary(); err != nil || bin != "/custom/ion" {
		t.Fatalf("engine = %q, %v", bin, err)
	}
}
