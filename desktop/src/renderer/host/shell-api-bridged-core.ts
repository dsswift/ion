/**
 * Bridged `host.shell` verbs, core domain: every one is served by a
 * `studio_action` or `studio_event` on every host (`browser-shell-bridge.ts`),
 * so the Electron preload no longer carries it. Moved verbatim from the
 * preload's `ionapi-core.ts` (spec 12: `IonAPI` shrinks toward the natives and the
 * host relay, `ShellApi` keeps the full surface).
 */
import type { FileAttachment, SessionLoadMessage, DiscoveredCommand, NewConversationDefaultsPolicy } from "@ion/shared/types";
import type { CustomThemeForRenderer } from "@ion/shared/theme-pack-types";
import type { ProjectStudioConfigSnapshot } from "@ion/shared/project-studio-config";
import type { TextSearchRequest, TextSearchResult } from "@ion/shared/text-search";
import type { FileLinkTarget } from "@ion/shared/file-link";

export interface BridgedCoreShell {
  /** Fetch the enterprise new-tab policy from the engine. Returns null when no enterprise config is active. */
  getEnterprisePolicy(): Promise<NewConversationDefaultsPolicy | null>;
  /** Custom theme packs installed on disk (desktop components, resolved with inline asset data URLs). */
  listCustomThemes(): Promise<CustomThemeForRenderer[]>;
  /** A worktree was named (generated or renamed) on `environmentId`, whose disk the paths are on. */
  onWorktreeTitled(
    callback: (arg: {
      repoPath: string;
      worktreePath: string;
      title: string;
    }, environmentId: string) => void,
  ): () => void;
  /** A successful Land on `environmentId` sealed the worktree; owners lock existing review tabs. */
  onWorktreeLanded(
    callback: (arg: {
      repoPath: string;
      worktreePath: string;
      prunedBenchPaths: string[];
    }, environmentId: string) => void,
  ): () => void;
  /**
   * Describe `path` as an attachment. `tabId` names the conversation it is for,
   * so the call reaches the Environment whose filesystem holds the path.
   */
  attachFileByPath(tabId: string, path: string): Promise<FileAttachment | null>;
  /** The project's committed `.ion/studio.json`, read on the Environment that hosts `directory`. */
  getProjectStudioConfig(directory: string): Promise<ProjectStudioConfigSnapshot>;
  /** Approve exactly the Project Quick Tool list identified by `toolsHash`. */
  trustProjectQuickTools(directory: string, toolsHash: string): Promise<{ trusted: boolean; reason?: string }>;
  onProjectStudioConfigChanged(callback: (payload: { root: string }) => void): () => void;
  /** Project files matching `query`, relative to `directory`, best first. */
  searchFiles(directory: string, query: string, limit?: number): Promise<{ files: string[]; source: 'git' | 'walk'; truncated: boolean; error?: string }>;
  /** Workspace Search: lines holding literal `query` under the given roots, grouped by file. */
  searchText(request: TextSearchRequest): Promise<TextSearchResult>;
  /**
   * Stores bytes the client holds (a browser drop, an oversized paste) on the
   * Environment that owns conversation `tabId` and returns them as an
   * attachment. `base64` is the content.
   */
  saveAttachmentData(tabId: string, name: string, base64: string): Promise<FileAttachment | null>;
  /**
   * The bytes of `filePath` on the Environment that owns conversation `tabId`,
   * as base64. For a client that must hand a remote file to its own operating
   * system. Null when the file is missing or too large.
   */
  readFileData(tabId: string, filePath: string): Promise<{ base64: string; size: number } | null>;
  /**
   * Resolve a clicked path on the Environment that owns conversation `tabId`:
   * `~/` against that machine's home, a relative path against `cwd`. Reports
   * whether it exists there, whether it is a directory, and its size.
   */
  resolveFileLink(tabId: string, path: string, cwd: string): Promise<FileLinkTarget>;
  /**
   * Main announces the resource catalog changed outside a live delta (e.g.
   * persisted charts republished on session subscribe). Consumers re-read the
   * catalog rather than waiting for the next producer action.
   */
  onResourceCatalogChanged(callback: () => void): () => void;
  /**
   * An interactive sign-in page the host is asked to show. Electron opens it
   * itself through `shell.openExternal` and never broadcasts, so this fires
   * only for a client whose Environment is a remote server.
   */
  onOpenAuthUrl(callback: (payload: { url: string }) => void): () => void;
  loadSession(
    sessionId: string,
    projectPath?: string,
    encodedDir?: string,
  ): Promise<SessionLoadMessage[]>;
  conversationExists(sessionId: string): Promise<boolean>;
  readPlan(
    filePath: string,
  ): Promise<{ content: string | null; fileName: string | null }>;
  readImageDataUrl(filePath: string): Promise<{ dataUrl: string | null }>;
  discoverCommands(projectPath: string): Promise<DiscoveredCommand[]>;
  terminalCreate(key: string, cwd: string): Promise<void>;
  terminalWrite(key: string, data: string): void;
  terminalResize(key: string, cols: number, rows: number): void;
  terminalDestroy(key: string): Promise<void>;
  /** Attach protocol (D2): history snapshot + lifecycle; optional respawn. */
  terminalAttach(
    key: string,
    opts?: { restartIfNotRunning?: boolean; cwd?: string },
  ): Promise<{
    history: string;
    running: boolean;
    exitCode: number | null;
    cwd: string;
    cwdFellBack: boolean;
    /** Why the last spawn produced no PTY (never started), or null. */
    startError: string | null;
  }>;
  terminalActiveTabs(): Promise<string[]>;
  terminalActivitySnapshot(): Promise<import('@ion/shared/terminal-activity').TerminalActivity[]>;
  onTerminalActivity(callback: (activity: import('@ion/shared/terminal-activity').TerminalActivity) => void): () => void;
  onTerminalData(callback: (key: string, data: string) => void): () => void;
  onTerminalExit(callback: (key: string, exitCode: number) => void): () => void;
  /** The terminal's processes were stopped and a fresh shell started under the same key; `startError` is set when it failed to start. */
  onTerminalRestarted(callback: (key: string, startError: string | null) => void): () => void;
  executeBash(
    id: string,
    command: string,
    cwd: string,
  ): Promise<{ stdout: string; stderr: string; exitCode: number | null }>;
  cancelBash(id: string): void;
  loadSettings(): Promise<Record<string, any>>;
  saveSettings(data: Record<string, any>): Promise<void>;
  getConversation(
    conversationId: string,
    offset?: number,
    limit?: number,
  ): Promise<{ messages: any[]; total: number; hasMore: boolean }>;
  deleteStoredConversations(sessionIds: string[]): Promise<{ deleted: number }>;
  loadChainHistory(sessionIds: string[]): Promise<SessionLoadMessage[]>;
  loadConversationTranscript(tabId: string): Promise<string>;
}
