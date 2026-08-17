package conversation

import "testing"

func TestUpdateOrCreateOnDisk_CreatesAndPersistsOneMutation(t *testing.T) {
	dir := t.TempDir()
	created := 0
	err := UpdateOrCreateOnDisk("first-turn", dir, func() *Conversation {
		created++
		return CreateConversation("first-turn", "system", "test-model")
	}, func(conv *Conversation) (bool, error) {
		AddUserMessage(conv, "first durable turn")
		return true, nil
	})
	if err != nil {
		t.Fatalf("UpdateOrCreateOnDisk: %v", err)
	}
	if created != 1 {
		t.Fatalf("create calls = %d, want 1", created)
	}
	loaded, err := Load("first-turn", dir)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if len(loaded.Entries) != 1 {
		t.Fatalf("entries = %d, want 1", len(loaded.Entries))
	}
}

func TestUpdateOrCreateOnDisk_DoesNotCreateExistingConversation(t *testing.T) {
	dir := t.TempDir()
	conv := CreateConversation("existing", "system", "test-model")
	AddUserMessage(conv, "seed")
	if err := Save(conv, dir); err != nil {
		t.Fatalf("seed Save: %v", err)
	}
	created := 0
	err := UpdateOrCreateOnDisk("existing", dir, func() *Conversation {
		created++
		return CreateConversation("existing", "wrong", "wrong")
	}, func(conv *Conversation) (bool, error) { return false, nil })
	if err != nil {
		t.Fatalf("UpdateOrCreateOnDisk: %v", err)
	}
	if created != 0 {
		t.Fatalf("create calls = %d, want 0", created)
	}
}
