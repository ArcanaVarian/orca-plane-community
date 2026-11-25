// Plane API v1 calls the plugin makes, as Plane Community Edition serves them. All read-only.
// Community v1 has no assignee filter and no list across projects: the list is read project by
// project and narrowed down here (see docs/api-v1.md).
import { type Conn, PlaneError, planeGet } from './http'

export const PER_PAGE = 200
export const MAX_PAGES = 10
const PROJECTS_PER_PAGE = 1000
const CONCURRENCY = 3
/** A refresh runs in the background, so it may wait out Plane's whole one-minute rate limit window. */
const LIST_MAX_WAIT_MS = 60_000

const DETAIL_EXPAND = 'state,assignees,labels,project'
const LIST_QUERY = {
  fields: 'id,name,sequence_id,priority,state,assignees,labels,updated_at',
  expand: 'state,labels',
  per_page: String(PER_PAGE)
}
/** The order `order_by=state__group` sorts by; any other group comes after these. */
const OPEN_GROUPS = ['backlog', 'unstarted', 'started']

type Row = Record<string, unknown>
const asRow = (value: unknown): Row => (value && typeof value === 'object' ? (value as Row) : {})

export type Me = { id: string; displayName: string }

/** A 404 here means no v1 or a Plane too old for it: `users/me` needs no slug. */
export async function me(conn: Conn, signal?: AbortSignal): Promise<Me> {
  let body: unknown
  try {
    body = await planeGet(conn, '/api/v1/users/me/', { signal })
  } catch (error) {
    if (error instanceof PlaneError && error.kind === 'not_found') {
      throw new PlaneError('unsupported_server', 'The server does not serve Plane API v1.', 404)
    }
    // Plane v1 answers an invalid token with 403, and any valid token may read its own user.
    if (error instanceof PlaneError && error.kind === 'forbidden') {
      throw new PlaneError('auth', error.message, 403)
    }
    throw error
  }
  const record = asRow(body)
  if (typeof record.id !== 'string') throw new PlaneError('bad_response', 'Plane sent no user id.')
  const name = record.display_name || record.email
  return { id: record.id, displayName: typeof name === 'string' ? name : record.id }
}

type ReadOptions = { signal?: AbortSignal; deadline?: number }

/** One page of a v1 list. Cursors are `<page size>:<page>:<is previous>`. */
async function getPage(
  conn: Conn,
  path: string,
  query: Record<string, string>,
  page: number,
  options: ReadOptions
): Promise<{ rows: Row[]; more: boolean }> {
  const body = asRow(
    await planeGet(conn, path, {
      query: { ...query, cursor: `${query.per_page}:${page}:0` },
      signal: options.signal,
      deadline: options.deadline,
      maxWaitMs: LIST_MAX_WAIT_MS
    })
  )
  if (!Array.isArray(body.results)) {
    throw new PlaneError('unsupported_server', 'The server did not answer as Plane API v1.')
  }
  return { rows: body.results.map(asRow), more: body.next_page_results === true }
}

const workspacePath = (slug: string) => `/api/v1/workspaces/${encodeURIComponent(slug)}`
const projectPath = (slug: string, projectId: string) =>
  `${workspacePath(slug)}/projects/${encodeURIComponent(projectId)}`

export type Project = { id: string; identifier: string }

/** The projects the token's user is a member of, without the archived ones. */
export async function listProjects(conn: Conn, slug: string, options: ReadOptions = {}): Promise<Project[]> {
  const query = { fields: 'id,identifier,is_member,archived_at', per_page: String(PROJECTS_PER_PAGE) }
  const projects = new Map<string, Project>()
  for (let page = 0; page < MAX_PAGES; page++) {
    const { rows, more } = await getPage(conn, `${workspacePath(slug)}/projects/`, query, page, options)
    for (const { id, identifier, is_member, archived_at } of rows) {
      // The list also has the workspace's public projects, whose items only members may read.
      if (typeof id !== 'string' || typeof identifier !== 'string' || is_member === false || archived_at) continue
      projects.set(id, { id, identifier })
    }
    if (!more) break
  }
  return [...projects.values()]
}

type ProjectItems = { rows: Row[]; truncated: boolean }

/** A project's open items: ordered by state group the closed ones come last, so reading stops at the first. */
async function listOpenItems(conn: Conn, slug: string, project: Project, options: ReadOptions): Promise<ProjectItems> {
  const path = `${projectPath(slug, project.id)}/work-items/`
  const open = new Map<string, Row>()
  let rank = 0
  for (let page = 0; page < MAX_PAGES; page++) {
    const { rows, more } = await getPage(conn, path, { ...LIST_QUERY, order_by: 'state__group' }, page, options)
    for (const row of rows) {
      const at = groupRank(row)
      // Plane breaks ties in this order arbitrarily, so two pages may disagree. Any item missed that way
      // leaves another one read twice: then (or when the order is not by group) read it all in a stable order.
      if (at < rank || open.has(String(row.id))) return listAllItems(conn, path, options)
      rank = at
      if (at < OPEN_GROUPS.length) open.set(String(row.id), row)
    }
    if (!more || rank >= OPEN_GROUPS.length) return { rows: [...open.values()], truncated: false }
  }
  return { rows: [...open.values()], truncated: true }
}

/** Every item of a project by its number, which is unique; the closed ones are dropped. */
async function listAllItems(conn: Conn, path: string, options: ReadOptions): Promise<ProjectItems> {
  const open = new Map<string, Row>()
  for (let page = 0; page < MAX_PAGES; page++) {
    const { rows, more } = await getPage(conn, path, { ...LIST_QUERY, order_by: '-sequence_id' }, page, options)
    for (const row of rows) if (groupRank(row) < OPEN_GROUPS.length) open.set(String(row.id), row)
    if (!more) return { rows: [...open.values()], truncated: false }
  }
  return { rows: [...open.values()], truncated: true }
}

function groupRank(row: Row): number {
  const rank = OPEN_GROUPS.indexOf(String(asRow(row.state).group))
  return rank < 0 ? OPEN_GROUPS.length : rank
}

const isAssigned = (row: Row, userId: string) => Array.isArray(row.assignees) && row.assignees.includes(userId)

export type ListResult = {
  rows: unknown[]
  completeness: 'complete' | 'partial'
  /** Ids of the projects that could not be read; their items are not in `rows`. */
  failedProjects: string[]
  /** Why the list is partial. */
  error?: string
}

export type ListOptions = ReadOptions & {
  /** Project identifiers to read, upper-case; empty or absent reads all of them. */
  only?: string[]
}

/** These fail the same way for every project: asking on only spends the rate limit. */
const HALTING = new Set<string>(['auth', 'rate_limited', 'network', 'cancelled'])

/** The open items assigned to `userId` in every project; a project that fails leaves the list partial. */
export async function listMyOpenItems(
  conn: Conn,
  slug: string,
  userId: string,
  options: ListOptions = {}
): Promise<ListResult> {
  const all = await listProjects(conn, slug, options)
  const only = options.only ?? []
  const projects = only.length ? all.filter((project) => only.includes(project.identifier.toUpperCase())) : all
  const rows: unknown[] = []
  const failed: Project[] = []
  const truncated: string[] = []
  const errors: PlaneError[] = []
  let halted = false
  let next = 0
  const read = async () => {
    while (next < projects.length) {
      const project = projects[next++]
      if (halted) {
        failed.push(project)
        continue
      }
      try {
        const result = await listOpenItems(conn, slug, project, options)
        if (result.truncated) truncated.push(project.identifier)
        for (const row of result.rows) {
          if (isAssigned(row, userId)) rows.push({ ...row, project: { id: project.id, identifier: project.identifier } })
        }
      } catch (error) {
        if (!(error instanceof PlaneError)) throw error
        errors.push(error)
        failed.push(project)
        if (options.signal?.aborted || HALTING.has(error.kind)) halted = true
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, read))
  if (errors.length && failed.length === projects.length) throw errors[0]

  const identifiers = new Set(all.map((project) => project.identifier.toUpperCase()))
  const unknown = only.filter((identifier) => !identifiers.has(identifier))
  const problems: string[] = []
  if (failed.length) problems.push(`Could not read ${names(failed.map((p) => p.identifier))}: ${errors[0].message}`)
  if (truncated.length) problems.push(`Too many work items to read all of ${names(truncated)}.`)
  if (unknown.length) problems.push(`You are not in a project with the identifier ${names(unknown)}.`)
  return {
    rows,
    completeness: problems.length ? 'partial' : 'complete',
    failedProjects: failed.map((project) => project.id),
    ...(problems.length ? { error: problems.join(' ') } : {})
  }
}

const MAX_NAMES = 5
function names(values: string[]): string {
  const rest = values.length - MAX_NAMES
  return rest > 0 ? `${values.slice(0, MAX_NAMES).join(', ')} and ${rest} more` : values.join(', ')
}

/** A work item in its project by its UUID (a pasted project-issue URL). */
export async function getItem(
  conn: Conn,
  slug: string,
  projectId: string,
  id: string,
  signal?: AbortSignal
): Promise<unknown> {
  const path = `${projectPath(slug, projectId)}/work-items/${encodeURIComponent(id)}/`
  return planeGet(conn, path, { query: { expand: DETAIL_EXPAND }, signal })
}

/** A work item by its key alone (`KEY-N`), from any project of the user. */
export async function getItemByKey(conn: Conn, slug: string, key: string, signal?: AbortSignal): Promise<unknown> {
  const path = `${workspacePath(slug)}/work-items/${encodeURIComponent(key)}/`
  return planeGet(conn, path, { query: { expand: DETAIL_EXPAND }, signal })
}

/** More than the panel shows: some of what Plane finds is dropped (see `toFound`). */
export const SEARCH_LIMIT = 100

/** Work items of any state in every project of the user, by title, number or project identifier. */
export async function searchItems(conn: Conn, slug: string, text: string, signal?: AbortSignal): Promise<unknown[]> {
  const query = { search: text, workspace_search: 'true', limit: String(SEARCH_LIMIT) }
  const body = asRow(await planeGet(conn, `${workspacePath(slug)}/work-items/search/`, { query, signal }))
  if (!Array.isArray(body.issues)) {
    throw new PlaneError('unsupported_server', 'The server did not answer as Plane API v1.')
  }
  return body.issues
}

/** `raw` with its parent's id replaced by the parent's number and title; v1 expands a parent without its title. */
export async function withParent(conn: Conn, slug: string, raw: unknown, signal?: AbortSignal): Promise<unknown> {
  const row = asRow(raw)
  const project = asRow(row.project)
  if (typeof row.parent !== 'string' || typeof project.id !== 'string') return raw
  const path = `${projectPath(slug, project.id)}/work-items/${encodeURIComponent(row.parent)}/`
  try {
    const parent = asRow(await planeGet(conn, path, { query: { fields: 'id,name,sequence_id' }, signal }))
    return { ...row, parent: { name: parent.name, sequence_id: parent.sequence_id } }
  } catch (error) {
    // The item is readable without its parent.
    if (error instanceof PlaneError && error.kind !== 'cancelled') return { ...row, parent: null }
    throw error
  }
}
