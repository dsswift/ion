/**
 * Settings kit tokens — the one set of sizes every Settings page is built
 * from. A page never picks its own padding, row height, or font size; it
 * composes kit parts, and the parts read these.
 */
export const KIT = {
  /** Body text: labels, row titles, control text. */
  font: 13,
  /** Secondary text: descriptions, table cells after the first. */
  fontSmall: 12,
  /** Captions: chips, column headers, footnotes. */
  fontTiny: 11,
  /** A list row. */
  rowHeight: 34,
  /** A form row's minimum height; a row with a description grows past it. */
  formRowHeight: 38,
  /** Buttons, inputs, and selects share one height so rows line up. */
  controlHeight: 26,
  radius: 6,
  groupRadius: 10,
  /** Horizontal padding inside a group or list row. */
  inset: 12,
  /** Space between groups on a page. */
  groupGap: 20,
  pageMaxWidth: 760,
  panelWidth: 440,
  /** A list taller than this scrolls inside itself instead of stretching the page. */
  listMaxHeight: 440,
  mono: 'ui-monospace, SFMono-Regular, Menlo, monospace',
} as const
