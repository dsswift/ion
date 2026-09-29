/**
 * SettingsSearchResults — every setting matching the search, each with
 * where it lives. Picking one opens that page and flashes the row.
 */
import React from 'react'
import { useColors } from '../../theme'
import { useInteractiveState } from '../../hooks/useInteractiveState'
import { transitions } from '../../theme-tokens'
import { EmptyState, KIT, PageHeader } from './kit'
import type { SettingsSearchHit } from './settings-search-index'

export function SettingsSearchResults({ query, hits, serverLabel, onPick }: {
  query: string
  hits: readonly SettingsSearchHit[]
  /** The server server-page hits belong to. */
  serverLabel: string
  onPick(hit: SettingsSearchHit): void
}): React.JSX.Element {
  const colors = useColors()
  return (
    <div style={{ maxWidth: KIT.pageMaxWidth }}>
      <PageHeader title="Search" description={`${hits.length} ${hits.length === 1 ? 'setting matches' : 'settings match'} “${query.trim()}”.`} />
      {hits.length === 0 ? (
        <EmptyState title="No settings match" detail="Try a shorter word, or the name of the thing you want to change." />
      ) : (
        <div role="list" style={{ border: `1px solid ${colors.containerBorder}`, borderRadius: KIT.groupRadius, background: colors.surfacePrimary, overflow: 'hidden' }}>
          {hits.map((hit) => (
            <Hit key={`${hit.page.id}:${hit.item.id}`} hit={hit} where={hit.page.scope === 'server' ? `${serverLabel} › ${hit.page.label}` : hit.page.label} onPick={() => onPick(hit)} />
          ))}
        </div>
      )}
    </div>
  )
}

function Hit({ hit, where, onPick }: { hit: SettingsSearchHit; where: string; onPick(): void }): React.JSX.Element {
  const colors = useColors()
  const { hover, handlers } = useInteractiveState()
  const IconComp = hit.page.icon
  return (
    <button
      type="button"
      role="listitem"
      onClick={onPick}
      {...handlers}
      className="ion-focusable"
      style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', height: 40, padding: `0 ${KIT.inset}px`, border: 'none', borderBottom: `1px solid ${colors.borderSubtle}`, background: hover ? colors.surfaceHover : 'transparent', cursor: 'pointer', textAlign: 'left', transition: `background ${transitions.base}` }}
    >
      <IconComp size={15} color={colors.textTertiary} style={{ flexShrink: 0 }} />
      <span style={{ flex: 1, minWidth: 0, fontSize: KIT.font, color: colors.textPrimary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{hit.item.label}</span>
      <span style={{ fontSize: KIT.fontTiny, color: colors.textTertiary, whiteSpace: 'nowrap' }}>{where}</span>
    </button>
  )
}
