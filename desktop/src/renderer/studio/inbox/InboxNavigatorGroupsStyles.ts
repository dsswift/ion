import type React from "react";
import type { useColors } from "../../theme";

type Colors = ReturnType<typeof useColors>;

export function projectStyle(colors: Colors): React.CSSProperties {
  return {
    display: "flex",
    alignItems: "center",
    gap: 6,
    width: "100%",
    marginTop: 8,
    padding: "4px 8px",
    border: "none",
    background: "transparent",
    color: colors.textSecondary,
    cursor: "pointer",
    fontSize: 11,
    fontWeight: 600,
    textAlign: "left",
  };
}

export function groupStyle(colors: Colors): React.CSSProperties {
  return {
    display: "flex",
    alignItems: "center",
    gap: 6,
    width: "calc(100% - 20px)",
    margin: "5px 10px 2px",
    padding: "5px 8px",
    border: `1px solid ${colors.containerBorder}`,
    borderRadius: 5,
    background: colors.containerBg,
    color: colors.textSecondary,
    cursor: "pointer",
    fontSize: 11,
    fontWeight: 600,
    textAlign: "left",
  };
}

export function caretStyle(colors: Colors): React.CSSProperties {
  return {
    display: "inline-flex",
    border: "none",
    background: "transparent",
    color: colors.textTertiary,
    cursor: "pointer",
    padding: 0,
  };
}
