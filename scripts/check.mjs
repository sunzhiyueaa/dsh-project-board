// 离线自检：不启动 DSH，也能验证插件契约、YAML 结构、路由响应。
//   node scripts/check.mjs
// 任何一项不合格就 exit 1。

import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parse as parseYaml } from 'yaml'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const STATUS = {
  code: ['building', 'blocked', 'paused', 'shelved', 'shipped'],
  material: ['collecting', 'editing', 'paused', 'shelved', 'exported'],
}

const problems = []
const fail = (message) => problems.push(message)

// 1. projects.yaml 结构
const doc = parseYaml(readFileSync(join(ROOT, 'projects.yaml'), 'utf8'))
const settings = doc?.settings ?? {}
for (const key of ['staleDays', 'zombieDays', 'wipSoftLimit']) {
  if (typeof settings[key] !== 'number') fail(`settings.${key} 必须是数字，实际是 ${JSON.stringify(settings[key])}`)
}
if (settings.staleDays >= settings.zombieDays) fail('staleDays 必须小于 zombieDays')

const projects = Array.isArray(doc?.projects) ? doc.projects : fail('projects 必须是数组') ?? []
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

const wip = projects.filter((p) => p.status === 'building' || p.status === 'editing' || p.status === 'collecting').length
if (wip > settings.wipSoftLimit) {
  console.log(`⚠ 提醒（不算失败）：${wip} 个在做，超过软上限 ${settings.wipSoftLimit}`)
}

// 2. 插件契约 + 路由响应
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

const probe = routes.find((r) => r.path === '/project-board/data.json')
if (!probe) {
  fail('没有注册 /project-board/data.json')
} else {
  let status = 0
  let body = ''
  await probe.handler(
    { method: 'GET', url: '/project-board/data.json' },
    {
      writeHead: (code) => { status = code },
      end: (chunk) => { body = String(chunk ?? '') },
    },
  )
  if (status !== 200) fail(`路由返回 ${status}，期望 200`)
  try {
    const parsed = JSON.parse(body)
    if (parsed.ok !== true) fail('路由返回 JSON 的 ok 不为 true')
    if (parsed.projectCount !== projects.length) {
      fail(`路由报告 ${parsed.projectCount} 个项目，YAML 里是 ${projects.length}`)
    }
    console.log(`✓ 路由 200，项目数 ${parsed.projectCount}，来源 ${parsed.source}`)
  } catch {
    fail(`路由返回的不是合法 JSON：${body.slice(0, 200)}`)
  }
}

if (typeof dispose === 'function') dispose()

// 3. 收尾
if (problems.length > 0) {
  console.error('\n✗ 自检失败：')
  for (const message of problems) console.error('  - ' + message)
  process.exit(1)
}
console.log(`✓ 自检通过：${projects.length} 个项目，${routes.length} 条路由`)
