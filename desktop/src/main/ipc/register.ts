import { registerSystemIpc } from "./system";
import { registerFileDialogIpc } from "./file-dialog";
import { registerOAuthCallbackIpc } from "./oauth-callback";
import { registerAttachmentsIpc } from "./attachments";
import { registerFilesIpc } from "./files";
// Side-effect import: registers the desktop's save-dialog implementation
// with the server's headless engine-export-handler seam. Nothing here calls
// a named export — the registration runs at module evaluation.
import "../engine-export-handler";
import { registerLogIpc } from "./log";
import { registerStudioIpc } from "./studio";
import { registerStudioBridgeIpc } from "./studio-bridge";
import { registerFaviconIpc } from "./favicon";
import { registerWorktreeOverlapIpc } from "./worktree-overlap";
import { registerStartupIpc } from "./startup";
import { registerQuestionsIpc } from "../questions/questions-ipc";

export function registerAllIpc(): void {
  registerStartupIpc();
  // Guided Questions: the coordinator, its persistence and the engine-event
  // intake are wired by the Studio server. registerQuestionsIpc owns the one
  // handler that genuinely needs an Electron window (the native attachment
  // picker) plus the renderer-facing ion:questions-* handlers.
  registerQuestionsIpc();
  registerSystemIpc();
  registerFileDialogIpc();
  registerOAuthCallbackIpc();
  registerAttachmentsIpc();
  registerFilesIpc();
  registerLogIpc();
  registerStudioIpc();
  registerStudioBridgeIpc();
  registerFaviconIpc();
  registerWorktreeOverlapIpc();
}
