// 离线自检：不启动 DSH，也能验证插件契约、YAML 结构、证据折叠、路由响应。
//   node scripts/check.mjs
// 任何一项不合格就 exit 1。

import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parse as parseYaml } from 'yaml'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const STATUS = {
  code: ['building', 'blocked', 'paused', 'shelved', 'shipped'],
  material: ['collecting', 'editing', 'paused', 'shelved', 'exported'],
}
const DONE = new Set(['shipped', 'exported'])
const WIP = new Set(['building', 'editing', 'collecting'])

const problems = []
const fail = (message) => problems.push(message)

// ── 1. projects.yaml 结构 ────────────────────────────────────────────────
const doc = parseYaml(readFileSync(join(ROOT, 'projects.yaml'), 'utf8'))
const settings = doc?.settings ?? {}
for (const key of ['staleDays', 'zombieDays', 'wipSoftLimit']) {
  if (typeof settings[key] !== 'number') fail(`settings.${key} 必须是数字，实际是 ${JSON.stringify(settings[key])}`)
}
if (settings.staleDays >= settings.zombieDays) fail('staleDays 必须小于 zombieDays')

const projects = Array.isArray(doc?.projects) ? doc.projects : (fail('projects 必须是数组') ?? [])
const ids = new Set()
for (const [index, project] of projects.entries()) {
  const where = `projects[${index}] (${project?.id ?? '无 id'})`
  for (const key of ['id', 'name', 'path', 'kind', 'status', 'intent', 'next']) {
    if (typeof project?.[key] !== 'string' || project[key].trim() === '') fail(`${where} 缺少 ${key}`)
  }
  if (project?.kind && !STATUS[project.kind]) fail(`${where} kind=${project.kind} 不是 code/material`)
  else if (project?.status && !STATUS[project.kind]?.includes(project.status)) {
    fail(`${where} status=${project.status} 不属于 ${project.kind} 的合法值 ${STATUS[project.kind].join('/')}`)
  }
  if (ids.has(project?.id)) fail(`${where} id 重复`)
  ids.add(project?.id)
}

// ── 2. 插件契约 ──────────────────────────────────────────────────────────
const loaded = await import(pathToFileURL(join(ROOT, 'lib', 'host', 'index.js')).href)
if (typeof loaded.apply !== 'function') fail('lib/host/index.js 必须导出 apply 函数')
if (!Array.isArray(loaded.inject) || !loaded.inject.includes('webServer')) fail("inject 必须包含 'webServer'")

const routes = []
const fakeCtx = { webServer: { register: (route) => { routes.push(route); return () => {} } } }
const dispose = loaded.apply(fakeCtx)
if (typeof dispose !== 'function') fail('apply 必须返回 disposer 函数')

for (const route of routes) {
  if (route.kind !== 'exact' && route.kind !== 'prefix') fail(`路由 ${route.path} 的 kind 非法`)
  if (!String(route.path).startsWith('/')) fail(`路由 ${route.path} 必须以 / 开头`)
  if (typeof route.handler !== 'function') fail(`路由 ${route.path} 没有 handler`)
}
for (const path of ['/project-board', '/project-board/data.json']) {
  if (!routes.some((route) => route.path === path)) fail(`没有注册 ${path}`)
}

// ── 3. 路由真的能响应（顺带做完整证据折叠，会扫盘几秒） ──────────────────
async function hit(pathname) {
  let status = 0
  let body = ''
  const route = routes.find((candidate) => candidate.path === pathname)
  await route.handler(
    { method: 'GET', url: pathname },
    { writeHead: (code) => { status = code }, end: (chunk) => { body = String(chunk ?? '') } },
  )
  return { status, body }
}

const json = await hit('/project-board/data.json')
if (json.status !== 200) fail(`data.json 返回 ${json.status}，期望 200`)

let data = null
try {
  data = JSON.parse(json.body)
  if (data.ok !== true) fail('data.json 的 ok 不为 true')
} catch {
  fail(`data.json 不是合法 JSON：${json.body.slice(0, 200)}`)
}

if (data) {
  const folded = [...data.active, ...data.shelved, ...data.done]
  if (folded.length !== projects.length) {
    fail(`折叠后 ${folded.length} 个项目，YAML 里是 ${projects.length}`)
  }
  if (data.active.some((project) => project.status === 'shelved')) {
    fail('已认账的项目不该出现在进行中列表里')
  }
  for (const project of folded) {
    const machine = project.machine ?? {}
    if (machine.days !== null && (typeof machine.days !== 'number' || machine.days < 0)) {
      fail(`${project.id} 的天数非法：${machine.days}`)
    }
    if (machine.days !== null) {
      const expected =
        machine.days >= settings.zombieDays ? 'zombie' : machine.days >= settings.staleDays ? 'stale' : 'fresh'
      if (machine.level !== expected) fail(`${project.id} level=${machine.level}，按天数应为 ${expected}`)
    }
    if (DONE.has(project.status) && data.active.includes(project)) fail(`${project.id} 已交付却出现在进行中`)
  }
  const wip = folded.filter((project) => WIP.has(project.status)).length
  if (data.summary.wip !== wip) fail(`summary.wip=${data.summary.wip}，实际 ${wip}`)
  if (data.summary.doneCount !== folded.filter((p) => DONE.has(p.status)).length) fail('summary.doneCount 不对')
  const sorted = data.active.every((project, index, all) => {
    if (index === 0) return true
    const prev = all[index - 1].machine.days ?? Infinity
    const cur = project.machine.days ?? Infinity
    return prev >= cur
  })
  if (!sorted) fail('进行中的项目没有按「最久没动」排序')

  // 首屏预览：这就是你打开页面会看到的东西
  const preview = (title, rows) => {
    if (rows.length === 0) return
    console.log(`\n▸ ${title}`)
    console.log('─'.repeat(58))
    for (const project of rows) {
      const days = project.machine.days === null ? '无记录' : project.machine.days === 0 ? '今天' : `${project.machine.days} 天`
      console.log(
        `${project.id.padEnd(20)} ${String(project.status).padEnd(11)} ${days.padStart(9)}   ${project.kind}`,
      )
    }
  }
  preview('进行中（按最久没动排序）', data.active)
  preview('已认账不做', data.shelved)
  preview('已完成', data.done)
  console.log('─'.repeat(58))
  const { summary } = data
  console.log(
    `停止推进 ${summary.zombie} · 变慢 ${summary.stale} · 在动 ${summary.fresh} · 在做 ${summary.wip} · 认账 ${summary.shelvedCount} · 完成 ${summary.doneCount}`,
  )
  if (summary.wipOver) console.log(`⚠ 在做 ${summary.wip} 个，超过软上限 ${settings.wipSoftLimit}`)
}

const html = await hit('/project-board')
if (html.status !== 200) fail(`/project-board 返回 ${html.status}，期望 200`)
if (!html.body.includes('<title>项目进度</title>')) fail('/project-board 没有返回面板页面')
if (html.body.includes('undefined')) fail('/project-board 页面里出现了 undefined')

if (typeof dispose === 'function') dispose()

// ── 4. yaml 改写层：CRLF / LF 各跑一遍，改完必须还是合法 yaml ────────────────
// 这条是血的教训：git 在 Windows 上检出成 CRLF，而 split('\n') 让每行末尾剩一个 \r，
// 结果 status 那行匹配不上，代码改走「插入一行」的分支，写出来的 yaml 直接坏掉。
const edit = await import(pathToFileURL(join(ROOT, 'lib', 'host', 'edit.js')).href)
const fixture = (eol) => [
  'settings:',
  '  staleDays: 5',
  '',
  'projects:',
  '  - id: alpha',
  '    name: alpha',
  '    path: D:\\work\\alpha',
  '    kind: code',
  '    status: building',
  '    intent: 测试用',
  '    next: 改状态',
  '',
  '  - id: beta',
  '    name: beta',
  '    kind: code',
  '    intent: 没有 status 行的那种',
  '    next: 插一行',
  '',
].join(eol)

for (const eol of ['\n', '\r\n']) {
  const label = eol === '\n' ? 'LF' : 'CRLF'
  const tmp = join(ROOT, 'node_modules', `.pb-fixture-${label}.yaml`)
  const write = (text) => writeFileSync(tmp, text, 'utf8')

  // 4.1 有 status 行：只换那一行，行尾符不变，其它字节不动
  write(fixture(eol))
  const before = readFileSync(tmp, 'utf8')
  edit.setStatus(tmp, 'alpha', 'paused')
  const after = readFileSync(tmp, 'utf8')
  const doc1 = parseYaml(after)
  if (doc1.projects.find((p) => p.id === 'alpha')?.status !== 'paused') fail(`${label}: setStatus 没写进去`)
  if (eol === '\r\n' && after.replace(/\r\n/g, '').includes('\n')) fail('CRLF: 改写把行尾符搞混了')
  if (before.split(eol).length !== after.split(eol).length) fail(`${label}: setStatus 多写/少写了行`)

  // 4.2 没有 status 行：插进去之后必须还是合法 yaml，缩进得和别的键对齐
  edit.setStatus(tmp, 'beta', 'blocked')
  const after2 = readFileSync(tmp, 'utf8')
  let doc2 = null
  try {
    doc2 = parseYaml(after2)
  } catch (error) {
    fail(`${label}: setStatus 插 status 之后 yaml 坏了 -> ${error.message}`)
  }
  if (doc2?.projects.find((p) => p.id === 'beta')?.status !== 'blocked') fail(`${label}: 插入的 status 没生效`)

  // 4.3 追加项目：仍然合法，id 出现，行尾符跟着原文件
  edit.appendProject(tmp, {
    id: 'gamma', name: 'gamma', path: 'D:\\work\\gamma',
    kind: 'material', intent: '追加的', next: '测一下',
  })
  const after3 = readFileSync(tmp, 'utf8')
  let doc3 = null
  try {
    doc3 = parseYaml(after3)
  } catch (error) {
    fail(`${label}: appendProject 之后 yaml 坏了 -> ${error.message}`)
  }
  const gamma = doc3?.projects.find((p) => p.id === 'gamma')
  if (!gamma) fail(`${label}: appendProject 没追加成功`)
  if (gamma?.kind !== 'material' || gamma?.status !== 'collecting') fail(`${label}: 追加时 kind/status 默认值不对`)
  if (eol === '\r\n' && after3.replace(/\r\n/g, '').includes('\n')) fail('CRLF: appendProject 把行尾符搞混了')

  if (existsSync(tmp)) rmSync(tmp)
}

// ── 5. 收尾 ──────────────────────────────────────────────────────────────
if (problems.length > 0) {
  console.error('\n✗ 自检失败：')
  for (const message of problems) console.error('  - ' + message)
  process.exit(1)
}
console.log(`\n✓ 自检通过：${projects.length} 个项目，${routes.length} 条路由`)
