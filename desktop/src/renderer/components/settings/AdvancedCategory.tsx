import React from 'react'
import { SettingHeading } from './SettingHeading'
import { PresetsCategory } from './PresetsCategory'
import { BackupRestoreCategory } from './BackupRestoreCategory'
import { DeveloperCategory } from './DeveloperCategory'

export function AdvancedCategory() {
  return (
    <>
      <SettingHeading first>Presets</SettingHeading>
      <PresetsCategory />
      <BackupRestoreCategory />
      <DeveloperCategory />
    </>
  )
}
