/**
 * Structural tests for the Windows desktop release job.
 *
 * The same class of test as engine-host-build.test.ts: the workflow cannot be
 * run here, so what is pinned is that the steps a release depends on are still
 * wired and still in the right order. Both properties below are ones a
 * reordering or a rename breaks silently, and the failure only shows up as an
 * unsigned installer on a fleet or a release page with no checksums.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import path from 'path'

const workflow = readFileSync(
  path.resolve(__dirname, '..', '..', '..', '..', '.github', 'workflows', 'build.yml'),
  'utf-8',
)
const windowsJob = workflow.slice(workflow.indexOf('  build-desktop-windows:'))

describe('windows release signing', () => {
  // The gate has to run before the build, not after: its whole job is to stop
  // a required-signing release that has no certificate BEFORE 130 MB of
  // installer exists and gets uploaded.
  it('resolves the signing identity before building the installer', () => {
    const gate = windowsJob.indexOf('resolve-windows-signing.ps1')
    const build = windowsJob.indexOf('npx electron-builder --win')
    expect(gate, 'the signing gate is not in the windows job').toBeGreaterThan(-1)
    expect(build).toBeGreaterThan(gate)
  })

  it('drives electron-builder from the gate output and the secret', () => {
    expect(windowsJob).toContain('CSC_LINK: ${{ steps.signing.outputs.certificateFile }}')
    expect(windowsJob).toContain('CSC_KEY_PASSWORD: ${{ secrets.WINDOWS_CERT_PASSWORD }}')
  })

  // Secret inputs only. A certificate or password written into the repository
  // is a certificate that has to be revoked.
  it('takes the certificate from secrets, never from a repository file', () => {
    expect(windowsJob).toContain('secrets.WINDOWS_CERT_PFX_BASE64')
    expect(windowsJob).not.toMatch(/\.pfx['"\s]*$/m)
  })

  it('reads the requirement from a repository variable', () => {
    expect(windowsJob).toContain('ION_REQUIRE_WINDOWS_SIGNING: ${{ vars.ION_REQUIRE_WINDOWS_SIGNING }}')
  })

  // Signing stays opt-in. A default that required a certificate would stop
  // every contributor and every pilot build, and the honest unsigned label
  // (read off the file by the manifest, not declared here) is what makes that
  // safe. The requirement is a repository variable, never a hardcoded true.
  it('does not require signing by default', () => {
    expect(windowsJob).not.toMatch(/ION_REQUIRE_WINDOWS_SIGNING:\s*(true|"true"|'true')/)
  })

  // The build step's comment was edited twice and the second edit left the
  // first one's tail behind, so it read as one sentence running into the
  // middle of another. A comment that describes the step wrongly is the same
  // defect class as a stale doc: the next reader believes it.
  it('carries no duplicated comment tail on the build step', () => {
    const occurrences = windowsJob.split("electron-builder's own \"do not sign\" signal").length - 1
    expect(occurrences).toBe(1)
  })
})

describe('windows release provenance', () => {
  const manifestStep = windowsJob.slice(windowsJob.indexOf('Write-IonArtifactManifest.ps1'))

  // Every asset a managed fleet installs. A manifest that covers the .exe and
  // silently omits the .intunewin -- which is what Intune actually deploys --
  // would look complete and prove nothing about the deployed bytes.
  it.each([
    ['the installer', 'Ion-Setup-$v-x64.exe'],
    ['the Intune package', 'Ion-Setup-$v-x64.intunewin'],
    ['the stamped detection script', 'Detect-Ion.ps1'],
    ['the policy templates', 'Ion-PolicyTemplates-$v.zip'],
  ])('covers %s', (_what, asset) => {
    expect(manifestStep).toContain(asset)
  })

  it('runs after the assets it hashes exist', () => {
    const intunewin = windowsJob.indexOf('make-intunewin.ps1')
    const policyZip = windowsJob.indexOf('Zip the Group Policy templates')
    const manifest = windowsJob.indexOf('Write the artifact provenance manifest')
    expect(intunewin).toBeGreaterThan(-1)
    expect(policyZip).toBeGreaterThan(-1)
    expect(manifest).toBeGreaterThan(intunewin)
    expect(manifest).toBeGreaterThan(policyZip)
  })

  it('publishes both the manifest and the checksum list', () => {
    const upload = windowsJob.slice(windowsJob.indexOf('Upload the update feed and management assets'))
    expect(upload).toContain('Ion-Artifacts-*.json')
    expect(upload).toContain('Ion-Artifacts-*.sha256')
  })

  // The manifest labels the build from the gate's decision, so an unsigned
  // build cannot be published carrying a "release" label.
  it('labels the build from the signing decision', () => {
    expect(manifestStep).toContain("-BuildType '${{ steps.signing.outputs.buildType }}'")
  })
})
