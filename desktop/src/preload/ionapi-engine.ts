/**
 * The IonAPI contextBridge surface type, extracted from preload/index.ts to
 * keep that file under the 600-line cap. index.ts implements this interface and
 * re-exports it (renderer/env.d.ts imports it from ../preload/index).
 */
import type { DeviceMetricsSample } from "@ion/shared/types-device-metrics";
import type { BuildNotice } from "@ion/shared/build-notice";

export interface IonEngineApi {
  fsSaveDialog(
    defaultPath?: string,
    defaultFileName?: string,
    filters?: Array<{ name: string; extensions: string[] }>,
  ): Promise<{ filePath: string | null; error?: string }>;
  fsRevealInFinder(targetPath: string): Promise<void>;
  fsOpenNative(targetPath: string): Promise<{ ok: boolean; error?: string }>;
  /** Write `base64` to a local temp copy named `name` and open it natively. For a file on a remote Environment. */
  fsOpenNativeData(name: string, base64: string): Promise<{ ok: boolean; error?: string }>;
  /** Ask where to save `base64` as `name` (the dialog opens in Downloads), then write it. `filePath` is null on cancel. */
  fsSaveData(name: string, base64: string): Promise<{ filePath: string | null; error?: string }>;

  // ─── Guided Questions (AskUserQuestions wizard) ───
  /** Native image picker for per-question answer attachments. */
  questionsPickAttachments(): Promise<Array<{ path: string; name: string }>>;

  // ─── Plugin management ───

  // ─── MCP server administration ───

  on(channel: string, callback: (...args: any[]) => void): void;
  off(channel: string, callback: (...args: any[]) => void): void;

  // ─── Auto-update ───
  installUpdate(): void;
  restartForUpdate(): void;
  onUpdateDownloaded(callback: (info: { version: string }) => void): () => void;
  onUpdateProgress(
    callback: (info: { percent: number; status: string }) => void,
  ): () => void;
  onUpdateStaged(callback: (info: { workerPid: number }) => void): () => void;
  onUpdateError(callback: (info: { message: string }) => void): () => void;

  // ─── Build Notice (this desktop's running build) ───
  /** The notice for a build this device has not acknowledged yet; null otherwise. */
  getBuildNotice(): Promise<BuildNotice | null>;
  /** Record the running build as acknowledged, so its notice does not show again. */
  acknowledgeBuildNotice(): Promise<void>;

  // ─── Device Metrics (this machine's own Studio processes) ───
  /** Start (true) or stop fast sampling; resolves to the latest sample. */
  deviceMetricsWatch(on: boolean): Promise<DeviceMetricsSample | null>;
  onDeviceMetrics(callback: (sample: DeviceMetricsSample) => void): () => void;

  // ─── Renderer logging bridge ───
  /** Write a structured log line from renderer context. The main process
   *  stamps component=desktop and forwards to the shared desktop logger. */
  logWrite(
    level: string,
    tag: string,
    msg: string,
    fields?: Record<string, unknown>,
  ): void;

}
