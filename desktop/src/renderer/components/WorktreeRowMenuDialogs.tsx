/**
 * WorktreeRowMenuDialogs — the confirm/outcome dialogs owned by WorktreeRowMenu.
 *
 * Extracted from WorktreeRowMenu.tsx, which was over the 600-line cap. These
 * three dialogs are a natural seam: they are driven entirely by the menu's
 * dialog state and callbacks, and none of them touches the menu's item list,
 * anchor geometry, or verb handlers.
 *
 * The menu component stays mounted while a dialog is up (it owns the dialog
 * state and the busy guard) — only the menu body is withdrawn. That is why
 * these render as siblings of the menu rather than replacing it.
 */
import React from "react";
import { ConfirmDialog } from "./git/ConfirmDialog";
import { rError } from "../rendererLogger";

export function WorktreeRowMenuDialogs({
  landError,
  confirmDiscardRecordings,
  setConfirmDiscardRecordings,
  discardRecordingsOutcome,
  setDiscardRecordingsOutcome,
  busy,
  doDiscardRecordings,
  confirmRetire,
  setLandError,
  setConfirmRetire,
  doLandAndRetire,
  onClose,
}: {
  landError: string | null;
  setLandError: (value: string | null) => void;
  confirmDiscardRecordings: string | null;
  setConfirmDiscardRecordings: (value: string | null) => void;
  discardRecordingsOutcome: string | null;
  setDiscardRecordingsOutcome: (value: string | null) => void;
  busy: boolean;
  doDiscardRecordings: () => Promise<void>;
  confirmRetire: string | null;
  setConfirmRetire: (value: string | null) => void;
  doLandAndRetire: () => Promise<void>;
  onClose: () => void;
}): React.ReactElement {
  return (
    <>
      {landError !== null && (
        <ConfirmDialog
          title="Land and retire did not complete"
          message={landError}
          acknowledge
          onConfirm={() => {
            setLandError(null);
            onClose();
          }}
          onCancel={() => {
            setLandError(null);
            onClose();
          }}
        />
      )}

      {discardRecordingsOutcome !== null && (
        <ConfirmDialog
          title="Recorded resolutions"
          message={discardRecordingsOutcome}
          acknowledge
          onConfirm={() => {
            setDiscardRecordingsOutcome(null);
            setConfirmDiscardRecordings(null);
            onClose();
          }}
          onCancel={() => {
            setDiscardRecordingsOutcome(null);
            setConfirmDiscardRecordings(null);
            onClose();
          }}
        />
      )}

      {discardRecordingsOutcome === null &&
        confirmDiscardRecordings !== null && (
          <ConfirmDialog
            title="Discard this worktree’s recorded resolutions?"
            message={`Discard only recorded conflict resolutions for ${confirmDiscardRecordings}? Other worktrees’ recorded resolutions stay intact. A fresh conflict may need resolution when the bench reassembles.`}
            confirmLabel="Discard resolutions"
            cancelLabel="Keep resolutions"
            danger
            busy={busy}
            busyLabel="Discarding recorded resolutions…"
            onConfirm={() => {
              void doDiscardRecordings().catch((err) =>
                rError("worktree.menu", "discard recordings threw", {
                  error: String(err),
                }),
              );
            }}
            onCancel={() => {
              setConfirmDiscardRecordings(null);
              onClose();
            }}
          />
        )}

      {confirmRetire !== null && (
        <ConfirmDialog
          title="Land and retire this worktree?"
          message={confirmRetire}
          confirmLabel="Land and retire"
          cancelLabel="Keep it"
          danger
          busy={busy}
          busyLabel="Landing and retiring the worktree…"
          onConfirm={() => {
            void doLandAndRetire().catch((err) =>
              rError("worktree.menu", "land and retire threw", { error: String(err) }),
            )
          }}
          onCancel={() => {
            setConfirmRetire(null)
            onClose()
          }}
        />
      )}
    </>
  );
}
