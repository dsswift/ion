/**
 * The IonAPI contextBridge surface type, extracted from preload/index.ts to
 * keep that file under the 600-line cap. index.ts implements this interface and
 * re-exports it (renderer/env.d.ts imports it from ../preload/index).
 */
import type { FileAttachment } from "@ion/shared/types";

import type { StartupReport } from "@ion/shared/startup-state";

export interface IonCoreApi {
  /** Report a factual bootstrap phase to the main-process splash coordinator. */
  startupReport(report: StartupReport): void;
  // ─── Request-response (renderer → main) ───
  start(): Promise<{
    version: string;
    auth: { email?: string; subscriptionType?: string; authMethod?: string };
    mcpServers: string[];
    projectPath: string;
    homePath: string;
  }>;
  selectDirectory(): Promise<string | null>;
  selectExtensionFiles(): Promise<string[] | null>;
  openExternal(url: string): Promise<boolean>;
  /** Main-process-cached site favicon as a data: URL (null = unavailable;
   * renderer falls back to its Globe glyph). */
  getFavicon(host: string): Promise<string | null>;
  /** Reveal a directory in the OS file manager. */
  revealPath(path: string): Promise<boolean>;
  /** Listen on this machine for an OAuth redirect; returns the redirect URI to sign in with. */
  oauthCallbackListen(): Promise<{ id: string; redirectUri: string }>;
  /** Resolves with the full address the browser landed on. */
  oauthCallbackAwait(id: string): Promise<string>;
  /** Stop waiting for a redirect. */
  oauthCallbackCancel(id: string): Promise<void>;

  attachFiles(): Promise<FileAttachment[] | null>;
  takeScreenshot(): Promise<FileAttachment | null>;
  /**
   * Copy PNG bytes to the OS clipboard. Resolves false on any refusal (wrong
   * type, oversize, bad signature, undecodable) so the caller can tell the
   * user rather than leaving them to discover an empty paste.
   */
  copyPngToClipboard(png: ArrayBuffer): Promise<boolean>;
  listFonts(): Promise<string[]>;

}
