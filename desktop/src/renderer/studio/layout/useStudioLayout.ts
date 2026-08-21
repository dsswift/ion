/**
 * useStudioLayout — load, patch, and persist the Studio shell layout.
 *
 * One global layout state (never per-session) persisted under the
 * `studioLayout` settings key through the studioSetSetting funnel. Live
 * resize is React state only; a gesture costs one debounced disk write
 * (the seams call patch() from useResizablePane's onCommit).
 *
 * The shape contract lives in shared/types-studio.ts (normalizeStudioLayout
 * + STUDIO_LAYOUT_BOUNDS) and is enforced on BOTH sides: here on restore
 * (defensive re-validation of whatever is on disk) and in ipc/studio.ts on
 * write. hydrated stays false until the disk read lands so the shell can
 * render nothing instead of flashing default geometry.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  normalizeStudioLayout,
  type StudioLayout,
} from "../../../shared/types-studio";
import { rDebug, rWarn } from "../../rendererLogger";

const PERSIST_DEBOUNCE_MS = 300;

export interface UseStudioLayoutResult {
  layout: StudioLayout;
  /** False until the persisted layout has been read (render nothing before). */
  hydrated: boolean;
  /** Merge a partial patch into the layout and schedule one debounced persist. */
  patch: (p: Partial<StudioLayout>) => void;
}

export function useStudioLayout(): UseStudioLayoutResult {
  const [layout, setLayout] = useState<StudioLayout>(() =>
    normalizeStudioLayout(null),
  );
  const [hydrated, setHydrated] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef(layout);
  latest.current = layout;

  useEffect(() => {
    let alive = true;
    void window.ion
      .studioGetSettings()
      .then((s) => {
        if (!alive) return;
        const restored = normalizeStudioLayout(s?.studioLayout);
        setLayout(restored);
        setHydrated(true);
        rDebug("studio.layout", "layout restored", { ...restored });
      })
      .catch((err) => {
        if (!alive) return;
        // Defaults are a complete, valid layout — the shell still boots.
        setHydrated(true);
        rWarn("studio.layout", "settings read failed, using defaults", {
          error: String(err),
        });
      });
    return () => {
      alive = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  const patch = useCallback((p: Partial<StudioLayout>) => {
    setLayout((prev) => {
      const next = normalizeStudioLayout({ ...prev, ...p });
      latest.current = next;
      return next;
    });
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      void window.ion
        .studioSetSetting("studioLayout", latest.current)
        .then((ok) => {
          if (!ok)
            rWarn("studio.layout", "layout persist rejected by validator", {
              ...latest.current,
            });
        })
        .catch((err) =>
          rWarn("studio.layout", "layout persist failed", {
            error: String(err),
          }),
        );
    }, PERSIST_DEBOUNCE_MS);
  }, []);

  return { layout, hydrated, patch };
}
