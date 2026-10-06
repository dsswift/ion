/**
 * server-config-browser-stub — the Studio renderer's build-time replacement
 * for `server/src/config/server-config.ts`.
 *
 * The real file loads and validates `<dir>/server.json` (`fs.existsSync`/
 * `readFileSync`, `os.hostname`, `path.join`) and resolves every
 * `secretstore:` reference it contains via `./secret-ref`. It is reachable
 * from the renderer transitively through `config/current.ts`, which calls
 * `defaultServerConfig()` at module scope to seed its process-wide `current`
 * singleton (`sessionStore.ts` → ... → `config/current.ts` →
 * `server-config.ts`). `server.json` is the SERVER's own boot configuration
 * per spec 17 ("server owns the store, Studio renders") — the renderer never
 * loads or holds it; it only needs a same-shaped default to satisfy
 * `current.ts`'s module-scope initializer.
 *
 * `defaultServerConfig()` mirrors the real defaults field-for-field but uses
 * a fixed label instead of `os.hostname()` (unavailable in a browser tab —
 * and this default is never actually read by the renderer, since the real
 * label lives on the server side of the Studio wire). `unownedTabsDefault`
 * is pure logic with no Node dependency, so it is reproduced verbatim.
 * `loadServerConfig` throws: an accidental renderer-side disk load attempt
 * fails loudly instead of silently returning defaults. Wired in via
 * `renderer-server-stubs.ts`, keyed on server-config.ts's resolved absolute
 * path so every relative import of it resolves here.
 */
import type { Scope } from "@ion/shared/studio-wire/types";

export interface ServerOidcConfig {
  issuer: string;
  audience: string;
  scope: string;
  clientId: string;
  rolesToScopes: Record<string, Scope[]>;
  defaultScopes: Scope[];
  allowedSubjects: string[];
  clientSecret: string;
}

export interface ServerRelayConfig {
  url: string;
  psk: string;
}

export interface ServerListenConfig {
  local: boolean;
  lan: boolean;
  tcp: { host: string; port: number };
}

export interface ServerPairingConfig {
  defaultScopes: Scope[];
}

export interface ServerPolicyConfig {
  authPolicy: string;
  actionInterceptor: string;
  snapshotProjector: string;
}

export interface ServerTenancyConfig {
  unownedTabs?: "visible" | "hidden";
  mode?: "isolated" | "shared";
}

export interface ServerGitCredentialConfig {
  subject: string;
  host: string;
  kind: "ssh" | "https-token";
  privateKey?: string;
  publicKey?: string;
  token?: string;
  username?: string;
}

export interface ServerGitExchangeAdoConfig {
  enabled: boolean;
}

export interface ServerGitExchangeGitlabConfig {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
}

export interface ServerGitExchangeGithubConfig {
  clientId: string;
  clientSecret: string;
}

export interface ServerGitConfig {
  credentials: ServerGitCredentialConfig[];
  hostCredentials: boolean;
  hosts: Array<{ host: string; provider: "github" | "gitlab" | "azure-devops"; apiBaseUrl?: string }>;
  publicOrigin: string;
  exchange: {
    ado: ServerGitExchangeAdoConfig;
    gitlab: ServerGitExchangeGitlabConfig | null;
    github: ServerGitExchangeGithubConfig | null;
  };
}

export interface ServerConfig {
  label: string;
  listen: ServerListenConfig;
  oidc: ServerOidcConfig | null;
  relays: ServerRelayConfig[];
  pairing: ServerPairingConfig;
  engine: { minVersion: string };
  web: { enabled: boolean };
  policy: ServerPolicyConfig;
  tenancy: ServerTenancyConfig;
  git: ServerGitConfig;
  logLevel: "TRACE" | "DEBUG" | "INFO" | "WARN" | "ERROR";
}

const DEFAULT_PAIRING_SCOPES: readonly Scope[] = [
  "conversations:read",
  "conversations:operate",
  "terminal:operate",
  "git:write",
];

export function defaultServerConfig(): ServerConfig {
  return {
    label: "Ion Studio Server",
    listen: { local: true, lan: true, tcp: { host: "0.0.0.0", port: 7331 } },
    oidc: null,
    relays: [],
    pairing: { defaultScopes: [...DEFAULT_PAIRING_SCOPES] },
    engine: { minVersion: "0.0.0" },
    web: { enabled: false },
    policy: { authPolicy: "default", actionInterceptor: "default", snapshotProjector: "default" },
    tenancy: {},
    git: { credentials: [], hostCredentials: true, hosts: [], publicOrigin: "", exchange: { ado: { enabled: false }, gitlab: null, github: null } },
    logLevel: "DEBUG",
  };
}

export function unownedTabsDefault(oidc: ServerOidcConfig | null): "visible" | "hidden" {
  return oidc !== null ? "hidden" : "visible";
}

export function loadServerConfig(_dir: string): ServerConfig {
  throw new Error(
    "loadServerConfig() cannot run in the Studio renderer — server.json is server-owned; route through a FORWARDED store action instead.",
  );
}
