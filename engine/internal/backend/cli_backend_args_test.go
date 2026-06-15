package backend

import (
	"reflect"
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

// TestCliResumeArgs pins the precise resume mechanism: the CLI backend
// resumes ONLY with a captured claude-native session UUID
// (RunOptions.CliResumeSessionID), never with Ion's conversation id
// (RunOptions.SessionID).
func TestCliResumeArgs(t *testing.T) {
	cases := []struct {
		name string
		opts types.RunOptions
		want []string
	}{
		{
			name: "first run: no captured UUID -> omit --resume",
			opts: types.RunOptions{},
			want: nil,
		},
		{
			name: "subsequent run: captured UUID -> --resume <uuid>",
			opts: types.RunOptions{CliResumeSessionID: "11111111-2222-3333-4444-555555555555"},
			want: []string{"--resume", "11111111-2222-3333-4444-555555555555"},
		},
		{
			name: "Ion SessionID set but no claude UUID -> still no --resume",
			opts: types.RunOptions{SessionID: "1781483744990-37463b20c27b"},
			want: nil,
		},
		{
			name: "both set -> resume uses the claude UUID, ignores Ion SessionID",
			opts: types.RunOptions{
				SessionID:          "1781483744990-37463b20c27b",
				CliResumeSessionID: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
			},
			want: []string{"--resume", "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := cliResumeArgs(tc.opts)
			if !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("cliResumeArgs(%+v) = %v, want %v", tc.opts, got, tc.want)
			}
		})
	}
}
