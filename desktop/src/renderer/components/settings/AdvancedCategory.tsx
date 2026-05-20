import React from 'react'
import { SettingHeading } from './SettingHeading'
import { PresetsCategory } from './PresetsCategory'
import { MigrationCategory } from './MigrationCategory'
import { DeveloperCategory } from './DeveloperCategory'

export function AdvancedCategory() {
  return (
    <>
      <SettingHeading first>Presets</SettingHeading>
      <PresetsCategory />
      <MigrationCategory />
      <DeveloperCategory />
    </>
  )
}
