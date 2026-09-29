/**
 * Pull-forward mount pins (spec 16): each row that lands in Studio must be
 * reachable from `StudioShell.tsx`/`StudioCenter.tsx`/the shared components
 * they mount. Source-scan style, matching `StudioShell-shortcuts.test.ts`'s
 * existing convention — these components carry heavy runtime dependencies
 * (session store, host bridge, popover layer) that a full render would
 * require mocking wholesale; the scan pins the actual wiring instead.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const studioShellSource = readFileSync(resolve(import.meta.dirname, "../StudioShell.tsx"), "utf8");
const studioCenterSource = readFileSync(resolve(import.meta.dirname, "../StudioCenter.tsx"), "utf8");
const composerControlsSource = readFileSync(resolve(import.meta.dirname, "../../components/ComposerControls.tsx"), "utf8");
const shortcutCatalogSource = readFileSync(resolve(import.meta.dirname, "../../shortcuts/shortcut-catalog.ts"), "utf8");
const gitPanelRepoSectionSource = readFileSync(resolve(import.meta.dirname, "../../components/GitPanelRepoSection.tsx"), "utf8");
const remoteActionsSource = readFileSync(resolve(import.meta.dirname, "../../../../../server/src/protocol/remote-actions.ts"), "utf8");
const channelsSource = readFileSync(resolve(import.meta.dirname, "../../../../../packages/shared/src/studio-wire/channels.ts"), "utf8");
const bootstrapSource = readFileSync(resolve(import.meta.dirname, "../useStudioBootstrap.ts"), "utf8");

describe("pull-forward: composer rows", () => {
  it("keeps attach, screenshot, and quick tools inside the composer, never floating beside the pill", () => {
    expect(studioCenterSource).not.toContain("AttachmentComposerControls");
    expect(composerControlsSource).toContain("<ComposerPlusMenu");
    expect(composerControlsSource).toContain("<ComposerQuickToolsButton />");
  });
});

describe("pull-forward: shell rows", () => {
  it("mounts RemoteDirectoryPicker beside the existing Studio overlays", () => {
    expect(studioShellSource).toContain("<RemoteDirectoryPicker />");
  });

  it("wraps the conversation region with ConversationErrorBoundary", () => {
    expect(studioCenterSource).toContain("<ConversationErrorBoundary>");
    expect(studioCenterSource).toContain("<ConversationView key={activeTabId} tabId={activeTabId} />");
  });

  it("mounts WorktreeOverlapLauncher in the shared git panel repo header (reaches both presentations)", () => {
    expect(gitPanelRepoSectionSource).toContain("<WorktreeOverlapLauncher repoPath={directory} sourceBranch={repoState?.branch} />");
  });
});

describe("pull-forward: event rows", () => {
  it("runs setupModelSync once during Studio bootstrap", () => {
    expect(bootstrapSource).toContain("setupModelSync()");
    expect(bootstrapSource).toContain("@ion/server/store/model-store");
  });

  // The REMOTE_RELAYS_CHANGED producer used to be pinned here too, in
  // `server/src/remote/transport-controller.ts`. That file went with the
  // `desktop_*` device transport; the channel and the Studio subscriber
  // (`browser-shell-subscribe.ts`'s `onRemoteRelaysChanged`) survive, so the
  // channel registration is still pinned and the producer assertion is not.
  it("fans REMOTE_DISPLAY_CHANGED to every Studio client from the server", () => {
    expect(remoteActionsSource).toContain("broadcast(IPC.REMOTE_DISPLAY_CHANGED, result.value)");
    expect(channelsSource).toContain("{ name: 'ion:remote-relays-changed', scope: 'environment', views: ['mirror', 'thin'] }");
    expect(channelsSource).toContain("{ name: 'ion:remote-display-changed', scope: 'environment' }");
  });
});

describe("pull-forward: shortcut rows", () => {
  it("re-registers tab.newHere for the studio view, opening in the active tab's directory", () => {
    expect(shortcutCatalogSource).toContain(
      "{ id: 'tab.newHere', group: 'Tabs', description: 'New tab (current directory)', defaultBinding: 'Mod+Shift+t' }",
    );
    expect(studioShellSource).toContain('"tab.newHere": () => {');
  });
});
