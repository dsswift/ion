package extension

import "testing"

func TestFireBeforeSlashModelBoundary(t *testing.T) {
	t.Run("no handler abstains", func(t *testing.T) {
		sdk := NewSDK()
		if got := sdk.FireBeforeSlashModelBoundary(testCtx(), SlashModelBoundaryInfo{}); got != nil {
			t.Fatalf("result = %+v, want nil", got)
		}
	})

	t.Run("last explicit decision wins", func(t *testing.T) {
		sdk := NewSDK()
		deny := false
		allow := true
		sdk.On(HookBeforeSlashModelBoundary, func(_ *Context, payload interface{}) (interface{}, error) {
			info := payload.(SlashModelBoundaryInfo)
			if info.Command != "/review" || info.RequestedTier != "reasoning" || info.ServingModel != "current" || !info.HasHistory || info.DefaultApply {
				t.Fatalf("payload = %+v", info)
			}
			return SlashModelBoundaryResult{Apply: &deny}, nil
		})
		sdk.On(HookBeforeSlashModelBoundary, func(_ *Context, _ interface{}) (interface{}, error) {
			return map[string]interface{}{"apply": allow}, nil
		})

		got := sdk.FireBeforeSlashModelBoundary(testCtx(), SlashModelBoundaryInfo{
			Command: "/review", RequestedTier: "reasoning", ServingModel: "current",
			HasHistory: true, DefaultApply: false,
		})
		if got == nil || got.Apply == nil || !*got.Apply {
			t.Fatalf("result = %+v, want apply=true", got)
		}
	})
}
