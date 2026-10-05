/**
 * FleetCompatibility — which servers can work with which. One grid per
 * compared format, rows sending to columns: moving a conversation, and a
 * desktop connecting to a server. The grids sit side by side when the page
 * is wide enough for both.
 */
import React from 'react'
import { FLEET_STUDIO_WIRE_FORMAT, FLEET_TRANSFER_FORMAT, buildFleetMatrix, type FleetMatrix, type FleetMatrixCell, type FleetServer, type FleetVerdict } from '@ion/shared/fleet-view'
import { useColors } from '../../../../theme'
import { Tooltip } from '../../../git/Tooltip'
import { Chip, EmptyState, Group, GroupHeader, KIT, type Tone } from '../../kit'

const VERDICT: Record<FleetVerdict, { tone: Tone; word: string }> = {
  ok: { tone: 'ok', word: 'works' },
  blocked: { tone: 'error', word: 'blocked' },
  unknown: { tone: 'muted', word: 'unknown' },
}

const TITLES: Record<string, { title: string; description: string }> = {
  [FLEET_TRANSFER_FORMAT]: { title: 'Moving a conversation', description: 'A conversation moves from a row to a column only when their transfer formats match.' },
  [FLEET_STUDIO_WIRE_FORMAT]: { title: 'Connecting a desktop', description: 'The desktop on a row can connect to the server in a column.' },
}

function cellText(cell: FleetMatrixCell): string {
  const versions = `${cell.fromVersion ?? '?'} → ${cell.toVersion ?? '?'}`
  return cell.reason ? `${versions}: ${cell.reason}` : versions
}

function Matrix({ matrix }: { matrix: FleetMatrix }): React.JSX.Element {
  const colors = useColors()
  const heading = TITLES[matrix.formatId] ?? { title: matrix.formatId, description: matrix.meaning }
  const cell: React.CSSProperties = { padding: '6px 10px', fontSize: KIT.fontSmall, textAlign: 'left', borderTop: `1px solid ${colors.borderSubtle}`, whiteSpace: 'nowrap' }
  const head: React.CSSProperties = { ...cell, borderTop: 'none', fontSize: KIT.fontTiny, fontWeight: 500, color: colors.textTertiary }
  return (
    <section aria-label={heading.title} style={{ flex: '1 1 340px', minWidth: 0 }}>
      <GroupHeader title={heading.title} description={heading.description} />
      <Group padded>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ borderCollapse: 'collapse', color: colors.textPrimary }}>
            <thead>
              <tr>
                <th scope="col" style={head}>From ↓ to →</th>
                {matrix.columns.map((c) => <th key={c.id} scope="col" style={head}>{c.label}</th>)}
              </tr>
            </thead>
            <tbody>
              {matrix.rows.map((row, r) => (
                <tr key={row.id}>
                  <th scope="row" style={{ ...cell, fontWeight: 500 }}>{row.label}</th>
                  {matrix.cells[r].map((c) => (
                    <td key={c.to} style={cell}>
                      {c.from === c.to ? <span style={{ color: colors.textTertiary }}>—</span> : (
                        <Tooltip text={cellText(c)}><Chip tone={VERDICT[c.verdict].tone}>{VERDICT[c.verdict].word}</Chip></Tooltip>
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Group>
    </section>
  )
}

/** No grid is drawn until two servers report a format: one server has nobody to disagree with. */
export function FleetCompatibility({ servers }: { servers: readonly FleetServer[] }): React.JSX.Element {
  const matrices = [FLEET_TRANSFER_FORMAT, FLEET_STUDIO_WIRE_FORMAT]
    .map((id) => buildFleetMatrix(servers, id))
    .filter((m): m is FleetMatrix => m !== null && m.columns.length > 1 && m.rows.length > 0)
  if (matrices.length === 0) {
    return <div data-settings-anchor="fleet-compatibility"><Group><EmptyState title="Nothing to compare yet." detail="Compatibility shows once two servers have reported their formats." /></Group></div>
  }
  return (
    <div data-settings-anchor="fleet-compatibility" style={{ display: 'flex', flexWrap: 'wrap', gap: KIT.groupGap }}>
      {matrices.map((m) => <Matrix key={m.formatId} matrix={m} />)}
    </div>
  )
}
