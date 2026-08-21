import { useEffect, useState } from "react";
import {
  studioWindowControlInset,
  type StudioWindowControlInset,
} from "../../../shared/studio-chrome";
import type { ColorPalette } from "../../theme";
import { rWarn } from "../../rendererLogger";
import { opaqueTitleBarColor } from "./title-bar-overlay-color";

/** Native title-bar state shared by Studio chrome components. */
export function useStudioWindowChrome(
  colors: ColorPalette,
): StudioWindowControlInset {
  const platform = window.ion.platform;
  const [fullScreen, setFullScreen] = useState(false);

  useEffect(
    () => window.ion.onStudioWindowChrome((state) => setFullScreen(state.fullScreen)),
    [],
  );

  useEffect(() => {
    if (platform === "darwin") return;
    const color = opaqueTitleBarColor(
      colors.containerBgCollapsed,
      colors.containerBg,
    );
    const symbolColor = opaqueTitleBarColor(colors.textSecondary, color);
    void window.ion
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
  }, [colors, platform]);

  if (fullScreen) return { left: 0, right: 0 };
  return studioWindowControlInset(platform);
}
