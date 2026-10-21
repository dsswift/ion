---
title: Central Log Collection
description: Reference architecture for fleet-wide collection of Ion's operational logs and telemetry, with a self-hosted tutorial and an enterprise worked example.
sidebar_position: 8
---

# Central Log Collection

This is the reference architecture for collecting Ion's observability output across a fleet:
every workstation engine and every headless engine, shipping into one organizational sink.
It builds on two other documents and does not repeat them:

- [`docs/observability/consuming-logs.md`](../observability/consuming-logs.md) — the per-machine
  consumer guide: both stream schemas, the egress config reference, and the correlation model.
- [`telemetry.md`](telemetry.md) — the telemetry target reference (`http`, `file`, `otel`).

Read those first. This document answers the question they stop short of: **how does an
organization aggregate all of it, from every device, into infrastructure it controls?**

---

## The decoupled collection model

The architecture rests on one contract:

> **Every Ion component ships to a single configurable ingestion endpoint. Everything
> downstream of that endpoint — storage, query, dashboards, retention — belongs to the
> organization and is invisible to Ion.**

Ion components never know the storage topology. The engine does not know whether its egress
endpoint is backed by Loki, a SIEM, an event bus, or a blob archive. This is the same
decoupling principle as the engine's own layered architecture: Ion owns the *mechanism*
(structured emission, batching, retry, enterprise sealing); the organization owns the
*opinion* (where the data lands and what happens to it).

The consequence is that the ingestion endpoint is **interchangeable**. Any of these satisfies
the single-sink contract:

| Sink style | What the endpoint is | Typical downstream |
|---|---|---|
| OTLP collector | An OpenTelemetry collector (Alloy, the upstream OTel Collector, Vector) exposing OTLP/HTTP | Loki, Tempo, Mimir, any OTLP-capable backend |
| Plain HTTP endpoint | Any HTTPS service accepting POSTed JSON arrays (the `http` egress wire shape) | SIEM ingestion APIs, custom pipelines, serverless functions |
| Event bus | A managed ingestion intake (e.g. Azure Event Hubs, reached directly via the engine's native `eventhub` AMQP target — see [`telemetry.md`](telemetry.md) § "Event Hub target" — or fronted by a collector translating OTLP into the bus) | Fan-out to multiple independent consumers (see the [managed-cloud example](#example-a-managed-cloud-event-bus-deployment) below) |
| Object store | A collector or tailer batching lines into object storage (S3, Azure Blob, GCS) | Athena/Synapse-style query-on-archive, compliance retention |

Swapping one sink for another is a configuration change on the fleet, not a change to any Ion
component. That is the invariant to protect when designing your deployment: if a component
would need to know which backend is behind the endpoint, the design is wrong.

**OTLP is the canonical egress; the collector owns backend knowledge.** Of the sink styles above,
an OTLP collector is the recommended default. Ion ships
operational logs as OTLP/HTTP losslessly — the line as the record body; the trace and span as the
LogRecord `traceId` and `spanId`; the component, host, install, and build as the resource
(`service.name`, `host.name`, `service.instance.id`, `service.version`); `tag`, the session and
conversation ids, and `user` as attributes; and **every other `fields` key flattened to its own
natively-typed attribute** (`run_id` included, since it lives in `fields`). Point every component at
one OTLP collector endpoint and let that collector's pipeline fan the records out to Loki, Splunk,
Elastic, an object archive, or several at once. All backend-specific routing and auth lives in the
**collector's config**, never in Ion — adding a backend is a collector-exporter edit, not an Ion
redeploy. The `http` target (a JSON array of Ion's native record shape per batch) is the escape
hatch for a consumer that wants Ion's verbatim JSON and controls its own receiver; prefer `otel` for
everything else. Field-level detail:
[`consuming-logs.md` § Option 3](../observability/consuming-logs.md#option-3--programmable-egress-no-ion-provided-stack-required).

**The OTLP shape is pinned.** The engine's exporter output for a canonical record — attribute keys,
value types, sorted order, constant-`msg` body — is pinned by a test, and a client that ships its own
records follows the same shape. A collector therefore ingests one uniform log shape regardless of which surface emitted
a line, and downstream backend config never has to special-case the source.

Both of Ion's streams ride the same model. The **operational log** ships via
`logging.egressTargets`; the **telemetry stream** ships via `telemetry.targets`. The two
config shapes are deliberately parallel (they share `OtelConfig`), so both streams can point
at the same endpoint and be joined downstream through the shared correlation vocabulary
(`session_id`, `conversation_id`, `run_id`, `trace_id`).

**`trace_id` is the one to build APM on.** It is a W3C trace-context trace-id scoped to a single
prompt-to-completion run, so it maps directly onto whatever your backend calls a trace — an
Application Insights `operation_Id`, a Jaeger/Tempo trace. Because it is W3C-shaped, an extension
can forward it in a `traceparent` header and stitch Ion's runs to the APIs and microservices they
call, giving one end-to-end trace from the originating prompt through every downstream hop. The
other three IDs answer different questions: `conversation_id` for the durable thread,
`session_id` for one client session, `run_id` for joining Ion's own two streams. Full table:
[`log-schema.md`](../observability/log-schema.md) § "Correlation-ID vocabulary".

---

## Per-component shipping guide

Each Ion component reaches the sink differently. The table summarizes the operator's
responsibility split; subsections give the detail.

| Component | Native shipping path | Operator-provided piece |
|---|---|---|
| Engine (workstation, headless, CI, Docker) | `logging.egressTargets` + `telemetry.targets` — ships itself | Endpoint config (sealed via enterprise layer) |
| Extensions | Ride the engine's egress (`component=extension` lines in the engine stream) | Nothing extra |

### Engine — headless, CI, and Docker deployments

The engine is the one component with a native downstream shipping path, and it covers both
streams:

- **Operational log egress**: `logging.egressTargets` (`"http"` and/or `"otel"`). Every log
  line — including extension lines — is buffered off the hot path and flushed in batches to
  the configured endpoint, in addition to the local file. Full field reference:
  [`consuming-logs.md` § Option 3](../observability/consuming-logs.md#option-3--programmable-egress-no-ion-provided-stack-required).
- **Telemetry egress**: `telemetry.targets` (`"http"`, `"otel"`, `"file"`). Full reference:
  [`telemetry.md`](telemetry.md).

For a headless or CI engine, this means **no collection agent is needed at all**. The engine
config is the whole story:

```json
{
  "logging": {
    "egressTargets": ["otel"],
    "egressOtel": {
      "endpoint": "https://ingest.corp.example.com:4318",
      "headers": { "x-api-key": "fleet-ingest-key" },
      "serviceName": "ion-engine-ci"
    }
  },
  "telemetry": {
    "enabled": true,
    "targets": ["otel"],
    "otel": {
      "enabled": true,
      "endpoint": "https://ingest.corp.example.com:4318",
      "protocol": "http",
      "serviceName": "ion-engine-ci"
    }
  }
}
```

**Docker sidecar variant.** A containerized engine can alternatively (or additionally) be
collected file-side: mount the engine's `~/.ion` directory as a shared volume and run a tailer
sidecar (Alloy, Vector, Fluent Bit) against the JSONL files. This is useful when the container
platform already standardizes on sidecar collection, or when you want the local files shipped
verbatim rather than through the egress wire shape:

```yaml
services:
  engine:
    image: ion-engine:latest
    volumes:
      - ion-home:/root/.ion

  log-shipper:
    image: grafana/alloy:latest
    volumes:
      - ion-home:/ion-logs:ro
      - ./alloy-config.alloy:/etc/alloy/config.alloy:ro
    command: ["run", "/etc/alloy/config.alloy"]

volumes:
  ion-home:
```

The tailer config is the same shape as the reference stack's
[`alloy-config.alloy`](../observability/alloy-config.alloy) with the write target pointed at
the organizational endpoint instead of the local Loki. Rotation is tailer-safe by design:
Ion files rotate by rename. A tailer must support `.1` archive handoff or ship the live file before the configured archive window expires.

## Enterprise-sealed egress

Collection that users can turn off is not fleet collection. Both engine streams are sealable
at the enterprise layer ([`sealed-config.md`](sealed-config.md)): when the enterprise config
sets `logging.egressTargets`, the egress fields are enforced after the config merge and lower
layers cannot disable shipping; when it sets `telemetry`, the telemetry config replaces lower
layers and `enabled: true` cannot be turned off.

```json
{
  "enterprise": {
    "logging": {
      "egressTargets": ["otel"],
      "egressOtel": {
        "endpoint": "https://ingest.corp.example.com:4318",
        "serviceName": "ion-engine"
      }
    },
    "telemetry": {
      "enabled": true,
      "targets": ["otel"],
      "privacyLevel": "standard",
      "otel": {
        "enabled": true,
        "endpoint": "https://ingest.corp.example.com:4318",
        "protocol": "http",
        "serviceName": "ion-engine"
      }
    }
  }
}
```

Deploy this through the platform-native MDM channel ([`mdm.md`](mdm.md)) and every managed
engine ships both streams to the organizational endpoint from first launch. Sealing is
scoped: only the egress fields are enforced; local-file settings (format, rotation,
directory) stay user-controlled, and the local JSONL files keep being written regardless of
egress — local diagnostics never degrade because central collection is on.

---

## Tutorial: self-hosted collection on Kubernetes

This is the recommended public default: a self-hosted Loki/Grafana/Alloy stack inside your own
cluster. It is the fleet-scale version of the local reference stack
([`docs/observability/README.md`](../observability/README.md)) — same components, same label
policy, same dashboards, but the ingestion endpoint is a cluster service reachable by the
fleet. Organizations on managed cloud infrastructure may prefer the event-bus variant instead
(see the [managed-cloud example](#example-a-managed-cloud-event-bus-deployment) for a fully worked one).

The walkthrough assumes `kubectl` and `helm` against a cluster you control, and a DNS name
(`ingest.corp.example.com`) you can point at the cluster's ingress.

### 1. Namespace and Loki

```bash
kubectl create namespace ion-observability

helm repo add grafana https://grafana.github.io/helm-charts
helm repo update

helm install loki grafana/loki \
  --namespace ion-observability \
  --set deploymentMode=SingleBinary \
  --set loki.commonConfig.replication_factor=1 \
  --set loki.storage.type=filesystem \
  --set loki.auth_enabled=false \
  --set singleBinary.persistence.size=100Gi \
  --set loki.limits_config.retention_period=2160h \
  --set loki.compactor.retention_enabled=true \
  --set loki.compactor.delete_request_store=filesystem
```

Two deliberate choices here, both explained in
[`consuming-logs.md` § Retention and storage sizing](../observability/consuming-logs.md#retention-and-storage-sizing):

- **Retention is on from day one.** Unlike the local development stack (which keeps
  everything), a fleet sink must bound its storage. `2160h` is 90 days — a sensible flat
  default for a self-hosted deployment; size the volume from the sizing heuristic in that
  section, scaled by fleet size.
- **Compactor enabled.** Loki only deletes when the compactor runs with retention enabled.

### 2. Grafana

```bash
helm install grafana grafana/grafana \
  --namespace ion-observability \
  --set persistence.enabled=true
```

Add Loki as a datasource (`http://loki.ion-observability:3100`) and import the Ion dashboard
packs from [`docs/observability/grafana/`](../observability/README.md#dashboard-story-packs) —
they bind to the canonical schema, so they work unmodified against fleet data. The only
difference from the local stack is cardinality: panels that were single-machine become
fleet-wide, and the install (`service_instance_id`) and device (`host_name`) become the natural
drill-down dimensions.

### 3. Alloy — the ingestion endpoint

Alloy plays a different role here than in the local stack: instead of tailing local files, it
**is the network ingestion endpoint** — it receives OTLP/HTTP from every engine's egress and
forwards to Loki.

The `ion_otlp_unwrap` stage is what makes the Ion dashboards work on this Loki. It indexes each
OTLP record under the same names the local stack uses
([`log-schema.md` § "Names in Loki"](../observability/log-schema.md#names-in-loki)), so one set of
dashboards reads both:

- **Stream labels**: `service_name` (`service.name`), `event_name` (the `event.name` attribute,
  telemetry events only), `level` (`severityText`, operational lines only), `tag`, `host_name`
  (`host.name`, `.local` trimmed), and `user`.
- **Structured metadata**: `trace_id` and `span_id` (the LogRecord `traceId` and `spanId`),
  `service_instance_id` and `service_version` (the resource), and a telemetry event's payload
  and context keys (`model`, `run_cost_usd`, `context_conversation_id`, ...).
- **The stored line** is the record's body: the Ion JSON line itself, so a dashboard's `| json`
  stage finds `msg`, `fields`, and `payload` where the local stack puts them.

The Loki exporter's own labels (`exporter`, `job`, `instance`, `level`) are dropped first. Without
this stage every record lands under those labels alone, and every dashboard panel is empty.

```alloy
// alloy-fleet-config.alloy — receive OTLP from the fleet, write to Loki.

otelcol.receiver.otlp "fleet" {
  http {
    endpoint = "0.0.0.0:4318"
  }
  output {
    logs = [otelcol.processor.batch.default.input]
  }
}

otelcol.processor.batch "default" {
  output {
    logs = [otelcol.exporter.loki.default.input]
  }
}

// Each OTLP log record becomes one Loki entry whose line is a JSON envelope:
// body, traceid, spanid, severity, attributes, resources.
otelcol.exporter.loki "default" {
  forward_to = [loki.process.ion_otlp_unwrap.receiver]
}

// Index each record under the same names the local stack uses
// (log-schema.md § "Names in Loki"), then store the record's own JSON as the
// line so dashboard `| json` stages read the same fields on both paths.
loki.process "ion_otlp_unwrap" {
  // The exporter labels every entry exporter, job, instance, and level. None
  // is an Ion name, and a telemetry event has no level, so all four go.
  stage.label_drop {
    values = ["exporter", "job", "instance", "level"]
  }

  stage.json {
    expressions = {
      body                      = "body",
      severity                  = "severity",
      trace_id                  = "traceid",
      span_id                   = "spanid",
      service_name              = "resources.\"service.name\"",
      otlp_host_name            = "resources.\"host.name\"",
      service_instance_id       = "resources.\"service.instance.id\"",
      service_version           = "resources.\"service.version\"",
      event_name                = "attributes.\"event.name\"",
      tag                       = "attributes.tag",
      user                      = "attributes.user",
      model                     = "attributes.model",
      tool                      = "attributes.tool",
      stop_reason               = "attributes.stop_reason",
      duration_ms               = "attributes.duration_ms",
      run_cost_usd              = "attributes.run_cost_usd",
      agg_cost_usd              = "attributes.agg_cost_usd",
      dispatch_depth            = "attributes.dispatch_depth",
      num_turns                 = "attributes.num_turns",
      input_tokens              = "attributes.input_tokens",
      output_tokens             = "attributes.output_tokens",
      cache_read_tokens         = "attributes.cache_read_tokens",
      cache_creation_tokens     = "attributes.cache_creation_tokens",
      error                     = "attributes.error",
      schema_version            = "attributes.schema_version",
      context_conversation_id   = "attributes.context_conversation_id",
      context_session_id        = "attributes.context_session_id",
      context_extension         = "attributes.context_extension",
      context_extension_version = "attributes.context_extension_version",
    }
  }

  // level is an operational line's severity. A telemetry event has none.
  stage.template {
    source   = "level"
    template = "{{ if not .event_name }}{{ .severity }}{{ end }}"
  }

  // One machine has one name: `.local` is trimmed, as the local stack does.
  stage.template {
    source   = "host_name"
    template = "{{ if .otlp_host_name }}{{ TrimSuffix .otlp_host_name \".local\" }}{{ end }}"
  }

  // Only low-cardinality values become labels. An operational line has no
  // event_name; a telemetry event has no level or tag.
  stage.labels {
    values = {
      service_name = "",
      event_name   = "",
      level        = "",
      tag          = "",
      host_name    = "",
      user         = "",
    }
  }

  stage.structured_metadata {
    values = {
      trace_id                  = "",
      span_id                   = "",
      service_instance_id       = "",
      service_version           = "",
      model                     = "",
      tool                      = "",
      stop_reason               = "",
      duration_ms               = "",
      run_cost_usd              = "",
      agg_cost_usd              = "",
      dispatch_depth            = "",
      num_turns                 = "",
      input_tokens              = "",
      output_tokens             = "",
      cache_read_tokens         = "",
      cache_creation_tokens     = "",
      error                     = "",
      schema_version            = "",
      context_conversation_id   = "",
      context_session_id        = "",
      context_extension         = "",
      context_extension_version = "",
    }
  }

  stage.output {
    source = "body"
  }

  forward_to = [loki.write.local.receiver]
}

// Loki push receiver for the workstation/sidecar tailers (they speak
// the Loki push API rather than OTLP).
loki.source.api "tailers" {
  http {
    listen_address = "0.0.0.0"
    listen_port    = 3500
  }
  forward_to = [loki.write.local.receiver]
}

loki.write "local" {
  endpoint {
    url = "http://loki.ion-observability:3100/loki/api/v1/push"
  }
}
```

```bash
helm install alloy grafana/alloy \
  --namespace ion-observability \
  --set-file alloy.configMap.content=alloy-fleet-config.alloy
```

Expose port 4318 (OTLP) and 3500 (Loki push) through your ingress with TLS at
`ingest.corp.example.com`. Authentication is your ingress's job — an API-key header validated
at the ingress (matching the `headers` field in the engine's egress config) is the minimal
viable gate.

### 4. Wire the components

- **Engines**: deploy the [enterprise-sealed egress config](#enterprise-sealed-egress) with
  `egressOtel.endpoint` (and `telemetry.otel.endpoint`) set to
  `https://ingest.corp.example.com:4318`. Every managed engine now ships both streams.
- **Headless/CI engines**: egress config only, no agent.

### 5. Verify end to end

From Grafana → Explore → Loki, confirm each component is arriving:

```logql
# Every component reporting, by volume
sum by (service_name) (count_over_time({service_name=~".+", event_name=""}[15m]))

# One machine's telemetry
{event_name=~".+", host_name="some-workstation"}

# Cross-surface forensics still works at fleet scale — same join keys
{service_name=~".+", event_name=""} | json | conversation_id = "1780093348767-c1c03e998388"

# One prompt across every surface, from structured metadata (no parser)
{service_name=~".+"} | trace_id = "0af7651916cd43dd8448eb211c80319c"
```

If `{event_name=~".+"}` returns nothing while engines are shipping, the collector is not
promoting labels: compare its config with the one above.

The correlation model from
[`consuming-logs.md`](../observability/consuming-logs.md#correlation-model) carries over
unchanged: the join keys are in the lines, not in any particular stack.

---

## Example: a managed-cloud event-bus deployment

Everything above is topology-neutral. This section is one concrete worked example: how an
enterprise deploying Ion fleet-wide can realize the same single-sink contract on
managed Azure infrastructure. It is included because a fully specified enterprise binding
makes the abstract architecture legible — and because it exercises the decoupling invariant
harder than the self-hosted default does.

In this example, observability data flows through five layers in a strict pipeline. Each layer has a bounded responsibility, its own retention tier, and a hard
interface to the next.

### Layer 1 — Event Hub (ingestion intake)

Azure Event Hubs is the single sink. Every Ion engine in the fleet emits to one
configurable Event Hub endpoint, injected through the MDM configuration layer — the same delivery channel as [`mdm.md`](mdm.md), carrying the sealed egress
config. The engine reaches it directly over native AMQP via the `eventhub` target (see
[`telemetry.md`](telemetry.md) § "Event Hub target") — no HTTPS-fronted intermediary is
required, since Event Hubs' own ingest protocol is AMQP. Event Hub is a transit buffer, not
a store: data resides there on the order of days (an event-bus retention window, roughly one
to seven) while downstream consumers read the stream independently.

This layer *is* the decoupling invariant made physical: the engine knows one
endpoint and nothing else. Multiple consumers — the hot-path writer, the analytical pipeline —
subscribe without the engine being aware of them, and the operator can replace any downstream layer
without touching a single fleet device. It is the same single-sink contract as the
self-hosted tutorial, with fan-out as the first-class reason to choose an event bus over a
direct collector.

### Layer 2 — Cosmos DB (hot path)

The raw conversation stream lands in Cosmos DB: full fidelity, conversation-keyed,
user-keyed. This is Tier 1 of a tiered conversation store — **30-day
rolling retention** from last conversation activity, with the clock resetting on each new
event. During the active window the layer serves conversation replay, session continuity, and
incident reconstruction against the actual record.

At the 30-day inactivity threshold, the tiering pipeline takes over: the transcript passes
through LLM-driven sanitization (Tier 2 — credentials and secrets identified and redacted by
a model, not by regex, precisely so the archived record is neither leaky nor lossy) and the
sanitized transcript lands in the long-term archive (Tier 3). Sanitization happens at the
warm-to-cold boundary, never at write time: the active-window record is the authentic
conversation, which is what makes it forensically usable.

### Layer 3 — Log Analytics (analytical store)

The same event stream lands, via the Event Hub pipeline, in an Azure Log Analytics workspace —
the KQL-queryable, source-of-truth fleet database. Retention is **365 days hot**, supporting trend analysis across
quarters and year-over-year fleet comparisons. Direct KQL access is restricted to
administrative identities; every other consumer reaches this data through a managed
integration.

Log Analytics also hosts the platform's self-monitoring: scheduled KQL queries computing cost-anomaly detection against rolling
per-user baselines, conversation lifecycle health (are transcripts moving through the
storage tiers on schedule?), agent-pack invocation success rates, and fleet adoption
metrics.

### Layer 3 archive — the cold/audit tier

At the 365-day boundary, telemetry exports to structured Azure Blob archive; sanitized
conversation transcripts follow their own multi-stage progression (warm archive on the order
of a year, then cold archive on the order of **seven years**, then re-evaluation). Nothing in the conversation record is truncated, sampled,
or rolled up: complete records are the point. This tier is what satisfies an
auditability requirement — the requirement that any incident, however old, is
reconstructable: which user, which conversation, which content the agent processed, which
tool calls with which inputs and outputs.

### Layer 4 — Application Insights (investigation)

Application Insights is a consumption layer over the same Log Analytics workspace — request
maps, dependency maps, per-request traces — used for "something is wrong, why?"
investigation. It keeps no store of its own: logs and traces live in the linked Log Analytics
workspace. When Application Insights is created with OpenTelemetry (OTLP) support, it also
creates and links an **Azure Monitor workspace**, and OTLP metrics are stored there, not in
Log Analytics. The Azure Monitor workspace is a hosted Prometheus store queried with PromQL
([Ingest OTLP data into Azure Monitor](https://learn.microsoft.com/en-us/azure/azure-monitor/containers/opentelemetry-protocol-ingestion)).
One asymmetry matters: **platform-hosted
services** (hosted MCP servers, functions, workflow apps) instrument through the App
Insights/OpenTelemetry SDK directly, not through Event Hub. The event-bus
intake is for the fleet's Ion devices; centrally managed Azure services use the platform-native
instrumentation path.

### Layer 5 — Grafana (fleet dashboard)

Grafana queries Log Analytics (through the Azure Monitor data source, KQL) and, for OTLP
metrics, the Azure Monitor workspace (through a Prometheus data source, PromQL). One dashboard
can mix both. It presents the operational heartbeat: fleet activity,
error sources, per-user turn latency, per-user cost, dispatch topology, adoption. Any
fleet-level metric slices down to an individual user — which is only possible because every
event is stamped with the authenticated user identity at emission (see the
[progression roadmap](#the-progression-roadmap) below for where that stamp comes from).

### The metrics path — System Metrics

Metrics take their own path, beside the event bus rather than through it. Each engine exports
its System Metrics (host load and its own processes) as OTLP metrics
(`telemetry.otel.metrics`) to the OpenTelemetry Collector, with the operator's Entra token. The
Collector checks that token, converts to delta temporality, and sends to the Application
Insights **metrics** ingestion address with its own workload identity. They are stored in the
Azure Monitor workspace linked to Application Insights, and Grafana reads them through a
Prometheus data source with PromQL. Configuration: [Telemetry § Sending System Metrics to Application
Insights](telemetry.md#sending-system-metrics-to-application-insights); the map of every output:
[Signals and where they go](../observability/README.md#signals-and-where-they-go).

### Tiering summary

| Tier | Layer | Retention | Contents |
|---|---|---|---|
| Transit | Event Hub | ~1–7 days | In-flight event stream (buffer, not storage) |
| Hot | Cosmos DB | 30 days rolling | Raw full-fidelity conversation stream (Tier 1) |
| Warm | Log Analytics | 365 days | Fleet-queryable analytical store |
| Cold | Blob archive | ~7 years | Sanitized transcripts + exported telemetry; the audit tier (Tier 3) |
| Metrics | Azure Monitor workspace | Workspace retention | OTLP System Metrics (host and engine process load), queried with PromQL |
| *Contrast: home/self-hosted default* | *Single Loki tier* | *90 days flat* | *Everything, one store, one retention knob (the tutorial above)* |

The contrast row is the point of the whole document: the same engines, the same schemas, the
same sealed egress config shape serve both a flat single-tier home deployment and a
five-layer enterprise pipeline. Only the endpoint and the downstream opinion change.

### Layer-boundary invariants

These are hard rules in this topology, not implementation
preferences. Violations couple components that must stay independent:

- **The engine writes to Event Hub only.** Never to Cosmos DB, Log Analytics, or any
  visualization layer directly.
- **Grafana queries Log Analytics only.** Never Cosmos DB, never the raw Event Hub stream.
- **Application Insights consumes from Log Analytics.** It does not receive events directly.
- **Hosted services emit via the App Insights/OTel SDK,** not through the Event Hub intake.

---

## The progression roadmap

Central collection is a staged capability, and the stages have a strict dependency spine:

**standardized + validated logging → authenticated user stamping (OIDC) → enterprise
ingestion infrastructure → fleet auditability.**

1. **Standardized, validated logging (done — this initiative).** Every surface emits the
   canonical schema; the telemetry stream carries its versioned contract
   ([ADR-019](../architecture/adr/019-logging-architecture-and-standards.md)); egress ships
   both streams; enterprise config seals it on; machine-checked gates (`check-logging`, the
   telemetry contract tests) keep it true. Nothing downstream is worth building until the
   lines themselves are trustworthy.
2. **Enterprise OIDC authentication populates the user-identity carrier (done).** The
   telemetry format carries an optional `user` field in its expanded event shape so identity
   could attach later *without a schema break* — and it now does. The **engine owns the
   OIDC identity**: `auth.identityProvider` + `auth.oauth.<provider>` in `engine.json`
   configure the app registration; the engine runs the PKCE login (a UI consumer only opens
   the authorization URL — `oidc_begin_login` / `oidc_identity` / `oidc_logout` on the
   wire), persists the grant encrypted, silently refreshes, and mints per-scope access
   tokens. Attribution restamps on every login/logout transition, so every event carries
   the real authenticated user. Egress authenticates per flush: the engine's forwarder mints a fresh token
   for `logging.egressTokenScope`; a client shipping its own share pulls ephemeral tokens
   via the `oidc_token` command (the refresh token never leaves the engine). Shipping
   responsibility itself is a configurable matrix — `logging.egressShipSources` (engine's
   share) and `logging.egressClientShipSources` (the managing client's share) decide which
   surface ships which of `engine` / `desktop` / `ios` / `telemetry`, generalizing the
   legacy `egressManagedByClient` boolean (still honored when the matrix is absent).
3. **Build the enterprise ingestion infrastructure.** The five-layer stack in the
   [managed-cloud example](#example-a-managed-cloud-event-bus-deployment) is one way: Event Hub intake, Cosmos DB hot path, Log
   Analytics, the archive tier, App Insights, and Grafana, with per-layer retention tiering.
4. **Ship work-device Ion logs into it.** Point the fleet's sealed egress config at
   the central intake. With identity attached (stage 2) and ingestion central (stage 3), the
   log contract becomes the audit trail — who ran what, where, on which build, at what cost .

Each stage is useless without the one before it: infrastructure ingesting unattributed events
fails the attribution mandate; attribution stamped onto unstandardized lines fails
validation; and fleet auditability is exactly the composition of all three.
