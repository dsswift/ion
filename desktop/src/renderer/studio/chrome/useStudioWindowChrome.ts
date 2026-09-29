import { useEffect, useState } from "react";
import {
  studioWindowControlInset,
  type StudioWindowControlInset,
} from "@ion/shared/studio-chrome";
import type { ColorPalette } from "../../theme";
import { rWarn } from "../../rendererLogger";
import { opaqueTitleBarColor } from "./title-bar-overlay-color";
import { host } from '../../host/host-instance'

/** Native title-bar state shared by Studio chrome components. */
export function useStudioWindowChrome(
  colors: ColorPalette,
): StudioWindowControlInset {
  const platform = host.shell.platform;
  const hasNativeChrome = host.capabilities().includes('nativeWindowChrome');
  const [fullScreen, setFullScreen] = useState(false);

  useEffect(() => {
    // No native window chrome to control for a browser tab (see
    // StudioHost.ts's 'nativeWindowChrome' doc).
    if (!hasNativeChrome) return;
    return host.shell.onStudioWindowChrome((state) => setFullScreen(state.fullScreen));
  }, [hasNativeChrome]);

  useEffect(() => {
    if (!hasNativeChrome || platform === "darwin") return;
    const color = opaqueTitleBarColor(
      colors.containerBgCollapsed,
      colors.containerBg,
    );
    const symbolColor = opaqueTitleBarColor(colors.textSecondary, color);
    void host.shell
      .studioSetTitleBarOverlay(color, symbolColor)
      .then((applied) => {
        if (!applied) {
          rWarn("studio.chrome", "title bar overlay update rejected", {
            color,
            symbol_color: symbolColor,
          });
        }
      })
      .catch((error) =>
        rWarn("studio.chrome", "title bar overlay update failed", {
          error: String(error),
        }),
      );
  }, [colors, platform, hasNativeChrome]);

  if (fullScreen) return { left: 0, right: 0 };
  // The inset exists to keep Studio's own chrome from sliding under the
  // NATIVE window controls. A client with no native chrome (a browser tab,
  // spec 18) has no controls to avoid, so reserving the space just pushes
  // the title bar's right-hand buttons inward off the window edge -- which
  // is exactly what a browser client showed, because `unsupportedShell()`
  // reports `platform: 'linux'` and the non-darwin branch reserves a
  // Windows-sized control strip.
  if (!hasNativeChrome) return { left: 0, right: 0 };
  return studioWindowControlInset(platform);
}
