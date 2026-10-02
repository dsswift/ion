package conversation

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

// savedRecord persists a conversation with n user messages and returns its ID.
func savedRecord(t *testing.T, subject string, n int) string {
	t.Helper()
	id := NewConversationID()
	conv := CreateConversation(id, "", "test-model")
	if subject != "" {
		conv.Principal = &types.ConversationPrincipal{Subject: subject}
	}
	for i := 0; i < n; i++ {
		AddUserMessage(conv, "message")
	}
	if err := Save(conv, ""); err != nil {
		t.Fatalf("Save: %v", err)
	}
	return id
}

func TestRecordPath_EmptyIDIsEmpty(t *testing.T) {
	t.Setenv("ION_DATA_DIR", t.TempDir())
	if got := RecordPath("", "oidc:alice"); got != "" {
		t.Errorf("RecordPath with no conversation = %q, want empty", got)
	}
}

// The path RecordPath reports is the file Save actually writes, in the flat
// root and in a principal's partition, before and after the first save.
func TestRecordPath_NamesTheFileSaveWrites(t *testing.T) {
	cases := []struct {
		name        string
		partitioned bool
		subject     string
	}{
		{"flat root", false, ""},
		{"partition", true, "oidc:alice"},
		{"unattributed under partitioning", true, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("ION_DATA_DIR", t.TempDir())
			if tc.partitioned {
				ConfigurePartitioning(DefaultConversationsDir(), &types.PrincipalPartitioningConfig{Enabled: true})
				t.Cleanup(ResetPartitioningForTest)
			}

			unsaved := NewConversationID()
			before := RecordPath(unsaved, tc.subject)
			if !filepath.IsAbs(before) {
				t.Fatalf("RecordPath = %q, want absolute", before)
			}

			id := savedRecord(t, tc.subject, 1)
			path := RecordPath(id, tc.subject)
			if _, err := os.Stat(path); err != nil {
				t.Fatalf("record not at reported path %q: %v", path, err)
			}
			if filepath.Dir(path) != filepath.Dir(before) {
				t.Errorf("path dir changed across save: before %q, after %q", filepath.Dir(before), filepath.Dir(path))
			}
			// An indexed conversation resolves without the owner's subject.
			if got := RecordPath(id, ""); tc.partitioned && got != path {
				t.Errorf("RecordPath without subject = %q, want %q", got, path)
			}
		})
	}
}

func TestReadMessagesPaginated_PagesAFinishedRecordWithTimestamps(t *testing.T) {
	t.Setenv("ION_DATA_DIR", t.TempDir())
	id := savedRecord(t, "", 5)

	page, err := ReadMessagesPaginated(id, 1, 2)
	if err != nil {
		t.Fatalf("ReadMessagesPaginated: %v", err)
	}
	if len(page.Messages) != 2 || page.Total != 5 || !page.HasMore {
		t.Fatalf("page = %d messages, total %d, hasMore %v; want 2, 5, true", len(page.Messages), page.Total, page.HasMore)
	}
	for i, m := range page.Messages {
		if m.Timestamp == 0 {
			t.Errorf("message %d has no timestamp", i)
		}
	}

	rest, err := ReadMessagesPaginated(id, 3, 0)
	if err != nil {
		t.Fatalf("ReadMessagesPaginated unbounded: %v", err)
	}
	if len(rest.Messages) != 2 || rest.HasMore {
		t.Errorf("unbounded tail = %d messages, hasMore %v; want 2, false", len(rest.Messages), rest.HasMore)
	}

	past, err := ReadMessagesPaginated(id, 9, 2)
	if err != nil {
		t.Fatalf("ReadMessagesPaginated past end: %v", err)
	}
	if past.Messages == nil || len(past.Messages) != 0 || past.Total != 5 {
		t.Errorf("past-end page = %v, total %d; want empty non-nil, 5", past.Messages, past.Total)
	}
}

func TestReadMessagesPaginated_DoesNotTouchTheRecord(t *testing.T) {
	t.Setenv("ION_DATA_DIR", t.TempDir())
	id := savedRecord(t, "", 2)
	dir := filepath.Dir(RecordPath(id, ""))

	snapshot := func() map[string]string {
		out := map[string]string{}
		entries, err := os.ReadDir(dir)
		if err != nil {
			t.Fatalf("ReadDir: %v", err)
		}
		for _, e := range entries {
			if e.IsDir() {
				continue
			}
			data, err := os.ReadFile(filepath.Join(dir, e.Name()))
			if err != nil {
				t.Fatalf("ReadFile %s: %v", e.Name(), err)
			}
			out[e.Name()] = string(data)
		}
		return out
	}

	before := snapshot()
	if _, err := ReadMessagesPaginated(id, 0, 0); err != nil {
		t.Fatalf("ReadMessagesPaginated: %v", err)
	}
	after := snapshot()
	if len(after) != len(before) {
		t.Fatalf("file set changed: %d files before, %d after", len(before), len(after))
	}
	for name, content := range before {
		if after[name] != content {
			t.Errorf("%s changed during a read", name)
		}
	}
}

func TestReadMessagesPaginated_UnknownIDIsNotFound(t *testing.T) {
	t.Setenv("ION_DATA_DIR", t.TempDir())
	if _, err := ReadMessagesPaginated("never-created", 0, 0); err == nil {
		t.Fatal("expected an error for an unknown conversation")
	}
}
