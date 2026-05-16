import React, { useState, useEffect } from 'react'
import { ArrowsLeftRight, CheckCircle, WarningCircle, Info, ShieldCheck } from '@phosphor-icons/react'
import { useColors } from '../../theme'
import { SettingHeading } from './SettingHeading'

interface OtherTab {
  conversationId: string
  title: string
  customTitle: string | null
  workingDirectory: string
  permissionMode: string
}

interface MigrationResultData {
  backupPaths: string[]
  migrated: Array<{ conversationId: string; newConversationId: string; title: string }>
  failed: Array<{ conversationId: string; title: string; error: string }>
}

export function MigrationCategory() {
  const colors = useColors()
  const [currentBackend, setCurrentBackend] = useState<'api' | 'cli'>('api')
  const [otherTabs, setOtherTabs] = useState<OtherTab[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [migrating, setMigrating] = useState(false)
  const [result, setResult] = useState<MigrationResultData | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function load() {
      try {
        const backend = await window.ion?.getBackend()
        setCurrentBackend(backend || 'api')
        const tabs = await window.ion?.loadOtherBackendTabs()
        setOtherTabs(tabs || [])
      } catch {}
      setLoading(false)
    }
    load()
  }, [])

  const otherBackend = currentBackend === 'api' ? 'CLI' : 'API'
  const targetLabel = currentBackend === 'api' ? 'API' : 'CLI'

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const toggleAll = () => {
    if (selected.size === otherTabs.length) setSelected(new Set())
    else setSelected(new Set(otherTabs.map((t) => t.conversationId)))
  }

  const handleMigrate = async () => {
    if (selected.size === 0 || migrating) return
    setMigrating(true)
    setResult(null)
    try {
      const targetBackend: 'api' | 'cli' = currentBackend
      const res = await window.ion?.migrateTabs(Array.from(selected), targetBackend)
      setResult(res || null)
      if (res?.migrated?.length) {
        setOtherTabs((prev) =>
          prev.filter((t) => !res.migrated.some((m: { conversationId: string }) => m.conversationId === t.conversationId)),
        )
        setSelected(new Set())
      }
    } catch (err: any) {
      setResult({ backupPaths: [], migrated: [], failed: [{ conversationId: '', title: 'All', error: err.message }] })
    }
    setMigrating(false)
  }

  const cardStyle: React.CSSProperties = {
    background: colors.surfacePrimary,
    border: `1px solid ${colors.containerBorder}`,
    borderRadius: 8,
    padding: '10px 12px',
    marginBottom: 8,
  }

  return (
    <>
      <SettingHeading first>Tab Migration</SettingHeading>

      <div style={{ ...cardStyle, display: 'flex', alignItems: 'center', gap: 8 }}>
        <ShieldCheck size={16} color={colors.accent} />
        <span style={{ fontSize: 12, color: colors.textSecondary }}>
          Source conversations are never modified or deleted. Backups are created before any changes.
        </span>
      </div>

      <div style={{ fontSize: 12, color: colors.textTertiary, marginBottom: 12 }}>
        You are currently on the <strong style={{ color: colors.textPrimary }}>{targetLabel}</strong> backend.
        Select conversations from the <strong style={{ color: colors.textPrimary }}>{otherBackend}</strong> backend
        to migrate into your current tab set.
      </div>

      {loading ? (
        <div style={{ fontSize: 12, color: colors.textTertiary, padding: 16, textAlign: 'center' }}>
          Loading tabs…
        </div>
      ) : otherTabs.length === 0 ? (
        <div style={{ ...cardStyle, textAlign: 'center' }}>
          <span style={{ fontSize: 12, color: colors.textTertiary }}>
            No tabs found in the {otherBackend} backend.
          </span>
        </div>
      ) : (
        <>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
            <button
              onClick={toggleAll}
              style={{
                background: 'none', border: 'none', cursor: 'pointer',
                color: colors.accent, fontSize: 12, padding: 0,
              }}
            >
              {selected.size === otherTabs.length ? 'Deselect all' : 'Select all'}
            </button>
            <span style={{ fontSize: 11, color: colors.textTertiary }}>
              {selected.size} of {otherTabs.length} selected
            </span>
          </div>

          <div style={{ maxHeight: 220, overflowY: 'auto', marginBottom: 12 }}>
            {otherTabs.map((tab) => {
              const isSelected = selected.has(tab.conversationId)
              return (
                <label
                  key={tab.conversationId}
                  style={{
                    ...cardStyle,
                    display: 'flex', alignItems: 'center', gap: 8,
                    cursor: 'pointer', opacity: migrating ? 0.6 : 1,
                    background: isSelected ? `${colors.accent}11` : colors.surfacePrimary,
                    borderColor: isSelected ? colors.accent : colors.containerBorder,
                  }}
                >
                  <input
                    type="checkbox"
                    checked={isSelected}
                    onChange={() => toggleSelect(tab.conversationId)}
                    disabled={migrating}
                    style={{ accentColor: colors.accent, margin: 0 }}
                  />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 500, color: colors.textPrimary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {tab.title}
                    </div>
                    <div style={{ fontSize: 11, color: colors.textTertiary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {tab.workingDirectory}
                    </div>
                  </div>
                </label>
              )
            })}
          </div>

          <button
            onClick={handleMigrate}
            disabled={selected.size === 0 || migrating}
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
              width: '100%', padding: '8px 12px',
              background: selected.size > 0 && !migrating ? colors.accent : colors.containerBg,
              border: 'none', borderRadius: 8,
              color: selected.size > 0 && !migrating ? '#fff' : colors.textTertiary,
              cursor: selected.size > 0 && !migrating ? 'pointer' : 'default',
              fontSize: 13, fontWeight: 600,
            }}
          >
            <ArrowsLeftRight size={16} />
            {migrating ? 'Migrating…' : `Migrate ${selected.size} tab${selected.size !== 1 ? 's' : ''} to ${targetLabel}`}
          </button>
        </>
      )}

      {result && (
        <div style={{ marginTop: 12 }}>
          {result.migrated.length > 0 && (
            <div style={{ ...cardStyle, borderColor: '#34d399' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                <CheckCircle size={16} color="#34d399" weight="fill" />
                <span style={{ fontSize: 12, fontWeight: 600, color: colors.textPrimary }}>
                  {result.migrated.length} tab{result.migrated.length !== 1 ? 's' : ''} migrated
                </span>
              </div>
              {result.migrated.map((m) => (
                <div key={m.conversationId} style={{ fontSize: 11, color: colors.textSecondary, marginLeft: 22 }}>
                  {m.title}
                </div>
              ))}
            </div>
          )}

          {result.failed.length > 0 && (
            <div style={{ ...cardStyle, borderColor: '#f87171' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                <WarningCircle size={16} color="#f87171" weight="fill" />
                <span style={{ fontSize: 12, fontWeight: 600, color: colors.textPrimary }}>
                  {result.failed.length} tab{result.failed.length !== 1 ? 's' : ''} failed
                </span>
              </div>
              {result.failed.map((f, i) => (
                <div key={i} style={{ fontSize: 11, color: colors.textSecondary, marginLeft: 22 }}>
                  {f.title}: {f.error}
                </div>
              ))}
            </div>
          )}

          {result.backupPaths.length > 0 && (
            <div style={{ ...cardStyle, background: 'transparent', border: 'none', padding: '4px 0' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 2 }}>
                <Info size={14} color={colors.textTertiary} />
                <span style={{ fontSize: 11, color: colors.textTertiary }}>Backups saved:</span>
              </div>
              {result.backupPaths.map((p, i) => (
                <div key={i} style={{ fontSize: 10, color: colors.textTertiary, marginLeft: 18, fontFamily: 'monospace', wordBreak: 'break-all' }}>
                  {p}
                </div>
              ))}
            </div>
          )}

          <div style={{ fontSize: 11, color: colors.textTertiary, marginTop: 8, textAlign: 'center' }}>
            Restart the app to see migrated tabs in your current session.
          </div>
        </div>
      )}
    </>
  )
}
