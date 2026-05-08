package extension

import (
	"testing"
)

func TestFireSystemInjectNoHandlers(t *testing.T) {
	sdk := NewSDK()
	ctx := testCtx()
	info := SystemInjectInfo{
		Kind:        "turn_limit_warning",
		DefaultText: "[SYSTEM] default text",
		Turn:        8,
		MaxTurns:    10,
	}

	text, suppress := sdk.FireSystemInject(ctx, info)
	if suppress {
		t.Error("should not suppress when no handlers registered")
	}
	if text != info.DefaultText {
		t.Errorf("text = %q, want %q", text, info.DefaultText)
	}
}

func TestFireSystemInjectCustomText(t *testing.T) {
	sdk := NewSDK()
	sdk.On(HookSystemInject, func(ctx *Context, payload interface{}) (interface{}, error) {
		return SystemInjectResult{Text: "custom text"}, nil
	})

	ctx := testCtx()
	info := SystemInjectInfo{
		Kind:        "plan_mode_reminder",
		DefaultText: "[SYSTEM] default",
		Turn:        2,
		MaxTurns:    10,
	}

	text, suppress := sdk.FireSystemInject(ctx, info)
	if suppress {
		t.Error("should not suppress")
	}
	if text != "custom text" {
		t.Errorf("text = %q, want 'custom text'", text)
	}
}

func TestFireSystemInjectSuppress(t *testing.T) {
	sdk := NewSDK()
	sdk.On(HookSystemInject, func(ctx *Context, payload interface{}) (interface{}, error) {
		return SystemInjectResult{Suppress: true}, nil
	})

	ctx := testCtx()
	info := SystemInjectInfo{
		Kind:        "max_token_continue",
		DefaultText: "Continue from where you left off.",
		Turn:        5,
		MaxTurns:    0,
	}

	text, suppress := sdk.FireSystemInject(ctx, info)
	if !suppress {
		t.Error("should suppress")
	}
	if text != "" {
		t.Errorf("text should be empty when suppressed, got %q", text)
	}
}

func TestFireSystemInjectMapResult(t *testing.T) {
	sdk := NewSDK()
	sdk.On(HookSystemInject, func(ctx *Context, payload interface{}) (interface{}, error) {
		return map[string]interface{}{
			"text": "from map",
		}, nil
	})

	ctx := testCtx()
	info := SystemInjectInfo{
		Kind:        "turn_limit_warning",
		DefaultText: "default",
	}

	text, suppress := sdk.FireSystemInject(ctx, info)
	if suppress {
		t.Error("should not suppress")
	}
	if text != "from map" {
		t.Errorf("text = %q, want 'from map'", text)
	}
}

func TestFireSystemInjectMapSuppress(t *testing.T) {
	sdk := NewSDK()
	sdk.On(HookSystemInject, func(ctx *Context, payload interface{}) (interface{}, error) {
		return map[string]interface{}{
			"suppress": true,
		}, nil
	})

	ctx := testCtx()
	info := SystemInjectInfo{
		Kind:        "plan_mode_reminder",
		DefaultText: "default",
	}

	_, suppress := sdk.FireSystemInject(ctx, info)
	if !suppress {
		t.Error("should suppress via map result")
	}
}

func TestExtensionGroupFireSystemInject(t *testing.T) {
	group := NewExtensionGroup()

	// First host: no handler (returns default text passthrough)
	host1 := NewHost()
	group.Add(host1)

	// Second host: returns custom text (last non-empty wins)
	host2 := NewHost()
	host2.SDK().On(HookSystemInject, func(ctx *Context, payload interface{}) (interface{}, error) {
		return SystemInjectResult{Text: "from host2"}, nil
	})
	group.Add(host2)

	ctx := testCtx()
	info := SystemInjectInfo{
		Kind:        "turn_limit_warning",
		DefaultText: "default",
	}

	text, suppress := group.FireSystemInject(ctx, info)
	if suppress {
		t.Error("should not suppress")
	}
	if text != "from host2" {
		t.Errorf("text = %q, want 'from host2'", text)
	}
}

func TestExtensionGroupFireSystemInjectDefaultPassthrough(t *testing.T) {
	group := NewExtensionGroup()

	// No hosts register a handler; default text should pass through.
	host1 := NewHost()
	group.Add(host1)

	ctx := testCtx()
	info := SystemInjectInfo{
		Kind:        "turn_limit_warning",
		DefaultText: "default warning",
	}

	text, suppress := group.FireSystemInject(ctx, info)
	if suppress {
		t.Error("should not suppress")
	}
	if text != "default warning" {
		t.Errorf("text = %q, want 'default warning'", text)
	}
}

func TestExtensionGroupFireSystemInjectSuppressShortCircuits(t *testing.T) {
	group := NewExtensionGroup()

	host1 := NewHost()
	host1.SDK().On(HookSystemInject, func(ctx *Context, payload interface{}) (interface{}, error) {
		return SystemInjectResult{Suppress: true}, nil
	})
	group.Add(host1)

	// Second host should not be reached
	host2 := NewHost()
	host2.SDK().On(HookSystemInject, func(ctx *Context, payload interface{}) (interface{}, error) {
		t.Error("host2 should not be reached when host1 suppresses")
		return nil, nil
	})
	group.Add(host2)

	ctx := testCtx()
	info := SystemInjectInfo{Kind: "plan_mode_reminder", DefaultText: "default"}

	_, suppress := group.FireSystemInject(ctx, info)
	if !suppress {
		t.Error("should suppress")
	}
}
