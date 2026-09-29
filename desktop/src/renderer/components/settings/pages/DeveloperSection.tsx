/**
 * DeveloperSection — tools for testing Ion itself. Simulate update drives
 * the same path a real electron-updater notification takes: the update icon
 * appears in the input bar and the install dialog opens.
 */
import React, { useState } from 'react'
import { useUpdateStore } from '@ion/server/store/update-store'
import { Button, FormGroup, FormRow, MonoLine, SidePanel, Stack } from '../kit'

export function DeveloperSection(): React.JSX.Element {
  const version = useUpdateStore((s) => s.version)
  const dialogOpen = useUpdateStore((s) => s.dialogOpen)
  const [inspecting, setInspecting] = useState(false)
  return (
    <>
      <FormGroup title="Developer" anchor="simulate-update">
        <FormRow label="Simulate update downloaded" description="Runs the real update-downloaded path: the update icon appears in the input bar and the install dialog opens.">
          {version && <Button variant="ghost" onClick={() => useUpdateStore.setState({ version: null, dialogOpen: false })}>Clear</Button>}
          <Button onClick={() => useUpdateStore.getState().setAvailable('9.9.9-dev')}>Simulate Update</Button>
        </FormRow>
        <FormRow label="Update store state" description={version ? `Update ${version} pending` : 'No update pending'}>
          <Button onClick={() => setInspecting(true)}>Inspect</Button>
        </FormRow>
      </FormGroup>
      <SidePanel open={inspecting} title="Update store state" onClose={() => setInspecting(false)}>
        <Stack gap={6}>
          <MonoLine>{`version: ${version ?? 'null'}`}</MonoLine>
          <MonoLine>{`dialogOpen: ${String(dialogOpen)}`}</MonoLine>
        </Stack>
      </SidePanel>
    </>
  )
}
