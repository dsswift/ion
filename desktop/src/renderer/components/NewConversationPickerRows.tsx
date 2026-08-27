import React from 'react'
import { Folder, FolderOpen, FolderSimple, GitBranch, Plus } from '@phosphor-icons/react'
import { useColors } from '../theme'
import type { EngineDirListing, EngineProfile, WorktreeInventoryEntry } from '../../shared/types'
import type { EffectiveProjectEntry } from '../../shared/project-registry'

export function ProjectRows({ projects, highlighted, colors, onHover, onChoose }: { projects: readonly EffectiveProjectEntry[]; highlighted: number; colors: ReturnType<typeof useColors>; onHover(index: number): void; onChoose(path: string): void }): React.JSX.Element {
  if (projects.length === 0) return <PickerMessage colors={colors} message="No loaded projects match this search." />
  return <><PickerSection colors={colors} label="Projects" />{projects.map((project, index) => <PickerRow key={project.dir} active={index === highlighted} colors={colors} icon={<Folder size={16} />} title={project.displayName} detail={project.managed ? `Managed · ${project.dir}` : project.dir} onMouseEnter={() => onHover(index)} onClick={() => onChoose(project.dir)} />)}</>
}

export function DirectoryRows({ loading, error, listing, names, selectedDirectory, highlighted, colors, onHover, onChooseDirectory, onChooseEntry }: { loading: boolean; error: string | null; listing: EngineDirListing | null; names: string[]; selectedDirectory: string | null; highlighted: number; colors: ReturnType<typeof useColors>; onHover(index: number): void; onChooseDirectory(): void; onChooseEntry(name: string): void }): React.JSX.Element {
  if (loading) return <PickerMessage colors={colors} message="Loading directories…" />
  if (error) return <PickerMessage colors={colors} message={`Could not load directories: ${error}`} />
  if (!listing) return <PickerMessage colors={colors} message="Enter an absolute path or ~/ path." />
  let index = 0
  return <><PickerSection colors={colors} label={listing.path} />{selectedDirectory && <PickerRow active={index++ === highlighted} colors={colors} icon={<Plus size={16} />} title="Add and use this directory" detail={selectedDirectory} onMouseEnter={() => onHover(0)} onClick={onChooseDirectory} />}{names.map((name) => { const current = index++; return <PickerRow key={name} active={current === highlighted} colors={colors} icon={<FolderOpen size={16} />} title={name} onMouseEnter={() => onHover(current)} onClick={() => onChooseEntry(name)} /> })}{names.length === 0 && !selectedDirectory && <PickerMessage colors={colors} message="No matching directories." />}{listing.truncated && <PickerMessage colors={colors} message="Directory list is truncated. Type more of the path." />}</>
}

export function WorkspaceRows({ repoPath, worktrees, canCreateWorktree, highlighted, loading, error, colors, onHover, onSource, onWorktree, onNewWorktree }: { repoPath: string; worktrees: readonly WorktreeInventoryEntry[]; canCreateWorktree: boolean; highlighted: number; loading: boolean; error: string | null; colors: ReturnType<typeof useColors>; onHover(index: number): void; onSource(): void; onWorktree(entry: WorktreeInventoryEntry): void; onNewWorktree(): void }): React.JSX.Element {
  if (loading) return <PickerMessage colors={colors} message="Loading worktrees…" />
  return <><PickerSection colors={colors} label="Choose workspace" />{error && <PickerMessage colors={colors} message={`Could not load worktrees: ${error}`} />}<PickerRow active={highlighted === 0} colors={colors} icon={<FolderSimple size={16} />} title="Source repository" detail={repoPath} onMouseEnter={() => onHover(0)} onClick={onSource} />{worktrees.map((entry, index) => <PickerRow key={entry.worktreePath} active={highlighted === index + 1} colors={colors} icon={<GitBranch size={16} />} title={entry.title || entry.label} detail={`${entry.branchName} · ${entry.worktreePath}`} onMouseEnter={() => onHover(index + 1)} onClick={() => onWorktree(entry)} />)}{canCreateWorktree && <PickerRow active={highlighted === worktrees.length + 1} colors={colors} icon={<Plus size={16} />} title="Create a new worktree" detail="Choose a source branch" onMouseEnter={() => onHover(worktrees.length + 1)} onClick={onNewWorktree} />}</>
}

export function BranchRows({ branches, highlighted, loading, error, currentBranch, colors, onHover, onChoose }: { branches: readonly string[]; highlighted: number; loading: boolean; error: string | null; currentBranch: string; colors: ReturnType<typeof useColors>; onHover(index: number): void; onChoose(branch: string): void }): React.JSX.Element {
  if (loading) return <PickerMessage colors={colors} message="Loading branches…" />
  if (error) return <PickerMessage colors={colors} message={`Could not load branches: ${error}`} />
  if (branches.length === 0) return <PickerMessage colors={colors} message="No branches match this search." />
  return <><PickerSection colors={colors} label="Choose source branch" />{branches.map((branch, index) => <PickerRow key={branch} active={highlighted === index} colors={colors} icon={<GitBranch size={16} />} title={branch} detail={branch === currentBranch ? 'Current branch' : undefined} onMouseEnter={() => onHover(index)} onClick={() => onChoose(branch)} />)}</>
}

export function ProfileRows({ profiles, highlighted, colors, onHover, onPlain, onProfile }: { profiles: EngineProfile[]; highlighted: number; colors: ReturnType<typeof useColors>; onHover(index: number): void; onPlain(): void; onProfile(profileId: string): void }): React.JSX.Element {
  return <><PickerSection colors={colors} label="Choose conversation type" /><PickerRow active={highlighted === 0} colors={colors} icon={<Folder size={16} />} title="Plain conversation" detail="No extensions" onMouseEnter={() => onHover(0)} onClick={onPlain} />{profiles.map((profile, index) => <PickerRow key={profile.id} active={highlighted === index + 1} colors={colors} icon={<Folder size={16} />} title={profile.name} detail={profile.extensions.map((extension) => extension.split('/').slice(-2).join('/')).join(', ')} onMouseEnter={() => onHover(index + 1)} onClick={() => onProfile(profile.id)} />)}{profiles.length === 0 && <PickerMessage colors={colors} message="No conversation profiles match this search." />}</>
}

export function PickerRow({ active, colors, icon, title, detail, onMouseEnter, onClick }: { active: boolean; colors: ReturnType<typeof useColors>; icon: React.ReactNode; title: string; detail?: string; onMouseEnter(): void; onClick(): void }): React.JSX.Element {
  return <button className="ion-focusable" onMouseEnter={onMouseEnter} onClick={onClick} style={{ display: 'flex', alignItems: 'center', width: '100%', gap: 10, padding: '8px 10px', border: 'none', borderRadius: 6, background: active ? colors.tabActive : 'transparent', color: colors.textPrimary, cursor: 'pointer', textAlign: 'left' }}><span style={{ color: colors.textTertiary, display: 'flex' }}>{icon}</span><span style={{ minWidth: 0, flex: 1 }}><span style={{ display: 'block', fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title}</span>{detail && <span style={{ display: 'block', color: colors.textTertiary, fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{detail}</span>}</span></button>
}

export function PickerSection({ colors, label }: { colors: ReturnType<typeof useColors>; label: string }): React.JSX.Element { return <div style={{ padding: '4px 10px 6px', color: colors.textTertiary, fontSize: 11, fontWeight: 600 }}>{label}</div> }
export function PickerMessage({ colors, message }: { colors: ReturnType<typeof useColors>; message: string }): React.JSX.Element { return <div style={{ padding: '14px 10px', color: colors.textTertiary, fontSize: 12 }}>{message}</div> }
