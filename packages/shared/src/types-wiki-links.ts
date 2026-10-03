// Wiki-link maintenance payloads: the report the engine emits after it
// rewrites links for a rename, and the result of its link integrity scan.
// Mirrors engine/internal/types/wiki_links.go.

/** One detected document rename. Paths are workspace-relative. */
export interface WikiLinkRename {
  oldPath: string;
  newPath: string;
}

/** One rewritten wiki link. */
export interface WikiLinkRewrite {
  /** 1-based line the link sits on. */
  line: number;
  /** Full link text before the rewrite, brackets included. */
  oldLink: string;
  /** Full link text after the rewrite. Alias and `#section` are kept. */
  newLink: string;
  /** Workspace-relative path the link resolved to before the rename. */
  oldTarget: string;
  /** Workspace-relative path the link resolves to now. */
  newTarget: string;
}

/** The links rewritten in one file. `path` is workspace-relative. */
export interface WikiLinkFileRewrites {
  path: string;
  rewrites: WikiLinkRewrite[];
}

/** A file whose links needed rewriting but could not be written. */
export interface WikiLinkFileFailure {
  path: string;
  error: string;
}

/**
 * The complete record of one propagation pass. `files` is empty when no link
 * needed rewriting.
 */
export interface WikiLinkPropagationReport {
  /** Absolute workspace root the pass was confined to. */
  root: string;
  renames: WikiLinkRename[];
  files: WikiLinkFileRewrites[];
  /** Total links rewritten across `files`. */
  rewriteCount: number;
  failed?: WikiLinkFileFailure[];
}

/** One wiki link that resolves to no single file. */
export interface WikiLinkBrokenLink {
  /** Workspace-relative path of the file holding the link. */
  path: string;
  /** 1-based line the link sits on. */
  line: number;
  /** Full link text, brackets included. */
  link: string;
  /** The link target with any alias and `#section` removed. */
  target: string;
  reason: "missing" | "ambiguous";
  /** The files an ambiguous target could name. */
  candidates?: string[];
}

/** Result data of the engine's `scan_wiki_links` command. */
export interface WikiLinkIntegrityReport {
  /** Absolute workspace root that was scanned. */
  root: string;
  documentsScanned: number;
  linksChecked: number;
  broken: WikiLinkBrokenLink[];
}
