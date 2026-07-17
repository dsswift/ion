package extension

import (
	"testing"
)

func TestFireWebhookRegistered_NoHandlers(t *testing.T) {
	sdk := NewSDK()
	info := AsyncRegistrationInfo{Kind: "webhook", ID: "/x", Origin: "init"}
	if err := sdk.FireWebhookRegistered(nil, info); err != nil {
		t.Fatalf("expected nil veto without handlers, got %v", err)
	}
}

func TestFireWebhookRegistered_TypedVetoStruct(t *testing.T) {
	sdk := NewSDK()
	sdk.On(HookWebhookRegistered, func(_ *Context, _ interface{}) (interface{}, error) {
		return AsyncRegistrationVeto{Block: true, Reason: "policy: blocked"}, nil
	})
	err := sdk.FireWebhookRegistered(nil, AsyncRegistrationInfo{ID: "/x"})
	if err == nil || err.Error() != "policy: blocked" {
		t.Fatalf("expected blocked reason, got %v", err)
	}
}

func TestFireWebhookRegistered_PointerVeto(t *testing.T) {
	sdk := NewSDK()
	sdk.On(HookWebhookRegistered, func(_ *Context, _ interface{}) (interface{}, error) {
		return &AsyncRegistrationVeto{Block: true, Reason: "ptr-blocked"}, nil
	})
	if err := sdk.FireWebhookRegistered(nil, AsyncRegistrationInfo{}); err == nil || err.Error() != "ptr-blocked" {
		t.Fatalf("expected ptr-blocked reason, got %v", err)
	}
}

func TestFireWebhookRegistered_MapVetoFromSubprocess(t *testing.T) {
	sdk := NewSDK()
	sdk.On(HookWebhookRegistered, func(_ *Context, _ interface{}) (interface{}, error) {
		return map[string]interface{}{"block": true, "reason": "map-blocked"}, nil
	})
	if err := sdk.FireWebhookRegistered(nil, AsyncRegistrationInfo{}); err == nil || err.Error() != "map-blocked" {
		t.Fatalf("expected map-blocked reason, got %v", err)
	}
}

func TestFireWebhookRegistered_LastHandlerWins(t *testing.T) {
	sdk := NewSDK()
	// First handler vetoes...
	sdk.On(HookWebhookRegistered, func(_ *Context, _ interface{}) (interface{}, error) {
		return AsyncRegistrationVeto{Block: true, Reason: "first-block"}, nil
	})
	// ... but the second explicitly allows; the last opinion wins.
	sdk.On(HookWebhookRegistered, func(_ *Context, _ interface{}) (interface{}, error) {
		return AsyncRegistrationVeto{Block: false}, nil
	})
	if err := sdk.FireWebhookRegistered(nil, AsyncRegistrationInfo{}); err != nil {
		t.Fatalf("expected allow (last wins), got %v", err)
	}
}

func TestFireWebhookRegistered_DefaultReasonWhenEmpty(t *testing.T) {
	sdk := NewSDK()
	sdk.On(HookWebhookRegistered, func(_ *Context, _ interface{}) (interface{}, error) {
		return AsyncRegistrationVeto{Block: true}, nil
	})
	err := sdk.FireWebhookRegistered(nil, AsyncRegistrationInfo{})
	if err == nil {
		t.Fatal("expected blocked")
	}
	// Should default to "blocked by webhook_registered hook"
	if msg := err.Error(); msg != "blocked by webhook_registered hook" {
		t.Fatalf("expected default reason, got %q", msg)
	}
}

func TestFireWebhookDeregistered_IsObservationOnly(t *testing.T) {
	// Even if a handler "vetoes" deregistration, the hook does not
	// return an error and the caller proceeds. Verify the call doesn't
	// panic and ignores return values.
	sdk := NewSDK()
	called := 0
	sdk.On(HookWebhookDeregistered, func(_ *Context, _ interface{}) (interface{}, error) {
		called++
		return AsyncRegistrationVeto{Block: true, Reason: "ignored"}, nil
	})
	sdk.FireWebhookDeregistered(nil, AsyncRegistrationInfo{ID: "/x"})
	if called != 1 {
		t.Fatalf("deregister handler called %d times, want 1", called)
	}
}

func TestFireScheduleRegistered_VetoSymmetric(t *testing.T) {
	sdk := NewSDK()
	sdk.On(HookScheduleRegistered, func(_ *Context, _ interface{}) (interface{}, error) {
		return AsyncRegistrationVeto{Block: true, Reason: "no-test-jobs"}, nil
	})
	if err := sdk.FireScheduleRegistered(nil, AsyncRegistrationInfo{ID: "test_x"}); err == nil || err.Error() != "no-test-jobs" {
		t.Fatalf("expected schedule veto, got %v", err)
	}
}

func TestWebhookAuth_Validate(t *testing.T) {
	cases := []struct {
		name string
		auth WebhookAuth
		ok   bool
	}{
		{"none ok", WebhookAuth{Kind: AuthNone}, true},
		{"bearer needs token ref", WebhookAuth{Kind: AuthBearer}, false},
		{"bearer with token ref", WebhookAuth{Kind: AuthBearer, TokenRefName: "T"}, true},
		{"shared-secret needs header", WebhookAuth{Kind: AuthSharedSecret, TokenRefName: "T"}, false},
		{"shared-secret needs token ref", WebhookAuth{Kind: AuthSharedSecret, HeaderName: "X-Sig"}, false},
		{"shared-secret ok", WebhookAuth{Kind: AuthSharedSecret, HeaderName: "X-Sig", TokenRefName: "T"}, true},
		{"hmac sha256 ok", WebhookAuth{Kind: AuthHmacSignature, HeaderName: "X-Sig", Algorithm: "sha256", TokenRefName: "T"}, true},
		{"hmac bad alg", WebhookAuth{Kind: AuthHmacSignature, HeaderName: "X-Sig", Algorithm: "md5", TokenRefName: "T"}, false},
		{"unknown kind", WebhookAuth{Kind: "bogus"}, false},
		{"zero value rejected", WebhookAuth{}, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			err := c.auth.Validate()
			if c.ok && err != nil {
				t.Fatalf("expected ok, got %v", err)
			}
			if !c.ok && err == nil {
				t.Fatal("expected error, got nil")
			}
		})
	}
}

func TestScheduleJob_Validate(t *testing.T) {
	cases := []struct {
		name string
		job  ScheduleJob
		ok   bool
	}{
		{"daily ok", ScheduleJob{JobID: "a", Kind: ScheduleDaily, Time: "09:30"}, true},
		{"daily bad time", ScheduleJob{JobID: "a", Kind: ScheduleDaily, Time: "9:30"}, false},
		{"daily out of range", ScheduleJob{JobID: "a", Kind: ScheduleDaily, Time: "25:00"}, false},
		{"weekly ok", ScheduleJob{JobID: "w", Kind: ScheduleWeekly, Time: "23:59", DayOfWeek: "monday"}, true},
		{"weekly bad day", ScheduleJob{JobID: "w", Kind: ScheduleWeekly, Time: "12:00", DayOfWeek: "moonday"}, false},
		{"interval ok", ScheduleJob{JobID: "i", Kind: ScheduleInterval, IntervalMs: 5000}, true},
		{"interval too small", ScheduleJob{JobID: "i", Kind: ScheduleInterval, IntervalMs: 500}, false},
		{"once ok", ScheduleJob{JobID: "o", Kind: ScheduleOnce, DelayMs: 1000}, true},
		{"once ok large delay", ScheduleJob{JobID: "o", Kind: ScheduleOnce, DelayMs: 60_000}, true},
		{"once too small", ScheduleJob{JobID: "o", Kind: ScheduleOnce, DelayMs: 500}, false},
		{"once zero delay", ScheduleJob{JobID: "o", Kind: ScheduleOnce, DelayMs: 0}, false},
		{"empty id", ScheduleJob{Kind: ScheduleInterval, IntervalMs: 1000}, false},
		{"unknown kind", ScheduleJob{JobID: "x", Kind: "monthly"}, false},
		{"negative timeout", ScheduleJob{JobID: "n", Kind: ScheduleDaily, Time: "00:00", TimeoutMs: -1}, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			err := c.job.Validate()
			if c.ok && err != nil {
				t.Fatalf("expected ok, got %v", err)
			}
			if !c.ok && err == nil {
				t.Fatal("expected error, got nil")
			}
		})
	}
}
