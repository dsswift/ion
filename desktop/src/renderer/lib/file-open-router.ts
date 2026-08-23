/**
 * content-router — one seam from shared content click sites into Studio surface
 * tabs. Overlay never registers and preserves its floating fallback.
 */
import type React from 'react'
import type { ResourceItem } from '../../shared/types-engine'

export interface ContentRouter {
  openTextFile(dir: string, tabId: string, filePath: string): void
  /** Open a plan: Studio activates Plan Canvas for latest path, otherwise file tab. */
  openPlan?(dir: string, tabId: string, filePath: string): void
  openImage(filePath: string, dataUrl?: string): void
  openHtml(filePath: string): void
  openGitDiff(target: { repoDir: string; filePath: string; staged: boolean }): boolean
  openResource?(item: ResourceItem): void
  openStatus?(): void
  openExplorer?(): void
  openGitPanel?(): void
  /** Open or replace the active conversation's single dispatch preview tab. */
  openDispatch?(agentName: string, dispatchId: string, title: string): void
  openPanel?(title: string, body: React.ReactNode, close: () => void): string
  /** Publish a later render from a routed legacy panel without changing tab focus. */
  updatePanel?(id: string, title: string, body: React.ReactNode): void
  /** Remove a panel whose owner unmounted; this does not call its close callback. */
  closePanel?(id: string): void
}

let router: ContentRouter | null = null

export function registerContentRouter(next: ContentRouter): () => void {
  router = next
  return () => { if (router === next) router = null }
}

export function contentRouter(): ContentRouter | null { return router }

/** Backward-compatible name for existing shared file call sites. */
export const registerSurfaceFileRouter = registerContentRouter
export const surfaceRouter = contentRouter
export type SurfaceFileRouter = ContentRouter
