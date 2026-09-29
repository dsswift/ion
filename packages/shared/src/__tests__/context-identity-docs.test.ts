import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(__dirname, "..", "..", "..", "..");

function read(relativePath: string): string {
  return readFileSync(join(REPO_ROOT, relativePath), "utf8");
}

const IDENTITY_FIELDS = [
  "kind",
  "provider",
  "subject",
  "username",
  "displayName",
  "attribution",
  "source",
  "claims",
];
const IDENTITY_REASONS = [
  "initial",
  "signed_in",
  "signed_out",
  "claims_changed",
  "verification_lost",
  "workload_ready",
];

describe("Context Identity documentation", () => {
  const typescriptGuide = read("docs/extensions/sdk-typescript.md");
  const goGuide = read("docs/extensions/sdk-go.md");
  const hooks = read("docs/hooks/reference.md");
  const protocol = read("docs/extensions/json-rpc-protocol.md");
  const manifest = read("docs/extensions/extension-json.md");
  const config = read("docs/configuration/engine-json.md");
  const machine = read("docs/deployment/machine-identity.md");

  it("keeps both SDK guides aligned on the identity contract", () => {
    for (const field of IDENTITY_FIELDS) {
      expect(typescriptGuide).toContain(field);
      expect(goGuide).toContain(field);
    }
    for (const reason of IDENTITY_REASONS) {
      expect(typescriptGuide).toContain(`\`${reason}\``);
      expect(goGuide).toContain(`\`${reason}\``);
      expect(hooks).toContain(`\`${reason}\``);
    }
    for (const guide of [typescriptGuide, goGuide]) {
      expect(guide).toContain("256 KiB");
      expect(guide).toContain("group");
      expect(guide).toContain("complete");
      expect(guide).toContain("snapshot");
    }
    expect(typescriptGuide).toContain("deregisterTool");
    expect(typescriptGuide).toContain("syncTools()");
    expect(goGuide).toContain("DeregisterTool");
    expect(goGuide).toContain("SyncTools");
  });

  it("documents the raw identity and dynamic tool wire shapes", () => {
    expect(protocol).toContain("_ctx.identity");
    expect(protocol).toContain("engine/fire_async");
    expect(protocol).toContain("_toolRegistry");
    expect(protocol).toContain("ext/tool_registry_snapshot");
    expect(protocol).toContain("accepted revision");
  });

  it("documents admission, migration, and workload readiness", () => {
    expect(manifest).toContain("identity.required");
    for (const value of ["operator", "workload", "any"]) {
      expect(manifest).toContain(`\`${value}\``);
    }
    expect(config).toContain("issuerUrl");
    expect(config).toContain("sign in once");
    expect(config).toContain("optional, a verification failure");
    expect(machine).toContain("No identity configuration is valid");
    expect(machine).toContain("before it binds the socket");
    expect(machine).toContain("GetCallerIdentity");
  });
});
