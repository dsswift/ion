import { useCallback, useEffect, useLayoutEffect, useRef } from "react";

/**
 * Textarea auto-resize and multiline-mode detection for the Input Bar.
 *
 * Extracted from InputBar.tsx as its own seam: the measurement machinery is a
 * self-contained DOM concern with its own hidden node, its own lifecycle, and
 * no coupling to send, slash, voice, or attachment behavior.
 *
 * Why the hidden node exists. The visible textarea's width changes when the
 * component switches between inline and multiline layout. Measuring the real
 * element would therefore feed the layout decision with a width that the
 * decision itself just changed, and the control oscillates. A hidden textarea
 * pinned to the fixed inline width breaks that loop: the multiline decision is
 * always made against one stable geometry.
 */

export interface InputAutoResizeMetrics {
  /** Resting height of the visible textarea, in px. */
  minHeight: number;
  /** Height at which the textarea starts scrolling instead of growing. */
  maxHeight: number;
  /** Measured inline height above which the control enters multiline mode. */
  multilineEnterHeight: number;
  /**
   * Measured inline height below which it leaves multiline mode. Kept lower
   * than the enter threshold on purpose — the gap is hysteresis, without which
   * text sitting exactly on the boundary flips modes on every keystroke.
   */
  multilineExitHeight: number;
  /** Width the inline controls occupy beside the textarea. */
  inlineControlsReservedWidth: number;
}

export interface UseInputAutoResizeArgs {
  value: string;
  isMultiLine: boolean;
  setIsMultiLine: (next: (prev: boolean) => boolean) => void;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  wrapperRef: React.RefObject<HTMLDivElement | null>;
  metrics: InputAutoResizeMetrics;
}

export function useInputAutoResize({
  value,
  isMultiLine,
  setIsMultiLine,
  textareaRef,
  wrapperRef,
  metrics,
}: UseInputAutoResizeArgs): void {
  const measureRef = useRef<HTMLTextAreaElement | null>(null);

  const measureInlineHeight = useCallback(
    (text: string): number => {
      if (typeof document === "undefined") return 0;
      if (!measureRef.current) {
        const m = document.createElement("textarea");
        m.setAttribute("aria-hidden", "true");
        m.tabIndex = -1;
        m.style.position = "absolute";
        m.style.top = "-99999px";
        m.style.left = "0";
        m.style.height = "0";
        m.style.minHeight = "0";
        m.style.overflow = "hidden";
        m.style.visibility = "hidden";
        m.style.pointerEvents = "none";
        m.style.zIndex = "-1";
        m.style.resize = "none";
        m.style.border = "0";
        m.style.outline = "0";
        m.style.boxSizing = "border-box";
        document.body.appendChild(m);
        measureRef.current = m;
      }

      const m = measureRef.current;
      const hostWidth = wrapperRef.current?.clientWidth ?? 0;
      const inlineWidth = Math.max(
        120,
        hostWidth - metrics.inlineControlsReservedWidth,
      );
      m.style.width = `${inlineWidth}px`;
      m.style.fontSize = "14px";
      m.style.lineHeight = "20px";
      m.style.paddingTop = "15px";
      m.style.paddingBottom = "15px";
      m.style.paddingLeft = "0";
      m.style.paddingRight = "0";

      // Mirror the live element's typography so the measurement reflects the
      // operator's actual font, not the browser default.
      const computed = textareaRef.current
        ? window.getComputedStyle(textareaRef.current)
        : null;
      if (computed) {
        m.style.fontFamily = computed.fontFamily;
        m.style.letterSpacing = computed.letterSpacing;
        m.style.fontWeight = computed.fontWeight;
      }

      m.value = text || " ";
      return m.scrollHeight;
    },
    [metrics.inlineControlsReservedWidth, textareaRef, wrapperRef],
  );

  const autoResize = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = `${metrics.minHeight}px`;
    const naturalHeight = el.scrollHeight;
    const clampedHeight = Math.min(naturalHeight, metrics.maxHeight);
    el.style.height = `${clampedHeight}px`;
    el.style.overflowY = naturalHeight > metrics.maxHeight ? "auto" : "hidden";
    if (naturalHeight <= metrics.maxHeight) {
      el.scrollTop = 0;
    }
    // Decide multiline mode against the fixed inline-width measurement to avoid
    // expand/collapse bounce when layout switches between modes.
    const inlineHeight = measureInlineHeight(value);
    setIsMultiLine((prev) =>
      prev
        ? inlineHeight > metrics.multilineExitHeight
        : inlineHeight > metrics.multilineEnterHeight,
    );
  }, [
    value,
    measureInlineHeight,
    metrics.minHeight,
    metrics.maxHeight,
    metrics.multilineEnterHeight,
    metrics.multilineExitHeight,
    setIsMultiLine,
    textareaRef,
  ]);

  useLayoutEffect(() => {
    autoResize();
  }, [value, isMultiLine, autoResize]);

  // Cleanup the measurement DOM node on unmount.
  useEffect(() => {
    return () => {
      if (measureRef.current) {
        measureRef.current.remove();
        measureRef.current = null;
      }
    };
  }, []);
}
