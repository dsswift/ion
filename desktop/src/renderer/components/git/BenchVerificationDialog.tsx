/**
 * BenchVerificationDialog — what a bench VERIFICATION failure IS, and the
 * three ways out.
 *
 * ── Why this is not BenchConflictDialog ─────────────────────────────────────
 * A merge conflict means some member's contribution never entered the tree.
 * A verification failure means every merge succeeded — including any
 * replayed rerere resolutions — and the project's OWN `bench.verify` command
 * rejected the resulting tree. Different failure, different explanation,
 * different recovery: there is no member to point at with "this one didn't
 * merge", so the surface instead names the verify command, its output, and
 * the members whose merge came from a replay (the suspects).
 *
 * Reads the workspace record synchronously — no IPC probe on open — for the
 * same view-readiness reason BenchConflictDialog does: the bench is wiped
 * empty by the time this opens, so there is nothing live to probe.
 *
 * ── The three verbs ──────────────────────────────────────────────────────
 * - **Dismiss**: closes. Nothing mutates.
 * - **Discard recordings and reassemble**: the targeted, WORKING forget
 *   (bench-recording-recovery.ts) over the suspect branches, behind a
 *   count-bearing confirm — the same consent gate the existing "discard all"
 *   verb uses (ADR-024 § "Recorded resolutions can be purged").
 * - **Analyse**: opens a locked, plan-mode conversation that rebuilds the
 *   failing tree and returns a verdict (mechanical vs semantic) — never an
 *   attempted fix. See bench-verification-prompt.ts for why.
 */
import React, { useState } from "react";
import {
  ArrowsClockwise,
  ChatCircle,
  Trash,
  Warning,
} from "@phosphor-icons/react";
import { useColors } from "../../theme";
import { FloatingPanel } from "../FloatingPanel";
import { ConfirmDialog } from "./ConfirmDialog";
import { useSessionStore } from "../../stores/sessionStore";
import { rError, rInfo } from "../../rendererLogger";
import type { IntegrationWorkspace } from "../../../shared/types";

export function BenchVerificationDialog({
  repoPath,
  workspace,
  onClose,
}: {
  repoPath: string;
  /** The failed workspace record — the dialog's whole read model. */
  workspace: IntegrationWorkspace;
  onClose: () => void;
}): React.JSX.Element {
  const colors = useColors();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"discard" | "analyse" | null>(null);
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);

  const evidence = workspace.lastAssemblyVerification;
  const suspects = evidence?.replayedBranches ?? [];

  const analyse = (): void => {
    setBusy("analyse");
    void useSessionStore
      .getState()
      .openBenchVerificationAnalysis(repoPath, workspace.sourceBranch)
      .then(() => onClose())
      .catch((err) => {
        rError("bench.verification", "analysis open failed", {
          error: String(err),
        });
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setBusy(null));
  };

  const discardAndReassemble = (): void => {
    setConfirmingDiscard(false);
    setBusy("discard");
    void useSessionStore
      .getState()
      .benchDiscardMemberRecordings(repoPath, workspace.sourceBranch, suspects)
      .then((result) => {
        if (!result.ok) {
          rError("bench.verification", "discard and reassemble failed", {
            error: result.error ?? "",
          });
          setError(result.error ?? "Could not discard the recordings.");
          return;
        }
        rInfo("bench.verification", "discard and reassemble completed", {
          forgotten_count: result.forgottenCount ?? 0,
          outcome: result.workspace?.lastAssembly ?? "unknown",
        });
        onClose();
      })
      .catch((err) => {
        rError("bench.verification", "discard and reassemble threw", {
          error: String(err),
        });
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setBusy(null));
  };

  return (
    <FloatingPanel
      title={`Verification failed — ${workspace.sourceBranch}`}
      onClose={onClose}
      defaultWidth={620}
      defaultHeight={420}
      workingDir={workspace.benchPath}
    >
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          height: "100%",
          minHeight: 0,
        }}
      >
        {error && (
          <div
            style={{
              display: "flex",
              gap: 6,
              alignItems: "center",
              padding: "6px 10px",
              fontSize: 11,
              color: colors.dangerFg,
            }}
          >
            <Warning size={12} /> {error}
          </div>
        )}

        <div
          style={{
            padding: "8px 10px",
            fontSize: 11,
            color: colors.textPrimary,
            lineHeight: 1.5,
          }}
        >
          Every member merged — including any replayed conflict resolutions —
          but the project&apos;s own verify command rejected the resulting tree.
          No conflict is outstanding; the bench was left empty exactly as a
          merge conflict would leave it, but there is nothing here to resolve by
          merging. This is not a conflict.
        </div>

        <div
          style={{
            padding: "4px 10px 8px",
            fontSize: 10,
            color: colors.textSecondary,
          }}
        >
          <div style={{ fontFamily: "monospace", marginBottom: 4 }}>
            {evidence?.command || "(verify command unavailable)"}
          </div>
        </div>

        <div
          style={{ flex: 1, overflow: "auto", minHeight: 0, padding: "0 10px" }}
        >
          <div
            style={{
              fontSize: 10,
              color: colors.textTertiary,
              marginBottom: 4,
            }}
          >
            Output
          </div>
          <pre
            data-testid="bench-verification-output"
            style={{
              margin: 0,
              padding: 8,
              fontFamily: "monospace",
              fontSize: 10,
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              background: colors.surfaceHover,
              borderRadius: 4,
              color: colors.textPrimary,
            }}
          >
            {evidence?.outputTail || "(no output captured)"}
          </pre>

          {suspects.length > 0 && (
            <div style={{ marginTop: 10 }}>
              <div
                style={{
                  fontSize: 10,
                  color: colors.textTertiary,
                  marginBottom: 4,
                }}
              >
                Merged from a replayed recording (suspects)
              </div>
              {suspects.map((branch) => (
                <div
                  key={branch}
                  data-testid={`bench-verification-suspect-${branch}`}
                  style={{
                    fontSize: 11,
                    fontFamily: "monospace",
                    color: colors.textPrimary,
                    padding: "2px 0",
                  }}
                >
                  {branch}
                </div>
              ))}
            </div>
          )}
        </div>

        <div
          style={{
            padding: "6px 10px",
            fontSize: 10,
            color: colors.textSecondary,
            lineHeight: 1.5,
          }}
        >
          Analyse opens a locked, read-only conversation that names whether this
          is a poisoned recording (discard and re-resolve) or a genuine
          incompatibility between members (fix it in the owning worktree, not
          here).
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "8px 10px",
            borderTop: `1px solid ${colors.containerBorder}`,
          }}
        >
          <button
            data-testid="bench-verification-analyse"
            onClick={analyse}
            disabled={busy !== null}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 5,
              fontSize: 11,
              padding: "3px 10px",
              borderRadius: 4,
              cursor: "pointer",
              border: `1px solid ${colors.accent}`,
              background: colors.accentLight,
              color: colors.accent,
            }}
          >
            {busy === "analyse" ? (
              <ArrowsClockwise size={12} className="animate-spin" />
            ) : (
              <ChatCircle size={12} />
            )}
            Analyse
          </button>
          <button
            data-testid="bench-verification-discard"
            onClick={() => setConfirmingDiscard(true)}
            disabled={busy !== null || suspects.length === 0}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 5,
              fontSize: 11,
              padding: "3px 10px",
              borderRadius: 4,
              cursor: suspects.length === 0 ? "default" : "pointer",
              border: `1px solid ${colors.containerBorder}`,
              background: "transparent",
              color:
                suspects.length === 0
                  ? colors.textTertiary
                  : colors.textPrimary,
            }}
          >
            {busy === "discard" ? (
              <ArrowsClockwise size={12} className="animate-spin" />
            ) : (
              <Trash size={12} />
            )}
            Discard recordings and reassemble
          </button>
          <span style={{ flex: 1 }} />
          <button
            data-testid="bench-verification-dismiss"
            onClick={onClose}
            disabled={busy !== null}
            style={{
              fontSize: 11,
              padding: "3px 8px",
              borderRadius: 4,
              cursor: "pointer",
              border: `1px solid ${colors.containerBorder}`,
              background: "transparent",
              color: colors.textSecondary,
            }}
          >
            Dismiss
          </button>
        </div>
      </div>

      {confirmingDiscard && (
        <ConfirmDialog
          title="Discard recorded resolutions?"
          message={
            `Discard the recorded resolution${suspects.length === 1 ? "" : "s"} for ${suspects.join(", ")}? ` +
            "The bench will reassemble; a genuine conflict, if there still is one, will need to be resolved again."
          }
          confirmLabel={`Discard ${suspects.length}`}
          danger
          onCancel={() => setConfirmingDiscard(false)}
          onConfirm={discardAndReassemble}
        />
      )}
    </FloatingPanel>
  );
}
