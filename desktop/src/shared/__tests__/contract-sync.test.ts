/**
 * Cross-Language Contract Sync Tests
 *
 * Validates that TypeScript type definitions stay in sync with the Go engine's
 * contract manifest (engine/internal/types/testdata/contracts.json).
 *
 * The Go manifest is auto-generated via reflection. This test maintains an
 * explicit field-name map for each TS type (since TS types are erased at
 * runtime) and asserts bidirectional coverage against the Go manifest. The
 * maps themselves live in contract-sync-fields.ts, split out to keep this
 * file under the 600-line cap.
 *
 * When you update a TS type, update the corresponding map in
 * contract-sync-fields.ts in the same PR. If you forget, CI fails.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { TS_NORMALIZED_EVENTS, TS_SHARED_TYPES } from "./contract-sync-fields";

// ─── Load Go manifest ───

interface ContractManifest {
  normalizedEvents: Record<string, string[] | null>;
  engineEvent: string[];
  sharedTypes: Record<string, string[]>;
}

const manifestPath = resolve(
  __dirname,
  "../../../../engine/internal/types/testdata/contracts.json",
);
const manifest: ContractManifest = JSON.parse(
  readFileSync(manifestPath, "utf-8"),
);

// ─── Tests ───

describe("Contract sync: NormalizedEvent variants", () => {
  it("every Go variant exists in TS map", () => {
    const missing: string[] = [];
    for (const variant of Object.keys(manifest.normalizedEvents)) {
      if (!(variant in TS_NORMALIZED_EVENTS)) {
        missing.push(variant);
      }
    }
    expect(
      missing,
      `Go NormalizedEvent variants missing from TS map: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("every TS variant exists in Go manifest", () => {
    const extra: string[] = [];
    for (const variant of Object.keys(TS_NORMALIZED_EVENTS)) {
      if (!(variant in manifest.normalizedEvents)) {
        extra.push(variant);
      }
    }
    expect(
      extra,
      `TS NormalizedEvent variants not present in Go manifest: ${extra.join(", ")}`,
    ).toEqual([]);
  });

  it("fields match for each variant", () => {
    const mismatches: string[] = [];
    for (const [variant, goFields] of Object.entries(
      manifest.normalizedEvents,
    )) {
      const tsFields = TS_NORMALIZED_EVENTS[variant];
      if (!tsFields) continue; // covered by variant-presence test

      const goSorted = (goFields ?? []).slice().sort();
      const tsSorted = tsFields.slice().sort();

      if (JSON.stringify(goSorted) !== JSON.stringify(tsSorted)) {
        const goOnly = goSorted.filter((f) => !tsSorted.includes(f));
        const tsOnly = tsSorted.filter((f) => !goSorted.includes(f));
        const parts: string[] = [];
        if (goOnly.length) parts.push(`Go-only: [${goOnly.join(", ")}]`);
        if (tsOnly.length) parts.push(`TS-only: [${tsOnly.join(", ")}]`);
        mismatches.push(`  ${variant}: ${parts.join("; ")}`);
      }
    }
    expect(
      mismatches,
      `NormalizedEvent field mismatches:\n${mismatches.join("\n")}`,
    ).toEqual([]);
  });
});

describe("Contract sync: SharedTypes", () => {
  it("every Go shared type exists in TS map", () => {
    const missing: string[] = [];
    for (const typeName of Object.keys(manifest.sharedTypes)) {
      if (!(typeName in TS_SHARED_TYPES)) {
        missing.push(typeName);
      }
    }
    expect(
      missing,
      `Go shared types missing from TS map: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("every TS shared type exists in Go manifest", () => {
    const extra: string[] = [];
    for (const typeName of Object.keys(TS_SHARED_TYPES)) {
      if (!(typeName in manifest.sharedTypes)) {
        extra.push(typeName);
      }
    }
    expect(
      extra,
      `TS shared types not present in Go manifest: ${extra.join(", ")}`,
    ).toEqual([]);
  });

  it("fields match for each shared type", () => {
    const mismatches: string[] = [];
    for (const [typeName, goFields] of Object.entries(manifest.sharedTypes)) {
      const tsFields = TS_SHARED_TYPES[typeName];
      if (!tsFields) continue;

      const goSorted = goFields.slice().sort();
      const tsSorted = tsFields.slice().sort();

      if (JSON.stringify(goSorted) !== JSON.stringify(tsSorted)) {
        const goOnly = goSorted.filter((f) => !tsSorted.includes(f));
        const tsOnly = tsSorted.filter((f) => !goSorted.includes(f));
        const parts: string[] = [];
        if (goOnly.length) parts.push(`Go-only: [${goOnly.join(", ")}]`);
        if (tsOnly.length) parts.push(`TS-only: [${tsOnly.join(", ")}]`);
        mismatches.push(`  ${typeName}: ${parts.join("; ")}`);
      }
    }
    expect(
      mismatches,
      `SharedType field mismatches:\n${mismatches.join("\n")}`,
    ).toEqual([]);
  });
});

// ─── EngineEvent dispatch fields ───
// The EngineEvent union (engine/internal/types/engine_event.go) carries all
// dispatch telemetry fields. This suite pins the fields consumed by
// dispatch_start / dispatch_end normalized events so drift between Go and
// TS/Swift is caught at PR time.

describe("Contract sync: EngineEvent dispatch fields", () => {
  // Fields that the engine emits on dispatch_start / dispatch_end events and
  // that the desktop (and iOS) decode. Any field absent from the Go manifest
  // means the engine stopped emitting it (breaking change); any field present
  // in the manifest but not in this set is a new Go field the desktop hasn't
  // yet adopted (tracked as a gap comment).
  const DISPATCH_FIELDS_CONSUMED: string[] = [
    "dispatchAgent",
    "dispatchConversationId",
    "dispatchCost",
    "dispatchDepth",
    "dispatchElapsed",
    "dispatchExitCode",
    "dispatchId",
    "dispatchInputTokens",
    "dispatchOutputTokens",
    "dispatchToolCount",
    "dispatchModel",
    "dispatchParentId",
    "dispatchSessionId",
    "dispatchTask",
  ];

  it("all consumed dispatch fields are present in the Go EngineEvent manifest", () => {
    const goFields = new Set(manifest.engineEvent);
    const missing = DISPATCH_FIELDS_CONSUMED.filter((f) => !goFields.has(f));
    expect(
      missing,
      `Go EngineEvent is missing dispatch fields consumed by desktop/iOS: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("the engine_oidc_identity requirement field is present in the Go EngineEvent manifest", () => {
    const goFields = new Set(manifest.engineEvent);
    expect(
      goFields.has("oidcRequired"),
      "Go EngineEvent is missing oidcRequired",
    ).toBe(true);
  });

  it("the engine_dispatch_lost payload field is present in the Go EngineEvent manifest", () => {
    // engine_dispatch_lost carries a nested DispatchLostPayload under the
    // `dispatchLost` key (mirrored in types-engine-event.ts). Its absence
    // from the manifest means the engine stopped emitting the loss event —
    // a breaking change for consumers that surface lost dispatches.
    const goFields = new Set(manifest.engineEvent);
    expect(
      goFields.has("dispatchLost"),
      "Go EngineEvent is missing the dispatchLost payload field",
    ).toBe(true);
  });
});
