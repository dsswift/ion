/** Fractional base-26 ordering for pinned inbox rows. */
const DIGITS = 'abcdefghijklmnopqrstuvwxyz'

function valid(key: string): boolean {
  return key.length > 0 && [...key].every((char) => DIGITS.includes(char)) && key.at(-1) !== 'a'
}

function midpoint(left: string, right: string): string {
  if (right && left >= right) throw new Error('pin order bounds out of order')
  if (right) {
    let index = 0
    while ((left[index] ?? 'a') === right[index]) index++
    if (index > 0) return right.slice(0, index) + midpoint(left.slice(index), right.slice(index))
  }
  const leftDigit = left ? DIGITS.indexOf(left[0]!) : 0
  const rightDigit = right ? DIGITS.indexOf(right[0]!) : DIGITS.length
  if (rightDigit - leftDigit > 1) return DIGITS[Math.round((leftDigit + rightDigit) / 2)]!
  if (right.length > 1) return right[0]!
  return DIGITS[leftDigit]! + midpoint(left.slice(1), '')
}

export function pinOrderKeyBetween(before: string | null, after: string | null): string | null {
  const left = before ?? ''
  const right = after ?? ''
  if ((left && !valid(left)) || (right && !valid(right)) || (right && left >= right)) return null
  return midpoint(left, right)
}

export function generateSpreadPinOrderKeys(count: number): string[] {
  const space = DIGITS.length ** 2
  const step = space / (count + 1)
  let prior = 0
  return Array.from({ length: count }, (_, index) => {
    let value = Math.max(Math.round(step * (index + 1)), prior + 1)
    if (value % DIGITS.length === 0) value++
    value = Math.min(value, space - 1)
    prior = value
    return DIGITS[Math.floor(value / DIGITS.length)]! + DIGITS[value % DIGITS.length]!
  })
}

export function planPinnedReorder(input: {
  orderedIds: readonly string[]
  keysById: ReadonlyMap<string, string | null | undefined>
  movedId: string
}): Array<{ id: string; orderKey: string }> {
  const index = input.orderedIds.indexOf(input.movedId)
  if (index < 0) return []
  const before = index > 0 ? input.orderedIds[index - 1]! : null
  const after = index < input.orderedIds.length - 1 ? input.orderedIds[index + 1]! : null
  const beforeKey = before == null ? null : input.keysById.get(before) ?? null
  const afterKey = after == null ? null : input.keysById.get(after) ?? null
  if ((before == null || beforeKey != null) && (after == null || afterKey != null)) {
    const key = pinOrderKeyBetween(beforeKey, afterKey)
    if (key) return [{ id: input.movedId, orderKey: key }]
  }
  const keys = generateSpreadPinOrderKeys(input.orderedIds.length)
  return input.orderedIds.flatMap((id, position) => input.keysById.get(id) === keys[position] ? [] : [{ id, orderKey: keys[position]! }])
}

export function planPinnedMove(input: {
  orderedIds: readonly string[]
  keysById: ReadonlyMap<string, string | null | undefined>
  movedId: string
  direction: 'up' | 'down'
}): Array<{ id: string; orderKey: string }> | null {
  const from = input.orderedIds.indexOf(input.movedId)
  const to = input.direction === 'up' ? from - 1 : from + 1
  if (from < 0 || to < 0 || to >= input.orderedIds.length) return null
  const orderedIds = [...input.orderedIds]
  orderedIds.splice(from, 1)
  orderedIds.splice(to, 0, input.movedId)
  return planPinnedReorder({ ...input, orderedIds })
}

export function sortPinnedByOrder<T extends { id: string; createdAt?: number; pinOrderKey?: string | null }>(tabs: readonly T[]): T[] {
  return [...tabs].sort((left, right) => {
    if (left.pinOrderKey && right.pinOrderKey) return left.pinOrderKey.localeCompare(right.pinOrderKey) || left.id.localeCompare(right.id)
    if (left.pinOrderKey) return -1
    if (right.pinOrderKey) return 1
    return (right.createdAt ?? 0) - (left.createdAt ?? 0) || left.id.localeCompare(right.id)
  })
}
