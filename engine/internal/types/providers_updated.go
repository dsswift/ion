package types

// EventProvidersUpdated is an advisory engine event signaling that provider
// auth state or the available-model listing may have changed. It fires whenever
// the delegated-CLI probes are refreshed: after a login or logout completes, on
// refresh_models, and at startup once the initial probe lands.
//
// It carries no payload. The event is a pure "re-query" nudge: consumers that
// render provider/model state issue a fresh list_models to obtain the
// authoritative provider entries (auth status, effective backend) and model
// listing. The engine holds the authoritative state; this event only tells
// consumers when it is worth pulling again.
//
// Semantics: advisory and idempotent. Emitting it when nothing actually changed
// is safe — a consumer simply re-queries and observes identical state. Unlike
// engine_provider_login (an incremental per-stage login-lifecycle event bound
// to one interactive flow), engine_providers_updated is trigger-agnostic and
// consumer-agnostic: any provider-state change source emits the same signal.
const EventProvidersUpdated = "engine_providers_updated"
