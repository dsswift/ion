/** Build the default filename for an exported Studio plan. */
export function planExportFileName(filePath: string, exportedAt: Date): string {
  const sourceName = filePath.split(/[\\/]/).pop() || 'plan.md'
  const baseName = sourceName.replace(/\.md$/i, '') || 'plan'
  const two = (value: number): string => String(value).padStart(2, '0')
  const date = `${exportedAt.getFullYear()}${two(exportedAt.getMonth() + 1)}${two(exportedAt.getDate())}`
  const time = `${two(exportedAt.getHours())}${two(exportedAt.getMinutes())}`
  return `${baseName}-${date}-${time}.md`
}
