import { assert, test } from 'orca/testing'
import { getItem, getItemByKey, listMyOpenItems, listProjects, MAX_PAGES, me, searchItems, withParent } from './api'
import { type FakeAnswer, fakeFetch } from './fake-fetch'
import { PlaneError } from './http'

const conn = { apiBase: 'https://plane.example.com', token: 'plane_api_test' }
const USER = 'd9371857-5d13-4306-abe9-f3aefb05f40e'
const rejectsWith = (promise: Promise<unknown>, kind: string) =>
  assert.rejects(promise, (e: unknown) => e instanceof PlaneError && e.kind === kind)

const row = (id: string, group: string, assignees: string[] = [USER]) => ({ id, name: id, state: { name: group, group }, assignees })
const listOf = (results: unknown[], more = false) => ({ json: { results, next_page_results: more, next_cursor: 'unused' } })
const project = (identifier: string, over: object = {}) => ({ id: `id-${identifier}`, identifier, is_member: true, archived_at: null, ...over })
const ids = (rows: unknown[]) => rows.map((entry) => (entry as { id: string }).id)

type Ask = { order: string | null; page: number }
/** A workspace: the projects and, per identifier, what its work item pages answer. */
function workspace(projects: unknown[], pages: Record<string, (ask: Ask) => FakeAnswer>) {
  return fakeFetch((url) => {
    if (url.pathname === '/api/v1/workspaces/acme/projects/') return listOf(projects)
    const id = url.pathname.match(/\/projects\/id-([^/]+)\/work-items\/$/)?.[1]
    const ask = { order: url.searchParams.get('order_by'), page: Number(url.searchParams.get('cursor')?.split(':')[1]) }
    return (id && pages[id]?.(ask)) || { status: 404, json: {} }
  })
}
const listed = (fake: ReturnType<typeof fakeFetch>) =>
  fake.calls.map((call) => new URL(call.url)).filter((url) => url.pathname.endsWith('/work-items/'))

test('me() reads id and display name; 404 means no v1; a 403 is an invalid token', async () => {
  fakeFetch(() => ({ json: { id: USER, display_name: 'Dima' } }))
  assert.deepEqual(await me(conn), { id: USER, displayName: 'Dima' })
  fakeFetch(() => ({ status: 404, json: { error: 'x' } }))
  await rejectsWith(me(conn), 'unsupported_server')
  fakeFetch(() => ({ status: 403, json: { detail: 'Given API token is not valid' } }))
  await rejectsWith(me(conn), 'auth')
})

test('listProjects keeps the projects the user is in, without archived ones', async () => {
  workspace([project('WEB'), project('PUB', { is_member: false }), project('OLD', { archived_at: '2026-01-01' }), { id: 1 }], {})
  assert.deepEqual(await listProjects(conn, 'acme'), [{ id: 'id-WEB', identifier: 'WEB' }])
  fakeFetch(() => ({ json: { data: [] } }))
  await rejectsWith(listProjects(conn, 'acme'), 'unsupported_server')
})

test('lists the open items of the user from every project, each with its project', async () => {
  const fake = workspace([project('WEB'), project('API')], {
    WEB: () => listOf([row('w1', 'backlog'), row('w2', 'started', ['someone']), row('w3', 'started'), row('w4', 'completed')]),
    API: () => listOf([row('a1', 'unstarted', ['someone', USER]), row('a2', 'cancelled')])
  })
  const result = await listMyOpenItems(conn, 'acme', USER)
  assert.deepEqual(ids(result.rows).sort(), ['a1', 'w1', 'w3'])
  assert.deepEqual([result.completeness, result.failedProjects, result.error], ['complete', [], undefined])
  assert.deepEqual((result.rows.find((entry) => (entry as { id: string }).id === 'a1') as { project: unknown }).project, { id: 'id-API', identifier: 'API' })
  assert.deepEqual(Object.fromEntries(listed(fake)[0].searchParams), {
    fields: 'id,name,sequence_id,priority,state,assignees,labels,updated_at',
    expand: 'state,labels',
    per_page: '200',
    order_by: 'state__group',
    cursor: '200:0:0'
  })
})

test('stops at the first closed item: later pages are not read', async () => {
  const pages = [
    listOf([row('1', 'backlog'), row('2', 'started')], true),
    listOf([row('3', 'started'), row('4', 'completed')], true)
  ]
  const fake = workspace([project('WEB')], { WEB: ({ page }) => pages[page] ?? { status: 500 } })
  const result = await listMyOpenItems(conn, 'acme', USER)
  assert.deepEqual([ids(result.rows), result.completeness], [['1', '2', '3'], 'complete'])
  assert.deepEqual(listed(fake).map((url) => url.searchParams.get('cursor')), ['200:0:0', '200:1:0'])
})

test('an item on two pages means another was missed: the project is read again by number', async () => {
  // Plane put 2 on both pages, so 3 was on neither.
  const byGroup = [listOf([row('1', 'started'), row('2', 'started')], true), listOf([row('2', 'started'), row('4', 'completed')])]
  const byNumber = [listOf([row('4', 'completed'), row('3', 'started')], true), listOf([row('2', 'started'), row('1', 'started')])]
  const fake = workspace([project('WEB')], { WEB: ({ order, page }) => (order === 'state__group' ? byGroup : byNumber)[page] })
  const result = await listMyOpenItems(conn, 'acme', USER)
  assert.deepEqual([ids(result.rows).sort(), result.completeness], [['1', '2', '3'], 'complete'])
  assert.deepEqual(listed(fake).map((url) => url.searchParams.get('order_by')), ['state__group', 'state__group', '-sequence_id', '-sequence_id'])
})

test('a server that does not order by group is read by number, so no open item after a closed one is lost', async () => {
  const unordered = [row('1', 'completed'), row('2', 'started')]
  workspace([project('WEB')], { WEB: () => listOf(unordered) })
  assert.deepEqual(ids((await listMyOpenItems(conn, 'acme', USER)).rows), ['2'])
})

test('a project with too many open items is partial and named', async () => {
  const fake = workspace([project('WEB')], { WEB: ({ page }) => listOf([row(`${page}`, 'started')], true) })
  const result = await listMyOpenItems(conn, 'acme', USER)
  assert.deepEqual([result.rows.length, result.completeness], [MAX_PAGES, 'partial'])
  assert.equal(result.error, 'Too many work items to read all of WEB.')
  assert.equal(listed(fake).length, MAX_PAGES)
})

test('a failing project keeps the others: partial, naming it', async () => {
  workspace([project('WEB'), project('API')], {
    WEB: () => listOf([row('w1', 'started')]),
    API: () => ({ status: 502, json: { detail: 'upstream down' } })
  })
  const result = await listMyOpenItems(conn, 'acme', USER)
  assert.deepEqual([ids(result.rows), result.completeness, result.failedProjects], [['w1'], 'partial', ['id-API']])
  assert.equal(result.error, 'Could not read API: Plane answered HTTP 502: upstream down')
})

test('every project failing, or the project list failing, throws', async () => {
  workspace([project('WEB'), project('API')], {})
  await rejectsWith(listMyOpenItems(conn, 'acme', USER), 'not_found')
  fakeFetch(() => ({ status: 403, json: { detail: 'no' } }))
  await rejectsWith(listMyOpenItems(conn, 'acme', USER), 'forbidden')
})

test('a rate limit that outlasts its wait stops asking for further projects', async () => {
  const projects = Array.from({ length: 30 }, (_, i) => project(`P${i}`))
  const limited: FakeAnswer = { status: 429, headers: { 'retry-after': '3000' } }
  const pages = Object.fromEntries(projects.map(({ identifier }, i) => [identifier, () => (i === 0 ? listOf([row('p0', 'started')]) : limited)]))
  const fake = workspace(projects, pages)
  const result = await listMyOpenItems(conn, 'acme', USER)
  assert.deepEqual([ids(result.rows), result.failedProjects.length], [['p0'], 29])
  assert.match(result.error ?? '', /^Could not read .* and 24 more: Plane rate limit reached/)
  assert.ok(listed(fake).length <= 5, String(listed(fake).length))
})

test('a one-minute rate limit is waited out', async () => {
  let n = 0
  const fake = workspace([project('WEB')], {
    WEB: () => (n++ === 0 ? { status: 429, headers: { 'retry-after': '55' } } : listOf([row('w1', 'started')]))
  })
  assert.equal((await listMyOpenItems(conn, 'acme', USER)).completeness, 'complete')
  assert.deepEqual(fake.sleeps, [55_000])
})

test('only: reads the named projects; an unknown identifier is partial and named', async () => {
  const fake = workspace([project('WEB'), project('API')], { WEB: () => listOf([row('w1', 'started')]) })
  assert.equal((await listMyOpenItems(conn, 'acme', USER, { only: ['WEB'] })).completeness, 'complete')
  assert.equal(listed(fake).length, 1)
  const result = await listMyOpenItems(conn, 'acme', USER, { only: ['WEB', 'NOPE'] })
  assert.deepEqual([ids(result.rows), result.completeness], [['w1'], 'partial'])
  assert.equal(result.error, 'You are not in a project with the identifier NOPE.')
})

test('no projects is a complete, empty list', async () => {
  workspace([], {})
  assert.deepEqual(await listMyOpenItems(conn, 'acme', USER), { rows: [], completeness: 'complete', failedProjects: [] })
})

test('getItemByKey and getItem ask their v1 routes; a 404 is not_found', async () => {
  const fake = fakeFetch(() => ({ json: { id: 'x' } }))
  await getItemByKey(conn, 'acme', 'DIOGEN-449')
  await getItem(conn, 'acme', 'p-1', 'i-1')
  const urls = fake.calls.map((call) => new URL(call.url))
  assert.deepEqual(urls.map((url) => url.pathname), [
    '/api/v1/workspaces/acme/work-items/DIOGEN-449/',
    '/api/v1/workspaces/acme/projects/p-1/work-items/i-1/'
  ])
  for (const url of urls) assert.equal(url.searchParams.get('expand'), 'state,assignees,labels,project')
  fakeFetch(() => ({ status: 404, json: { error: 'The requested resource does not exist.' } }))
  await rejectsWith(getItemByKey(conn, 'acme', 'DIOGEN-1'), 'not_found')
})

test('searchItems asks the workspace search; another shape is not v1', async () => {
  const fake = fakeFetch(() => ({ json: { issues: [{ id: 'x' }] } }))
  assert.deepEqual(await searchItems(conn, 'acme', 'login & more'), [{ id: 'x' }])
  const url = new URL(fake.calls[0].url)
  assert.equal(url.pathname, '/api/v1/workspaces/acme/work-items/search/')
  assert.deepEqual(Object.fromEntries(url.searchParams), { search: 'login & more', workspace_search: 'true', limit: '100' })
  fakeFetch(() => ({ json: [] }))
  await rejectsWith(searchItems(conn, 'acme', 'x'), 'unsupported_server')
})

test('withParent reads the parent in the item\'s project; an unreadable parent is dropped', async () => {
  const raw = { id: 'x', project: { id: 'p-1', identifier: 'WEB' }, parent: 'parent-1' }
  const fake = fakeFetch(() => ({ json: { id: 'parent-1', name: 'Epic', sequence_id: 3 } }))
  assert.deepEqual(await withParent(conn, 'acme', raw), { ...raw, parent: { name: 'Epic', sequence_id: 3 } })
  assert.equal(new URL(fake.calls[0].url).pathname, '/api/v1/workspaces/acme/projects/p-1/work-items/parent-1/')
  fakeFetch(() => ({ status: 404, json: {} }))
  assert.deepEqual(await withParent(conn, 'acme', raw), { ...raw, parent: null })
  const none = fakeFetch(() => ({ json: {} }))
  assert.deepEqual(await withParent(conn, 'acme', { ...raw, parent: null }), { ...raw, parent: null })
  assert.equal(none.calls.length, 0)
})
