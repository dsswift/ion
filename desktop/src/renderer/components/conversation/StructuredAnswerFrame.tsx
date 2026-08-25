import React from 'react'
import { ListChecks } from '@phosphor-icons/react'
import { useColors } from '../../theme'

/**
 * Chrome that frames a Guided Questions submission in the transcript.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * A submitted answer set is the operator's own input — they read the
 * questions, chose the options, typed the free text, attached the images — so
 * it must stay visible. Hiding it (an earlier revision did) deleted real work
 * from the transcript.
 *
 * But it is not a message they composed at the prompt. The engine renders the
 * submission into prose (question prompts echoed, option labels resolved,
 * skips spelled out), and an ordinary user bubble presents that rendering as
 * something they typed. Scrolling back weeks later, the honest reaction is
 * "I never wrote that."
 *
 * A small corner tag was the first attempt and was not enough: at a glance the
 * bubble still read as a normal message. So this is deliberate CHROME —
 * a labelled rule above, an inset panel that visually groups the answers AND
 * their attachments, and a closing rule. The block reads as a distinct region
 * of the transcript, scannable while scrolling fast, without ever implying the
 * operator typed the prose inside it.
 *
 * Full width, not bubble width: the point is separation from the surrounding
 * turns, and a right-aligned 85%-width block would still read as "a message
 * they sent".
 */
export function StructuredAnswerFrame({ children }: { children: React.ReactNode }) {
  const colors = useColors()

  return (
    <div className="w-full flex flex-col select-none-header">
      {/* Opening rule + label. The rule spans the transcript so the boundary
          is visible even when the answers themselves are short. */}
      <div className="flex items-center gap-2 w-full pb-1.5 select-none">
        <div className="h-px flex-1" style={{ background: colors.infoBorder }} />
        <div
          className="flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide leading-none"
          style={{ color: colors.infoText }}
        >
          <ListChecks size={12} weight="bold" />
          Questions answered
        </div>
        <div className="h-px flex-1" style={{ background: colors.infoBorder }} />
      </div>

      {/* The panel. Groups the answer prose and every attached image into one
          visually-owned region, tinted and bordered so it is unmistakably not
          an ordinary bubble.
          
          It HUGS its content rather than filling the row: a short answer in a
          full-width tinted box reads as a layout bug, not as grouping. The
          rules above and below already carry the boundary across the
          transcript, so the panel only has to own the content itself. It stays
          right-aligned with the other user turns and is capped at the same 85%
          the ordinary bubble uses, so a long answer wraps identically. */}
      <div className="flex justify-end w-full min-w-0">
        <div
          className="inline-flex flex-col items-stretch gap-1.5 px-2.5 py-2 rounded-[12px] min-w-0 max-w-[85%]"
          style={{
            background: colors.infoBg,
            border: `1px solid ${colors.infoBorder}`,
          }}
        >
          {children}
        </div>
      </div>

      {/* Closing rule: marks where the submission ends, so the agent's reply
          below is clearly a separate turn. */}
      <div className="h-px w-full mt-1.5" style={{ background: colors.infoBorder }} />
    </div>
  )
}
