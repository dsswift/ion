/**
 * HealthPage — how busy a server's host is and what Ion uses on it, live
 * while the page is open: host CPU, memory, and disk; every Ion process by
 * role; the developer tools the host has (so a setup that will fail is
 * explained before it runs); telemetry delivery; and the tail of the two
 * logs.
 *
 * On the local server this device's Studio processes join the process list,
 * because they run on the same host. On a remote one they are a separate
 * list, so a laptop's load is never read as the server's.
 */
import React, { useState } from 'react'
import type { EnvironmentLogFile } from '@ion/shared/types-environment-admin'
import type { TelemetryHealthState } from '@ion/shared/types-telemetry-health'
import { environmentClient, useEnvironmentResource } from '../environment/environment-client'
import { useEnvironmentSystemMetrics, useDeviceMetrics, useTelemetryHealth, useLiveCpuSeries } from '../environment/system-metrics-client'
import { useSettingsEnvironment } from '../settings-servers'
import { useColors } from '../../../theme'
import { Button, CellText, Chip, DataList, ErrorText, FormGroup, FormRow, KIT, Muted, SidePanel, Stack, StatusDot, type DataColumn } from '../kit'
import { rInfo, rWarn } from '../../../rendererLogger'
import { MetricsStrip, formatBytes, pct, processRows, type ProcessRow } from './health-metrics'
import { RenderTimingList } from './health-spans'

export function HealthPage(): React.JSX.Element {
  const env = useSettingsEnvironment()
  const metrics = useEnvironmentSystemMetrics(env.id)
  const device = useDeviceMetrics()
  const telemetry = useTelemetryHealth(env.id)
  const live = useLiveCpuSeries(metrics.latest)
  const deviceRows = device?.processes ?? null
  const rows = metrics.latest ? processRows(metrics.latest.processes, env.isLocal ? deviceRows : null) : []

  return (
    <Stack gap={20}>
      <FormGroup title="System metrics" anchor="metrics">
        {metrics.latest
          ? <MetricsStrip m={metrics.latest} history={metrics.history} live={live} />
          : <FormRow label={metrics.error ? 'Metrics unavailable' : 'Waiting for the first sample…'} description={metrics.error ? <ErrorText>{metrics.error}</ErrorText> : undefined} />}
      </FormGroup>
      <ProcessList label="Processes" rows={rows} showGpu={env.isLocal && deviceRows != null} loading={!metrics.latest && !metrics.error} />
      {!env.isLocal && device && <ProcessList label="This device" rows={processRows([], device.processes)} showGpu loading={false} />}
      {env.isLocal && <RenderTimingList />}
      <HostTools />
      <TelemetryGroup targets={telemetry} />
      <LogsGroup />
    </Stack>
  )
}

function ProcessList({ label, rows, showGpu, loading }: { label: string; rows: ProcessRow[]; showGpu: boolean; loading: boolean }): React.JSX.Element {
  const columns: Array<DataColumn<ProcessRow>> = [
    { id: 'role', header: 'Role', width: '84px', render: (r) => <Muted>{r.role}</Muted> },
    { id: 'name', header: 'Name', width: 'minmax(0, 1fr)', render: (r) => <CellText>{r.name}</CellText> },
    { id: 'cpu', header: 'CPU', width: '56px', align: 'end', render: (r) => pct(r.cpuPercent) },
    { id: 'memory', header: 'Memory', width: '72px', align: 'end', render: (r) => formatBytes(r.rssBytes) },
  ]
  if (showGpu) columns.push({ id: 'gpu', header: 'GPU', width: '48px', align: 'end', render: (r) => (r.role === 'studio' ? pct(r.gpuPercent ?? null) : '') })
  return (
    <DataList
      label={label}
      title={label}
      items={rows}
      getKey={(r) => r.key}
      columns={columns}
      noun={['process', 'processes']}
      filter={(r, q) => r.name.toLowerCase().includes(q) || r.role.includes(q)}
      loading={loading}
      showHeader
    />
  )
}

function HostTools(): React.JSX.Element {
  const env = useSettingsEnvironment()
  const tools = useEnvironmentResource(env.id, environmentClient.toolchains)
  const list = tools.data?.tools ?? []
  const missing = list.some((t) => !t.path)
  return (
    <DataList
      label="Tools on the host"
      title="Tools on the host"
      description={missing ? 'A project setup that needs a missing tool will fail there until it is installed on the host.' : undefined}
      anchor="host-tools"
      items={list}
      getKey={(t) => t.name}
      loading={tools.loading}
      columns={[
        { id: 'name', render: (t) => <><StatusDot tone={t.path ? 'ok' : 'error'} label={t.path ? 'installed' : 'missing'} /><span>{t.name}</span></> },
        { id: 'version', width: 'minmax(0, 1fr)', render: (t) => <CellText muted>{t.version ? t.version.replace(/^(git|go) version /, '') : t.path ? '' : 'missing'}</CellText> },
      ]}
      empty={<FormRow label={tools.error ? `Could not probe the host: ${tools.error}` : 'No tools reported.'} />}
    />
  )
}

function TelemetryGroup({ targets }: { targets: TelemetryHealthState[] }): React.JSX.Element | null {
  if (targets.length === 0) return null
  return (
    <FormGroup title="Telemetry delivery" anchor="telemetry">
      {targets.map((t) => (
        <FormRow key={t.target} label={t.target} description={t.queuedEvents > 0 ? `${t.queuedEvents} queued · ${formatBytes(t.queuedBytes)}` : undefined}>
          <Chip tone={t.critical ? 'error' : t.stuck || !t.healthy ? 'warn' : 'ok'}>{t.critical ? 'critical' : t.stuck ? 'stuck' : t.healthy ? 'delivering' : 'backlogged'}</Chip>
        </FormRow>
      ))}
    </FormGroup>
  )
}

const LOG_LINES = 200

function LogsGroup(): React.JSX.Element {
  const env = useSettingsEnvironment()
  const [file, setFile] = useState<EnvironmentLogFile | null>(null)
  return (
    <>
      <FormGroup title="Logs" description={`The last ${LOG_LINES} lines of each log on ${env.label}.`} anchor="logs">
        <FormRow label="engine.jsonl" description="The engine's log."><Button onClick={() => setFile('engine')}>View</Button></FormRow>
        <FormRow label="server.jsonl" description="The Studio server's log."><Button onClick={() => setFile('server')}>View</Button></FormRow>
      </FormGroup>
      {file && <LogPanel key={file} file={file} onClose={() => setFile(null)} />}
    </>
  )
}

function LogPanel({ file, onClose }: { file: EnvironmentLogFile; onClose(): void }): React.JSX.Element {
  const env = useSettingsEnvironment()
  const colors = useColors()
  const log = useEnvironmentResource(env.id, (id) => {
    rInfo('server-section', 'log tail requested', { environment_id: id, file })
    return environmentClient.logTail(id, file, LOG_LINES).catch((err: unknown) => {
      rWarn('server-section', 'log tail failed', { environment_id: id, file, error: String(err) })
      throw err
    })
  }, [file])
  return (
    <SidePanel
      open
      title={`${file}.jsonl`}
      subtitle={log.data ? log.data.path : `The last ${LOG_LINES} lines on ${env.label}.`}
      onClose={onClose}
      footer={<Button disabled={log.loading} onClick={log.refresh}>Reload</Button>}
    >
      <ErrorText>{log.error}</ErrorText>
      <pre aria-label={`${file} log tail`} style={{ margin: 0, fontFamily: KIT.mono, fontSize: KIT.fontTiny, color: colors.textSecondary, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', lineHeight: 1.5 }}>
        {log.data ? (log.data.lines.length > 0 ? log.data.lines.join('\n') : `(${log.data.path} is empty)`) : log.error ? '' : 'Loading…'}
      </pre>
    </SidePanel>
  )
}
