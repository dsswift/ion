import React from 'react'
import { useSessionStore } from '../../../stores/sessionStore'
import { useColors } from '../../../theme'
import { ResourceContent } from '../../../components/ResourceContent'

import { resourceMatchesIdentity } from '../../../../shared/resource-identity'

export function ResourceSurface({ resourceKind, resourceId, resourceProducer }: { resourceKind: string; resourceId: string; resourceProducer?: string }): React.JSX.Element {
  const colors = useColors()
  const item = useSessionStore((s) => (s.resources[resourceKind] ?? []).find((candidate) => resourceMatchesIdentity(candidate, resourceId, resourceProducer)) ?? null)
  if (!item) {
    return <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: colors.textTertiary, fontSize: 12, fontFamily: 'system-ui, sans-serif' }}>Resource is no longer available.</div>
  }
  return <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}><ResourceContent content={item.content} /></div>
}
