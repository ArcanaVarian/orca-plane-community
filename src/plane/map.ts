// Maps Plane API v1 payloads to the plugin's model: rows with `state`, `labels` and `project` expanded, a detail
// also with `assignees` and the parent that `withParent` reads.
import { htmlToMarkdown } from './markdown'

export type StateGroup = 'backlog' | 'unstarted' | 'started' | 'unknown'
export type Priority = 'urgent' | 'high' | 'medium' | 'low' | 'none'

export type Item = {
  id: string
  /** `KEY-N`, e.g. `DIOGEN-449`. */
  key: string
  title: string
  projectId: string
  /** null when Plane did not send the state's details. */
  stateName: string | null
  stateGroup: StateGroup
  priority: Priority
  /** Label names. */
  labels: string[]
  updatedAt: string
}

/** A search result: Plane sends no state or assignee with it. */
export type FoundItem = Pick<Item, 'key' | 'title' | 'projectId'>

export type ItemDetail = Item & {
  assignees: string[]
  description: string
  url: string
  /** null without a parent or when it could not be read. */
  parent?: { key: string | null; title: string } | null
}

/**
 * Line breaks besides CR and LF, as a regex character class body: Unicode's mandatory breaks (VT, FF, NEL, U+2028,
 * U+2029) and the separators Python's str.splitlines() also breaks at (U+001C-U+001E). Shared with the Start fence (#56).
 */
export const OTHER_BREAKS = '\\v\\f\\x1c-\\x1e\\x85\\u2028\\u2029'
const MULTI_LINE = new RegExp(`[\\r\\n${OTHER_BREAKS}]`)

const GROUPS = new Set<string>(['backlog', 'unstarted', 'started'])
const PRIORITIES = new Set<string>(['urgent', 'high', 'medium', 'low', 'none'])

type Row = Record<string, unknown>
const str = (value: unknown): string => (typeof value === 'string' ? value : '')

const names = (value: unknown, field: string): string[] =>
  Array.isArray(value)
    ? value.map((entry) => str((entry as Row | null)?.[field])).filter(Boolean)
    : []

/** v1 sends no key: it is the project's identifier and the item's number. Empty when either is missing. */
const itemKey = (identifier: string, sequence: unknown): string =>
  identifier && typeof sequence === 'number' ? `${identifier}-${sequence}` : ''

/** null for a row without the fields an item needs, or with a key that spans lines. */
export function toItem(raw: unknown): Item | null {
  const row = (raw ?? {}) as Row
  const id = str(row.id)
  const project = (row.project && typeof row.project === 'object' ? row.project : {}) as Row
  const key = itemKey(str(project.identifier), row.sequence_id)
  // A key with a line break could end the prompt's ticket block early (#56); Plane never sends one.
  if (!id || !key || MULTI_LINE.test(key)) return null
  const state = row.state && typeof row.state === 'object' ? (row.state as Row) : null
  const group = str(state?.group)
  const priority = str(row.priority)
  return {
    id,
    key,
    title: str(row.name),
    projectId: str(project.id),
    stateName: state ? str(state.name) || null : null,
    stateGroup: GROUPS.has(group) ? (group as StateGroup) : 'unknown',
    priority: PRIORITIES.has(priority) ? (priority as Priority) : 'none',
    labels: names(row.labels, 'name'),
    updatedAt: str(row.updated_at)
  }
}

/**
 * null for a row that does not match `text` by its key or title: Plane also returns every item whose number
 * is any number in the text, so `error 500` finds item 500 of each project.
 */
export function toFound(raw: unknown, text: string): FoundItem | null {
  const row = (raw ?? {}) as Row
  const key = itemKey(str(row.project__identifier), row.sequence_id)
  const title = str(row.name)
  const query = text.trim().toLowerCase()
  if (!key || MULTI_LINE.test(key)) return null
  if (!key.toLowerCase().includes(query) && !title.toLowerCase().includes(query)) return null
  return { key, title, projectId: str(row.project_id) }
}

export function toDetail(raw: unknown, url: (key: string) => string): ItemDetail | null {
  const item = toItem(raw)
  if (!item) return null
  const row = raw as Row
  const parent = row.parent && typeof row.parent === 'object' ? (row.parent as Row) : null
  return {
    ...item,
    assignees: names(row.assignees, 'display_name'),
    description: htmlToMarkdown(str(row.description_html)),
    url: url(item.key),
    // Plane keeps a parent in its item's project, so they share the key prefix.
    parent:
      parent && str(parent.name)
        ? { key: itemKey(item.key.slice(0, item.key.lastIndexOf('-')), parent.sequence_id) || null, title: str(parent.name) }
        : null
  }
}
