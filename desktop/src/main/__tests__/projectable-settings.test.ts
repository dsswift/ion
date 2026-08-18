// Tests for the projectable-settings allowlist and validation helpers.
// Three layers:
//
//   1. Structural integrity. Every entry on the allowlist must point at a
//      real key on either SETTINGS_DEFAULTS (main-process) or the
//      renderer-side SETTINGS_DEFAULTS map. Without this, a future
//      settings rename could silently break iOS projection because the
//      handler would still emit the (now-orphan) key but the desktop
//      would never write it.
//
//   2. Validation. The allowlist must reject unknown keys and wrong-type
//      values without raising — the handler's contract is "silent log +
//      no write" on bad input. Covers every type: boolean, string,
//      number, enum (static + dynamic), list.
//
//   3. Schema projection. The schema returned over the wire must mirror
//      the allowlist, must inject dynamic choices for the three tab-
//      group pointer keys, and must self-heal stale group references
//      in `projectCurrentSettings`.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock Electron's `app` and `safeStorage` before the import chain reaches
// settings-store → utils/secretStore (which imports from 'electron' at
// module-load). CI runs `npm ci --ignore-scripts`, so Electron's binary
// download postinstall is skipped — without this stub, the real
// node_modules/electron/index.js throws "Electron failed to install
// correctly" the moment the module graph is loaded and the test suite
// fails before any test body runs. Same idiom as secret-store.test.ts and
// ipc-session-prompt.test.ts.
vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return false
    },
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString(),
  },
}))

// The plan-mode Bash allowlist is engine-config-backed: projectCurrentSettings
// reads it via plan-bash-allowlist-store (engine.json), not settings.json.
// Mock the store so the projection is hermetic — returns [] by default,
// matching the projectable entry's opinionless default. Individual tests
// override readPlanBashAllowlist when they assert on the value.
const planBashMock = vi.hoisted(() => ({
  readPlanBashAllowlist: vi.fn(() => [] as string[]),
}))
vi.mock('../plan-bash-allowlist-store', () => ({
  readPlanBashAllowlist: () => planBashMock.readPlanBashAllowlist(),
  writePlanBashAllowlist: vi.fn(),
}))

// Enterprise theme policy: mocked so the projection tests control the lock
// without importing the full main-process state module (theme-policy reads
// the startup policy cache, which is irrelevant to allowlist mechanics).
const themePolicyMock = vi.hoisted(() => ({
  getEnterpriseThemePolicy: vi.fn(
    (): { themeId: string; locked: boolean } | null => null,
  ),
}))
vi.mock('../theme-policy', () => ({
  getEnterpriseThemePolicy: () => themePolicyMock.getEnterpriseThemePolicy(),
  isThemeLocked: () =>
    themePolicyMock.getEnterpriseThemePolicy()?.locked === true,
}))

import {
  PROJECTABLE_SETTINGS,
  PROJECTABLE_GROUP_ORDER,
  PROJECTABLE_GROUP_LABELS,
  isProjectableKey,
  projectableKeysWithoutDefault,
  projectCurrentSettings,
  projectableSchema,
  projectableGroups,
} from '../projectable-settings'
import * as settingsStore from '../settings-store'
import { resetThemePacksForTest } from '../theme-packs'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { DesktopSettingsSchemaEntry } from '../remote/protocol'

// selectedTheme validation + schema choices consult the live theme-pack
// registry (fs scan). Point both roots at hermetic temp dirs so the
// developer's real ~/.ion/themes never leaks into assertions. The
// theme-specific behavior tests (custom-pack validation, schema choices,
// enterprise lock) live in projectable-settings-theme.test.ts (cap split).
let themesUserRoot: string
let themesSystemRoot: string

beforeEach(() => {
  themesUserRoot = mkdtempSync(join(tmpdir(), 'ion-proj-themes-user-'))
  themesSystemRoot = mkdtempSync(join(tmpdir(), 'ion-proj-themes-system-'))
  resetThemePacksForTest({ user: themesUserRoot, system: themesSystemRoot })
  themePolicyMock.getEnterpriseThemePolicy.mockReturnValue(null)
})

afterEach(() => {
  resetThemePacksForTest()
  rmSync(themesUserRoot, { recursive: true, force: true })
  rmSync(themesSystemRoot, { recursive: true, force: true })
})

describe('projectable-settings allowlist', () => {
  it('every entry has a non-empty key, label, and description', () => {
    for (const entry of PROJECTABLE_SETTINGS) {
      expect(entry.key, `entry ${entry.key}: key`).toBeTruthy()
      expect(entry.label, `entry ${entry.key}: label`).toBeTruthy()
      expect(entry.description, `entry ${entry.key}: description`).toBeTruthy()
    }
  })

  it('every entry declares a recognized type', () => {
    const valid = new Set(['boolean', 'string', 'number', 'enum', 'list'])
    for (const entry of PROJECTABLE_SETTINGS) {
      expect(
        valid.has(entry.type),
        `entry ${entry.key}: type=${entry.type}`,
      ).toBe(true)
    }
  })

  it('every entry has a defaultValue matching its declared type', () => {
    // Per-type rules. Enum defaults may be null (the "None" choice for
    // nullable enums like the dynamic group-id pointers) or a string
    // that appears in the static `choices` array (for fixed enums).
    // List defaults must be arrays. The other three are strict typeof
    // matches.
    for (const entry of PROJECTABLE_SETTINGS) {
      switch (entry.type) {
        case 'boolean':
        case 'string':
        case 'number':
          expect(
            typeof entry.defaultValue,
            `entry ${entry.key}: defaultValue type`,
          ).toBe(entry.type)
          break
        case 'enum': {
          // null is allowed; otherwise must be a string in the choices.
          if (entry.defaultValue === null) {
            expect(
              entry.choices?.some((c) => c.value === null),
              `entry ${entry.key}: nullable enum needs a null choice`,
            ).toBe(true)
          } else {
            expect(
              typeof entry.defaultValue,
              `entry ${entry.key}: enum default must be string`,
            ).toBe('string')
            expect(
              entry.choices?.some((c) => c.value === entry.defaultValue),
              `entry ${entry.key}: default ${entry.defaultValue} not in choices`,
            ).toBe(true)
          }
          break
        }
        case 'list':
          expect(
            Array.isArray(entry.defaultValue),
            `entry ${entry.key}: list default must be array`,
          ).toBe(true)
          // A list entry MUST carry exactly one of itemSchema (record-list)
          // or itemType (primitive-list) — never both, never neither. The
          // iOS view layer dispatches on this to pick the right editor
          // (record-list pushes a per-record editor screen; primitive-list
          // renders flat inline rows).
          {
            const hasSchema = !!entry.itemSchema
            const hasItemType = !!entry.itemType
            expect(
              hasSchema || hasItemType,
              `entry ${entry.key}: list requires itemSchema or itemType`,
            ).toBe(true)
            expect(
              hasSchema && hasItemType,
              `entry ${entry.key}: list must not have both itemSchema and itemType`,
            ).toBe(false)
            // When itemType is set, validate every default-array element
            // matches the declared primitive type so the projection is
            // self-consistent (we'd otherwise ship a bad default to iOS).
            if (hasItemType) {
              const expected = entry.itemType
              for (const elem of entry.defaultValue as unknown[]) {
                expect(
                  typeof elem,
                  `entry ${entry.key}: default element must be ${expected}`,
                ).toBe(expected)
              }
            }
          }
          break
      }
    }
  })

  it('keys are unique across the allowlist', () => {
    const seen = new Set<string>()
    for (const entry of PROJECTABLE_SETTINGS) {
      expect(seen.has(entry.key), `duplicate key: ${entry.key}`).toBe(false)
      seen.add(entry.key)
    }
  })

  it('every key has a corresponding entry in some SETTINGS_DEFAULTS map', () => {
    // projectableKeysWithoutDefault returns the list of keys that point
    // at neither the main-process SETTINGS_DEFAULTS nor the renderer
    // one. A non-empty list means an entry has been added to the
    // allowlist without a matching defaults source — the iOS UI would
    // render the row but the desktop's writeSettings call would create
    // a phantom key that no consumer reads.
    const orphans = projectableKeysWithoutDefault()
    expect(orphans, `keys with no defaults: ${orphans.join(', ')}`).toEqual([])
  })

  it('every entry declares a known group (in PROJECTABLE_GROUP_LABELS)', () => {
    // The group must be a RECOGNIZED group — one with a label — not
    // necessarily a PROJECTED one. Some entries (e.g. keyboardShortcuts under
    // 'advanced') are intentionally allowlisted for validation/enterprise
    // deployment but deliberately kept OUT of PROJECTABLE_GROUP_ORDER because
    // iOS has no editing surface for them. Such an entry has a valid group
    // (with a label) but is never projected — that is by design, documented at
    // the keyboardShortcuts entry in projectable-settings-data.ts. Validating
    // against the label set (not the projected order) catches a genuinely bogus
    // group while permitting the intentional non-projected case.
    const knownGroups = new Set(Object.keys(PROJECTABLE_GROUP_LABELS))
    for (const entry of PROJECTABLE_SETTINGS) {
      expect(
        knownGroups.has(entry.group as string),
        `entry ${entry.key} group=${entry.group}`,
      ).toBe(true)
    }
  })

  it('every group in PROJECTABLE_GROUP_ORDER has at least one entry', () => {
    // Empty sections render as a header with no rows, which looks
    // broken on iOS. Catching empty groups here forces a deliberate
    // group removal rather than leaving a dead section name behind
    // after the last entry is moved out.
    const groupsWithEntries = new Set(PROJECTABLE_SETTINGS.map((s) => s.group))
    for (const group of PROJECTABLE_GROUP_ORDER) {
      expect(
        groupsWithEntries.has(group as any),
        `group ${group} has no entries`,
      ).toBe(true)
    }
  })

  it('every group in PROJECTABLE_GROUP_ORDER has a label', () => {
    for (const group of PROJECTABLE_GROUP_ORDER) {
      expect(
        PROJECTABLE_GROUP_LABELS[group],
        `group ${group} label`,
      ).toBeTruthy()
    }
  })

  it('group IDs match the desktop SettingsDialog categories', () => {
    // The iOS Desktop Settings view mirrors the desktop's own
    // Settings dialog categories 1:1. Locking the IDs here means a
    // desktop rename of one of these categories triggers this test —
    // forcing the projection groups to be kept in sync.
    const expected = new Set([
      'general',
      'ai',
      'appearance',
      'tabs',
      'git',
      'quicktools',
      'notifications',
    ])
    const actual = new Set<string>(projectableGroups().map((group) => group.id))
    expect(actual.size).toBeGreaterThan(0)
    for (const group of actual) expect(expected).toContain(group)
  })

  it('projects streamThinkingToRemote as a default-on boolean in the General group (issue #158)', () => {
    // Low-bandwidth mode facet 1. The setting MUST be projected so iOS
    // can see/toggle it (the desktop UI lives in the Remote category, but
    // `remote` is not on the iOS allowlist — pairing/transport is iOS-
    // local — so the iOS-visible home is General). Default ON: the phone
    // receives the reasoning stream unless the user opts out.
    const entry = PROJECTABLE_SETTINGS.find(
      (s) => s.key === 'streamThinkingToRemote',
    )
    expect(
      entry,
      'streamThinkingToRemote must be on the allowlist',
    ).toBeTruthy()
    expect(entry?.type).toBe('boolean')
    expect(entry?.group).toBe('general')
    expect(entry?.defaultValue).toBe(true)
    // The group must be a real, projected group (general is in the order).
    expect(PROJECTABLE_GROUP_ORDER).toContain(entry!.group)
  })
})

describe('projectableSchema / projectableGroups', () => {
  let readSettingsSpy: any

  beforeEach(() => {
    readSettingsSpy = vi.spyOn(settingsStore, 'readSettings')
    readSettingsSpy.mockReturnValue({})
  })

  afterEach(() => {
    readSettingsSpy.mockRestore()
  })

  it('schema mirrors the allowlist in order and field shape', () => {
    const schema = projectableSchema()
    const visible = PROJECTABLE_SETTINGS.filter(
      (setting) => setting.iosSurface !== 'desktop-only',
    )
    expect(schema.length).toBe(visible.length)
    for (let i = 0; i < schema.length; i++) {
      expect(schema[i].key).toBe(visible[i].key)
      expect(schema[i].type).toBe(visible[i].type)
      expect(schema[i].group).toBe(visible[i].group)
      expect(schema[i].label).toBe(visible[i].label)
      expect(schema[i].description).toBe(visible[i].description)
      expect(schema[i].defaultValue).toBe(visible[i].defaultValue)
    }
  })

  it('groups returns the ordered list of { id, label } descriptors', () => {
    const groups = projectableGroups()
    const visibleGroups = PROJECTABLE_GROUP_ORDER.filter((group) =>
      PROJECTABLE_SETTINGS.some(
        (setting) =>
          setting.group === group && setting.iosSurface !== 'desktop-only',
      ),
    )
    expect(groups.map((group) => group.id)).toEqual(visibleGroups)
    for (const group of groups) {
      expect(group.label).toBe(PROJECTABLE_GROUP_LABELS[group.id])
    }
  })

  it('static enum entries carry their declared choices verbatim', () => {
    // defaultPermissionMode is a static enum with two values; verify its
    // choices ride through to the wire schema unchanged.
    const schema = projectableSchema()
    const entry = schema.find((e) => e.key === 'defaultPermissionMode')
    expect(entry?.choices).toEqual([
      { value: 'plan', label: 'Plan' },
      { value: 'auto', label: 'Auto' },
    ])
  })

  it('list entries carry their itemSchema', () => {
    // tabGroups and quickTools are list-typed; the iOS list editor
    // needs the per-record itemSchema to render fields. tabGroups
    // includes `order` and `collapsed` so iOS can synthesize them
    // for new records and round-trip them on edits; these are not
    // rendered as editable rows (the editor uses a hidden-keys
    // skip set).
    const schema = projectableSchema()
    const tabGroups = schema.find((e) => e.key === 'tabGroups')
    expect(tabGroups?.itemSchema, 'tabGroups itemSchema').toBeTruthy()
    expect(tabGroups?.itemSchema?.map((f) => f.key)).toEqual([
      'id',
      'label',
      'isDefault',
      'order',
      'collapsed',
    ])
    const quickTools = schema.find((e) => e.key === 'quickTools')
    expect(quickTools?.itemSchema, 'quickTools itemSchema').toBeTruthy()
    expect(quickTools?.itemSchema?.map((f) => f.key)).toEqual([
      'id',
      'name',
      'icon',
      'command',
    ])
  })

  it('primitive-list entries carry their itemType (not itemSchema)', () => {
    // planModeAllowedBashCommands is the first primitive-list setting:
    // type: 'list', itemType: 'string', defaultValue: [] (opinionless — the
    // engine ships no built-in allowlist; unset means Bash blocked in plan
    // mode). The wire schema must carry itemType so iOS dispatches to the
    // flat primitive editor instead of the record-list editor.
    const schema = projectableSchema()
    const cmds = schema.find((e) => e.key === 'planModeAllowedBashCommands')
    expect(cmds, 'planModeAllowedBashCommands entry').toBeTruthy()
    expect(cmds?.type).toBe('list')
    expect(cmds?.itemType).toBe('string')
    expect(cmds?.itemSchema).toBeUndefined()
    expect(cmds?.defaultValue).toEqual([])
  })

  it('round-trips primitive-list itemType through DesktopSettingsSchemaEntry', () => {
    // Contextual wire typing makes this fail if protocol.ts stops declaring
    // itemType, while the runtime assertion pins schema serialization.
    const wireSchema: DesktopSettingsSchemaEntry[] = projectableSchema().map(
      (entry): DesktopSettingsSchemaEntry => ({
        ...entry,
        itemType: entry.itemType,
      }),
    )
    const cmds = wireSchema.find(
      (entry) => entry.key === 'planModeAllowedBashCommands',
    )
    expect(cmds?.itemType).toBe('string')
  })

  it('range is carried through for number entries that declare one', () => {
    const schema = projectableSchema()
    expect(schema.find((e) => e.key === 'uiZoom')).toBeUndefined()
  })

  it('dynamic group-id enums inject the current tabGroups as choices', () => {
    // Seed settings.json with two tab groups; the three pointer keys
    // (planning/inProgress/done) should each get a choices array of
    // [None, group1, group2].
    readSettingsSpy.mockReturnValue({
      tabGroups: [
        { id: 'g1', label: 'Backlog', order: 0 },
        { id: 'g2', label: 'Active', order: 1 },
      ],
    })
    const schema = projectableSchema()
    const planning = schema.find((e) => e.key === 'planningGroupId')
    expect(planning?.choices).toEqual([
      { value: null, label: 'None' },
      { value: 'g1', label: 'Backlog' },
      { value: 'g2', label: 'Active' },
    ])
    const inProgress = schema.find((e) => e.key === 'inProgressGroupId')
    expect(inProgress?.choices?.map((c) => c.value)).toEqual([null, 'g1', 'g2'])
    const done = schema.find((e) => e.key === 'doneGroupId')
    expect(done?.choices?.map((c) => c.value)).toEqual([null, 'g1', 'g2'])
  })

  it('dynamic group-id enums fall back to just None when no tabGroups exist', () => {
    readSettingsSpy.mockReturnValue({}) // no tabGroups field
    const schema = projectableSchema()
    const planning = schema.find((e) => e.key === 'planningGroupId')
    expect(planning?.choices).toEqual([{ value: null, label: 'None' }])
  })
})

describe('isProjectableKey', () => {
  it('returns true for every allowlisted key', () => {
    for (const entry of PROJECTABLE_SETTINGS) {
      expect(isProjectableKey(entry.key)).toBe(true)
    }
  })

  it('returns false for an unknown key', () => {
    expect(isProjectableKey('not_a_real_setting')).toBe(false)
  })

  it('returns false for a Settings field that is intentionally NOT projected', () => {
    // `defaultBaseDirectory` lives in the renderer SETTINGS_DEFAULTS but
    // is intentionally excluded from the allowlist (it's a local-fs
    // path that has no meaning on iOS). Same for relayApiKey
    // (secret), terminalFontFamily (local font), and pairedDevices
    // (transport state). A future change projecting any of these
    // would fail this test and force a deliberate review.
    expect(isProjectableKey('defaultBaseDirectory')).toBe(false)
    expect(isProjectableKey('relayApiKey')).toBe(false)
    expect(isProjectableKey('terminalFontFamily')).toBe(false)
    expect(isProjectableKey('pairedDevices')).toBe(false)
    expect(isProjectableKey('preferredModel')).toBe(false)
    expect(isProjectableKey('engineDefaultModel')).toBe(false)
  })
})

describe('projectCurrentSettings', () => {
  let readSettingsSpy: any

  beforeEach(() => {
    readSettingsSpy = vi.spyOn(settingsStore, 'readSettings')
  })

  afterEach(() => {
    readSettingsSpy.mockRestore()
  })

  it('returns the persisted value when settings.json carries one', () => {
    // Flip a representative boolean to its non-default and verify the
    // projection picks it up. enableEarlyStopContinuation defaults to
    // false; persist true; expect true.
    readSettingsSpy.mockReturnValue({ enableEarlyStopContinuation: true })
    const out = projectCurrentSettings()
    expect(out.enableEarlyStopContinuation).toBe(true)
  })

  it('does not include non-projectable keys even if settings.json carries them', () => {
    // settings.json typically carries dozens of keys; the projection
    // must filter to only the allowlist. A non-projectable key
    // (relayApiKey, a path, a font) must not leak.
    readSettingsSpy.mockReturnValue({
      enableEarlyStopContinuation: true,
      relayApiKey: 'secret-key',
      defaultBaseDirectory: '/Users/me/work',
      terminalFontFamily: 'Custom Font',
    })
    const out = projectCurrentSettings()
    expect(out).not.toHaveProperty('relayApiKey')
    expect(out).not.toHaveProperty('defaultBaseDirectory')
    expect(out).not.toHaveProperty('terminalFontFamily')
  })

  it('self-heals stale group-id pointers to None when the referenced group no longer exists', () => {
    // Settings say planningGroupId points at g-deleted, but only g-live
    // exists in tabGroups. The projection should surface
    // planningGroupId as null (the "None" choice) without touching the
    // on-disk value (the user might rename the group back).
    readSettingsSpy.mockReturnValue({
      tabGroups: [{ id: 'g-live', label: 'Live', order: 0 }],
      planningGroupId: 'g-deleted',
      inProgressGroupId: 'g-live',
      doneGroupId: 'g-also-deleted',
    })
    const out = projectCurrentSettings()
    expect(out.planningGroupId).toBeNull()
    expect(out.inProgressGroupId).toBe('g-live')
    expect(out.doneGroupId).toBeNull()
  })

  it('leaves null group-id pointers untouched', () => {
    readSettingsSpy.mockReturnValue({
      tabGroups: [{ id: 'g1', label: 'G1', order: 0 }],
      planningGroupId: null,
    })
    const out = projectCurrentSettings()
    expect(out.planningGroupId).toBeNull()
  })

  it('includes list-typed defaults as empty arrays', () => {
    readSettingsSpy.mockReturnValue({})
    const out = projectCurrentSettings()
    expect(out.quickTools).toEqual([])
    expect(out.tabGroups).toEqual([])
  })

  it('passes list-typed values through unchanged', () => {
    const tools = [{ id: 'a', name: 'Build', icon: 'Hammer', command: 'make' }]
    readSettingsSpy.mockReturnValue({ quickTools: tools })
    const out = projectCurrentSettings()
    expect(out.quickTools).toBe(tools) // reference equality — no copy
  })
})
