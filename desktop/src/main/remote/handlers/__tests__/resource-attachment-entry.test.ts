/**
 * resource-attachment-entry — generic (kind-agnostic) attachment encoding
 *
 * Pins the contract that conversation-scoped resources are encoded for iOS
 * with a GENERIC type='resource' carrying the real kind — never a hardcoded
 * type like 'briefing'. This is the de-opinionating contract: any extension
 * kind surfaces in the attachments sheet with zero client code change.
 */

import { describe, it, expect } from 'vitest'
import { resourceToAttachmentEntry } from '../resource-attachment-entry'

describe('resourceToAttachmentEntry', () => {
  it('encodes type as generic "resource", never the kind', () => {
    const entry = resourceToAttachmentEntry({ id: 'b1', kind: 'briefing', title: 'Morning Brief', conversationId: 'c1' })
    expect(entry.type).toBe('resource')
    // The hardcoded-briefing anti-pattern must not return.
    expect(entry.type).not.toBe('briefing')
  })

  it('carries the real kind so iOS can bucket/label generically', () => {
    expect(resourceToAttachmentEntry({ id: 'x', kind: 'report' }).kind).toBe('report')
    expect(resourceToAttachmentEntry({ id: 'y', kind: 'com.acme.invoice' }).kind).toBe('com.acme.invoice')
  })

  it('uses resource:<id> as the path', () => {
    expect(resourceToAttachmentEntry({ id: 'abc123', kind: 'briefing' }).path).toBe('resource:abc123')
  })

  it('falls back name → title, then kind, then "Resource"', () => {
    expect(resourceToAttachmentEntry({ id: '1', kind: 'briefing', title: 'T' }).name).toBe('T')
    expect(resourceToAttachmentEntry({ id: '2', kind: 'report' }).name).toBe('report')
    expect(resourceToAttachmentEntry({ id: '3' }).name).toBe('Resource')
  })

  it('works for an arbitrary new kind with zero special-casing', () => {
    const entry = resourceToAttachmentEntry({ id: 'n', kind: 'totally.new.kind', title: 'New' })
    expect(entry).toEqual({ type: 'resource', kind: 'totally.new.kind', name: 'New', path: 'resource:n' })
  })
})
