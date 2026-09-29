/**
 * Re-export of ConversationInstance from the shared type definition.
 *
 * The canonical definition lives in shared/types-engine.ts so it can be used
 * by both the renderer and the main process. This file exists at the renderer
 * store types path for import ergonomics in renderer-only code.
 */
export type { ConversationInstance } from '@ion/shared/types-engine'
