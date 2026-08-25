package ion

import (
	"context"
	"testing"
	"time"
)

// async_test.go — the pre-init drain versus post-init RPC split, and the
// fire paths for webhooks and schedules.
//
// The dual path is the subtle part. A registration made at module scope, before
// the engine has even sent init, has nowhere to go as an RPC — the engine is
// not listening for one yet. So it queues and rides the handshake. The same
// call one millisecond after the handshake must take the RPC path instead,
// because the handshake is over and the engine will never look at the queue
// again. Getting the switch wrong loses registrations silently.

// TestPreInitWebhookDrainsIntoInitResponse pins the pre-init half.
func TestPreInitWebhookDrainsIntoInitResponse(t *testing.T) {
	fe := newFakeEngine(t, WithName("preinit-webhook-test"))

	_, err := fe.sdk.Webhooks().Register(context.Background(),
		WebhookRoute{Path: "/inbound", Method: "POST", Auth: WebhookAuth{Kind: AuthNone}},
		func(c context.Context, ctx *Context, req WebhookRequest) (WebhookResponse, error) {
			return WebhookResponse{Status: 204}, nil
		})
	if err != nil {
		t.Fatalf("pre-init registration failed: %v", err)
	}

	// Nothing may have gone out on the wire yet: there is no engine to answer.
	for _, f := range fe.allFrames() {
		if f["method"] == "ext/register_webhook" {
			t.Fatalf("pre-init registration sent an RPC instead of queueing: %+v", f)
		}
	}

	fe.start()
	result := fe.doInit(ExtensionConfig{})

	webhooks, ok := result["webhooks"].([]any)
	if !ok || len(webhooks) != 1 {
		t.Fatalf("init webhooks = %+v, want one entry", result["webhooks"])
	}
	route, _ := webhooks[0].(map[string]any)
	if route["path"] != "/inbound" {
		t.Errorf("webhook path = %v, want /inbound", route["path"])
	}
	if route["method"] != "POST" {
		t.Errorf("webhook method = %v, want POST", route["method"])
	}
}

// TestPostInitWebhookUsesRPC pins the post-init half, including that the
// engine's answer is what completes the call.
func TestPostInitWebhookUsesRPC(t *testing.T) {
	fe := newFakeEngine(t, WithName("postinit-webhook-test"))
	fe.start()
	fe.doInit(ExtensionConfig{})

	done := make(chan error, 1)
	go func() {
		_, err := fe.sdk.Webhooks().Register(context.Background(),
			WebhookRoute{Path: "/late", Auth: WebhookAuth{Kind: AuthNone}},
			func(c context.Context, ctx *Context, req WebhookRequest) (WebhookResponse, error) {
				return WebhookResponse{}, nil
			})
		done <- err
	}()

	frame := fe.awaitMethod("ext/register_webhook")
	params, _ := frame["params"].(map[string]any)
	if params["path"] != "/late" {
		t.Errorf("registered path = %v, want /late", params["path"])
	}
	id, _ := frame["id"].(float64)
	fe.respond(id, map[string]any{"ok": true, "id": "/late"})

	if err := <-done; err != nil {
		t.Fatalf("post-init registration failed: %v", err)
	}
}

// TestVetoedRegistrationDropsLocalHandler pins the cleanup on refusal. If the
// engine vetoes a route but the SDK keeps its handler, the two sides disagree
// about what is registered — and the disagreement is invisible until a fire
// arrives for a route the engine supposedly does not have.
func TestVetoedRegistrationDropsLocalHandler(t *testing.T) {
	fe := newFakeEngine(t, WithName("veto-test"))
	fe.start()
	fe.doInit(ExtensionConfig{})

	done := make(chan error, 1)
	go func() {
		_, err := fe.sdk.Webhooks().Register(context.Background(),
			WebhookRoute{Path: "/refused", Auth: WebhookAuth{Kind: AuthNone}},
			func(c context.Context, ctx *Context, req WebhookRequest) (WebhookResponse, error) {
				return WebhookResponse{}, nil
			})
		done <- err
	}()

	frame := fe.awaitMethod("ext/register_webhook")
	id, _ := frame["id"].(float64)
	fe.respondError(id, CodeHandlerError, "policy: inbound webhooks are disabled")

	err := <-done
	if err == nil {
		t.Fatal("expected the veto to surface as an error")
	}

	fe.sdk.async.mu.RLock()
	_, stillThere := fe.sdk.async.webhookHandlers["/refused"]
	fe.sdk.async.mu.RUnlock()
	if stillThere {
		t.Error("a vetoed route left its handler registered locally")
	}
}

// TestWebhookFireDeliversRequest pins the inbound fire path and the response
// defaults: a zero-value WebhookResponse must become a 200.
func TestWebhookFireDeliversRequest(t *testing.T) {
	fe := newFakeEngine(t, WithName("webhook-fire-test"))

	got := make(chan WebhookRequest, 1)
	_, err := fe.sdk.Webhooks().Register(context.Background(),
		WebhookRoute{Path: "/fire", Auth: WebhookAuth{Kind: AuthNone}},
		func(c context.Context, ctx *Context, req WebhookRequest) (WebhookResponse, error) {
			got <- req
			return WebhookResponse{Body: "handled"}, nil
		})
	if err != nil {
		t.Fatalf("register: %v", err)
	}

	fe.start()
	fe.doInit(ExtensionConfig{})

	fe.request(70, methodFireAsync, map[string]any{
		"kind":       "webhook",
		"id":         "/fire",
		"sessionKey": "sk-1",
		"payload": map[string]any{
			"method":  "POST",
			"path":    "/fire",
			"body":    `{"n":1}`,
			"headers": map[string]string{"X-Test": "yes"},
			"remote":  "10.0.0.1",
		},
	})
	resp := fe.awaitResponse(70)

	req := <-got
	if req.Method != "POST" || req.Body != `{"n":1}` {
		t.Errorf("request = %+v, want the POST body through intact", req)
	}
	if req.Headers["X-Test"] != "yes" {
		t.Errorf("headers = %+v, want X-Test", req.Headers)
	}
	var decoded struct {
		N int `json:"n"`
	}
	if err := req.JSON(&decoded); err != nil || decoded.N != 1 {
		t.Errorf("JSON() = %+v / %v, want n=1", decoded, err)
	}

	result, _ := resp["result"].(map[string]any)
	if status, _ := result["status"].(float64); int(status) != 200 {
		t.Errorf("status = %v, want the 200 default", result["status"])
	}
	if result["body"] != "handled" {
		t.Errorf("body = %v, want handled", result["body"])
	}
}

// TestTokenRefResolvesLazily pins that a webhook secret never crosses the wire
// at registration. The engine asks for it by symbolic name at verification
// time, which is what lets a rotating credential work without re-registering.
func TestTokenRefResolvesLazily(t *testing.T) {
	fe := newFakeEngine(t, WithName("token-ref-test"))

	_, err := fe.sdk.Webhooks().RegisterWithToken(context.Background(),
		WebhookRoute{Path: "/secure", Auth: WebhookAuth{Kind: AuthBearer}},
		func(c context.Context, ctx *Context, req WebhookRequest) (WebhookResponse, error) {
			return WebhookResponse{}, nil
		},
		func() (string, error) { return "s3cr3t", nil })
	if err != nil {
		t.Fatalf("register: %v", err)
	}

	fe.start()
	result := fe.doInit(ExtensionConfig{})

	// The declaration carries the ref name, never the secret.
	webhooks, _ := result["webhooks"].([]any)
	route, _ := webhooks[0].(map[string]any)
	auth, _ := route["auth"].(map[string]any)
	refName, _ := auth["tokenRefName"].(string)
	if refName == "" {
		t.Fatal("registration carries no tokenRefName")
	}
	if auth["token"] != nil {
		t.Errorf("registration leaked a token value: %+v", auth)
	}

	fe.request(71, methodResolveToken, map[string]any{"name": refName})
	resp := fe.awaitResponse(71)
	result2, _ := resp["result"].(map[string]any)
	if result2["value"] != "s3cr3t" {
		t.Errorf("resolved token = %v, want s3cr3t", result2["value"])
	}
}

// TestUnknownTokenRefResolvesEmpty pins the miss case: an unregistered ref
// resolves to an empty token, which fails the auth check on one request rather
// than erroring the whole route.
func TestUnknownTokenRefResolvesEmpty(t *testing.T) {
	fe := newFakeEngine(t, WithName("unknown-ref-test"))
	fe.start()
	fe.doInit(ExtensionConfig{})

	fe.request(72, methodResolveToken, map[string]any{"name": "webhook:/nope:token"})
	resp := fe.awaitResponse(72)

	result, _ := resp["result"].(map[string]any)
	if result["value"] != "" {
		t.Errorf("value = %v, want an empty string", result["value"])
	}
	fe.awaitLog("token ref requested but not registered")
}

// TestPreInitScheduleDrainsIntoInitResponse pins schedule queueing, including
// the predicate ref name.
func TestPreInitScheduleDrainsIntoInitResponse(t *testing.T) {
	fe := newFakeEngine(t, WithName("preinit-schedule-test"))

	_, err := fe.sdk.Schedule().Daily(context.Background(),
		ScheduleOpts{
			ID:      "nightly",
			Time:    "03:30",
			TZ:      "America/Chicago",
			Enabled: func() (bool, error) { return true, nil },
		},
		func(c context.Context, ctx *Context, control ScheduleControl, meta ScheduleFireMeta) error {
			return nil
		})
	if err != nil {
		t.Fatalf("schedule registration failed: %v", err)
	}

	fe.start()
	result := fe.doInit(ExtensionConfig{})

	schedules, ok := result["schedules"].([]any)
	if !ok || len(schedules) != 1 {
		t.Fatalf("init schedules = %+v, want one entry", result["schedules"])
	}
	job, _ := schedules[0].(map[string]any)
	if job["id"] != "nightly" || job["kind"] != "daily" || job["time"] != "03:30" {
		t.Errorf("job = %+v, want the daily 03:30 declaration", job)
	}
	if job["enabledRefName"] == nil || job["enabledRefName"] == "" {
		t.Error("job carries no enabledRefName despite an Enabled predicate")
	}
}

// TestSchedulePredicateResolves pins that the enabled() callback is consulted
// through engine/resolve_predicate rather than evaluated at registration.
func TestSchedulePredicateResolves(t *testing.T) {
	fe := newFakeEngine(t, WithName("predicate-test"))

	enabled := false
	_, err := fe.sdk.Schedule().Interval(context.Background(),
		ScheduleOpts{ID: "poller", IntervalMs: 60000, Enabled: func() (bool, error) { return enabled, nil }},
		func(c context.Context, ctx *Context, control ScheduleControl, meta ScheduleFireMeta) error {
			return nil
		})
	if err != nil {
		t.Fatalf("register: %v", err)
	}

	fe.start()
	fe.doInit(ExtensionConfig{})

	ref := predicateRefName("poller")

	fe.request(80, methodResolvePredicate, map[string]any{"name": ref})
	resp := fe.awaitResponse(80)
	if result, _ := resp["result"].(map[string]any); result["enabled"] != false {
		t.Errorf("enabled = %v, want false", result["enabled"])
	}

	// Flip the value the callback closes over: the engine must see the new
	// answer without any re-registration.
	enabled = true
	fe.request(81, methodResolvePredicate, map[string]any{"name": ref})
	resp = fe.awaitResponse(81)
	if result, _ := resp["result"].(map[string]any); result["enabled"] != true {
		t.Errorf("enabled = %v, want true after the predicate changed", result["enabled"])
	}
}

// TestUnknownPredicateResolvesEnabled pins the miss case. A schedule with no
// predicate always runs, so an unregistered ref must resolve to enabled — the
// opposite default would silently stop jobs.
func TestUnknownPredicateResolvesEnabled(t *testing.T) {
	fe := newFakeEngine(t, WithName("unknown-predicate-test"))
	fe.start()
	fe.doInit(ExtensionConfig{})

	fe.request(82, methodResolvePredicate, map[string]any{"name": "schedule:ghost:enabled"})
	resp := fe.awaitResponse(82)

	if result, _ := resp["result"].(map[string]any); result["enabled"] != true {
		t.Errorf("enabled = %v, want true for an unregistered predicate", result["enabled"])
	}
}

// TestScheduleFireDeliversMeta pins that the handler can tell a live tick from
// a backfill, which is the difference between "do the daily work" and "catch
// up on the day we missed".
func TestScheduleFireDeliversMeta(t *testing.T) {
	fe := newFakeEngine(t, WithName("schedule-fire-test"))

	got := make(chan ScheduleFireMeta, 1)
	gotControl := make(chan ScheduleControl, 1)
	_, err := fe.sdk.Schedule().Daily(context.Background(),
		ScheduleOpts{ID: "daily-job", Time: "09:00"},
		func(c context.Context, ctx *Context, control ScheduleControl, meta ScheduleFireMeta) error {
			got <- meta
			gotControl <- control
			return nil
		})
	if err != nil {
		t.Fatalf("register: %v", err)
	}

	fe.start()
	fe.doInit(ExtensionConfig{})

	fe.request(90, methodFireAsync, map[string]any{
		"kind":       "schedule",
		"id":         "daily-job",
		"sessionKey": "sk-2",
		"payload": map[string]any{
			"firedAt":       "2026-01-02T09:00:00Z",
			"backfill":      true,
			"missedSlotUtc": "2026-01-01T09:00:00Z",
		},
	})
	fe.awaitResponse(90)

	meta := <-got
	if !meta.Backfill || meta.MissedSlotUtc != "2026-01-01T09:00:00Z" {
		t.Errorf("meta = %+v, want a backfill for the missed slot", meta)
	}
	if control := <-gotControl; control.JobID != "daily-job" {
		t.Errorf("control.JobID = %q, want daily-job", control.JobID)
	}
}

// TestOnceJobSelfCleansAfterFire pins that a once job's local handler is
// dropped after its single firing, mirroring the engine's own deregistration.
// Leaving it would let a lingering tick invoke work the engine already
// considers finished.
func TestOnceJobSelfCleansAfterFire(t *testing.T) {
	fe := newFakeEngine(t, WithName("once-job-test"))

	fired := make(chan struct{}, 2)
	_, err := fe.sdk.Schedule().Once(context.Background(),
		ScheduleOpts{ID: "one-shot", DelayMs: 1000},
		func(c context.Context, ctx *Context, control ScheduleControl, meta ScheduleFireMeta) error {
			fired <- struct{}{}
			return nil
		})
	if err != nil {
		t.Fatalf("register: %v", err)
	}

	fe.start()
	fe.doInit(ExtensionConfig{})

	fe.request(91, methodFireAsync, map[string]any{
		"kind": "schedule", "id": "one-shot", "payload": map[string]any{},
	})
	fe.awaitResponse(91)
	<-fired

	fe.sdk.async.mu.RLock()
	_, stillThere := fe.sdk.async.scheduleHandlers["one-shot"]
	fe.sdk.async.mu.RUnlock()
	if stillThere {
		t.Error("a once job kept its handler after firing")
	}

	// A second tick must find nothing rather than running the work again.
	fe.request(92, methodFireAsync, map[string]any{
		"kind": "schedule", "id": "one-shot", "payload": map[string]any{},
	})
	resp := fe.awaitResponse(92)
	if resp["error"] == nil {
		t.Error("a second fire of a once job should not succeed")
	}
	select {
	case <-fired:
		t.Error("the once handler ran twice")
	case <-time.After(100 * time.Millisecond):
	}
}

// TestPreInitUnregisterRemovesFromQueue pins that unregistering before init
// removes the declaration from the handshake rather than leaving it queued and
// then deregistering it immediately afterwards.
func TestPreInitUnregisterRemovesFromQueue(t *testing.T) {
	fe := newFakeEngine(t, WithName("preinit-unregister-test"))

	handle, err := fe.sdk.Schedule().Interval(context.Background(),
		ScheduleOpts{ID: "temp", IntervalMs: 5000},
		func(c context.Context, ctx *Context, control ScheduleControl, meta ScheduleFireMeta) error {
			return nil
		})
	if err != nil {
		t.Fatalf("register: %v", err)
	}
	if err := handle.Unregister(context.Background()); err != nil {
		t.Fatalf("unregister: %v", err)
	}

	fe.start()
	result := fe.doInit(ExtensionConfig{})

	if schedules, ok := result["schedules"].([]any); ok && len(schedules) != 0 {
		t.Errorf("init schedules = %+v, want none after the pre-init unregister", schedules)
	}
}

// TestFireForUnknownIDErrors pins that a fire naming something this extension
// never registered produces an error rather than silence. The engine is
// waiting on the response, and a silent drop would leave that call pending.
func TestFireForUnknownIDErrors(t *testing.T) {
	fe := newFakeEngine(t, WithName("unknown-fire-test"))
	fe.start()
	fe.doInit(ExtensionConfig{})

	fe.request(93, methodFireAsync, map[string]any{
		"kind": "webhook", "id": "/never-registered", "payload": map[string]any{},
	})
	resp := fe.awaitResponse(93)

	if resp["error"] == nil {
		t.Errorf("expected an error for an unregistered route, got %+v", resp)
	}
}

func TestDailyScheduleForwardsRecoveryFields(t *testing.T) {
	fe := newFakeEngine(t, WithName("daily-recovery-fields"))
	_, err := fe.sdk.Schedule().Daily(context.Background(),
		ScheduleOpts{
			ID: "weekday-brief", Time: "09:00", DaysOfWeek: []string{"monday", "wednesday"},
			CatchUp: "latest", CatchUpGroup: "briefings", CatchUpScope: "same_day",
		},
		func(context.Context, *Context, ScheduleControl, ScheduleFireMeta) error { return nil })
	if err != nil {
		t.Fatalf("register: %v", err)
	}
	fe.start()
	result := fe.doInit(ExtensionConfig{})
	schedules := result["schedules"].([]any)
	job := schedules[0].(map[string]any)
	if job["catchUp"] != "latest" || job["catchUpGroup"] != "briefings" || job["catchUpScope"] != "same_day" {
		t.Fatalf("recovery fields = %+v", job)
	}
	days := job["daysOfWeek"].([]any)
	if len(days) != 2 || days[0] != "monday" || days[1] != "wednesday" {
		t.Fatalf("daysOfWeek = %#v", days)
	}
}
