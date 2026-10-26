// dsh-project-board —— Host 半
//
// 路由：
//   GET  /project-board                旧网页版（保留当兜底）
//   GET  /project-board/data.json      同一份数据的 JSON（原生面板用这个）
//   POST /project-board/status         拖动改状态 → 按行改写 projects.yaml
//   POST /project-board/create         新建项目 → 追加一个块
//   POST /project-board/optimize       「描述」框的 AI 改写
//   POST /project-board/upload         上传素材 → 落到 <path>/素材/
//   POST /project-board/open           项目路径 → 工作区 id（客户端跳会话用）
//
// cordis 插件契约：
//   export const name / inject
//   export function apply(ctx, config)
//   ctx.webServer.register({kind, path, handler}) -> disposer
//
// 一律 fail-soft：这个插件坏掉时，代价只能是「面板打不开」，不能是「dsh web 起不来」。

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'

import { foldAll, normalizePath } from './evidence.js'
import { renderPage } from './page.js'
import {
  appendProject, deriveId, ensureDir, idsOf, materialDir, projectsOf,
  safeFileName, setStatus,
} from './edit.js'
import { optimizeText } from './ai.js'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const SOURCE = join(ROOT, 'projects.yaml')

export const name = 'project-board'
export const inject = ['webServer', 'llm', 'agentDefaultModel']

const CACHE_MS = 5000
let cache = { at: 0, data: null }

function loadDocument() {
  return parseYaml(readFileSync(SOURCE, 'utf8')) ?? {}
}

export function snapshot(now = Date.now()) {
  if (cache.data && now - cache.at < CACHE_MS) return cache.data
  const data = foldAll(loadDocument(), now)
  cache = { at: now, data }
  return data
}

/** 写盘之后必须让缓存失效，否则拖完还要等 5 秒才看见。 */
function invalidate() {
  cache = { at: 0, data: null }
}

function send(res, status, contentType, text) {
  res.writeHead(status, {
    'content-type': contentType,
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  })
  res.end(text)
}

const sendJson = (res, status, body) =>
  send(res, status, 'application/json; charset=utf-8', JSON.stringify(body))

const sendHtml = (res, status, html) => send(res, status, 'text/html; charset=utf-8', html)

const fail = (res, status, error) =>
  sendJson(res, status, { ok: false, error: String(error?.message ?? error) })

/** 读 JSON 请求体，带上限（素材走 base64，给到 40MB）。 */
function readJsonBody(req, limit = 40 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('请求体太大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (raw.trim() === '') return resolve({})
      try {
        resolve(JSON.parse(raw))
      } catch {
        reject(new Error('请求体不是合法 JSON'))
      }
    })
    req.on('error', reject)
  })
}

function failurePage(error) {
  const message = String(error?.message ?? error)
  return `<!doctype html><meta charset="utf-8"><title>项目进度 — 出错了</title>
<body style="font:14px/1.6 system-ui;padding:40px;max-width:760px;margin:0 auto">
<h1 style="font-size:18px">面板读不到数据</h1>
<pre style="white-space:pre-wrap;background:#f4f4f2;padding:12px;border-radius:8px">${message.replace(
    /[&<>]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c],
  )}</pre>
</body>`
}

export function apply(ctx) {
  const disposers = []
  const register = (path, handler) => {
    disposers.push(ctx.webServer.register({ kind: 'exact', path, handler }))
  }

  try {
    /* ── 只读 ────────────────────────────────────────────────── */
    register('/project-board', (_req, res) => {
      try {
        sendHtml(res, 200, renderPage(snapshot()))
      } catch (error) {
        console.error('[project-board] 渲染失败：', error)
        sendHtml(res, 500, failurePage(error))
      }
    })

    register('/project-board/data.json', (_req, res) => {
      try {
        sendJson(res, 200, { ok: true, source: SOURCE, ...snapshot() })
      } catch (error) {
        console.error('[project-board] 读取失败：', error)
        fail(res, 500, error)
      }
    })

    /* ── 拖动改状态 ──────────────────────────────────────────── */
    register('/project-board/status', async (req, res) => {
      try {
        if (req.method !== 'POST') return fail(res, 405, '只接受 POST')
        const body = await readJsonBody(req)
        const id = String(body.id ?? '').trim()
        const status = String(body.status ?? '').trim()
        if (id === '') return fail(res, 400, '缺少 id')
        const result = setStatus(SOURCE, id, status)
        invalidate()
        sendJson(res, 200, { ok: true, changed: result.changed, id, status, data: snapshot() })
      } catch (error) {
        console.error('[project-board] 改状态失败：', error)
        fail(res, 400, error)
      }
    })

    /* ── 新建项目 ────────────────────────────────────────────── */
    register('/project-board/create', async (req, res) => {
      try {
        if (req.method !== 'POST') return fail(res, 405, '只接受 POST')
        const body = await readJsonBody(req)
        const name = String(body.name ?? '').trim()
        if (name === '') return fail(res, 400, '项目名不能为空')
        const kind = body.kind === 'material' ? 'material' : 'code'
        const id = String(body.id ?? '').trim() || deriveId(name, idsOf(SOURCE))
        if (idsOf(SOURCE).includes(id)) return fail(res, 409, `id 已经存在：${id}`)
        appendProject(SOURCE, {
          id,
          name,
          kind,
          path: String(body.path ?? '').trim(),
          intent: String(body.intent ?? '').trim(),
          next: String(body.next ?? '').trim(),
        })
        invalidate()
        const created = projectsOf(SOURCE).find((project) => project.id === id) ?? { id, name }
        sendJson(res, 200, { ok: true, id, project: created, data: snapshot() })
      } catch (error) {
        console.error('[project-board] 新建失败：', error)
        fail(res, 400, error)
      }
    })

    /* ── AI 改写描述 ─────────────────────────────────────────── */
    register('/project-board/optimize', async (req, res) => {
      const abort = new AbortController()
      res.on('close', () => abort.abort())
      try {
        if (req.method !== 'POST') return fail(res, 405, '只接受 POST')
        const body = await readJsonBody(req, 64 * 1024)
        const result = await optimizeText(
          { llm: ctx.llm, agentDefaultModel: ctx.agentDefaultModel },
          body,
          abort.signal,
        )
        sendJson(res, 200, { ok: true, ...result })
      } catch (error) {
        console.error('[project-board] AI 改写失败：', error)
        fail(res, 502, error)
      }
    })

    /* ── 上传素材 ────────────────────────────────────────────── */
    register('/project-board/upload', async (req, res) => {
      try {
        if (req.method !== 'POST') return fail(res, 405, '只接受 POST')
        const body = await readJsonBody(req)
        const id = String(body.id ?? '').trim()
        const fileName = safeFileName(body.name)
        const base64 = String(body.data ?? '')
        if (id === '' || base64 === '') return fail(res, 400, '缺少 id 或文件内容')
        const project = projectsOf(SOURCE).find((row) => row.id === id)
        if (!project) return fail(res, 404, `没有这个项目：${id}`)
        const { dir } = materialDir(project, ROOT)
        ensureDir(dir)
        const target = join(dir, fileName)
        writeFileSync(target, Buffer.from(base64, 'base64'))
        sendJson(res, 200, { ok: true, saved: target, dir })
      } catch (error) {
        console.error('[project-board] 上传失败：', error)
        fail(res, 400, error)
      }
    })

    /* ── 项目路径 → 工作区 ───────────────────────────────────── */
    register('/project-board/open', async (req, res) => {
      let body = {}
      try {
        body = req.method === 'POST' ? await readJsonBody(req, 8 * 1024) : {}
      } catch {
        body = {}
      }
      let path = String(body.path ?? '').trim()
      if (path === '') {
        const url = new URL(req.url ?? '/', 'http://localhost')
        path = String(url.searchParams.get('path') ?? '').trim()
      }
      if (path === '') return fail(res, 400, '缺少 path')
      const target = normalizePath(path)
      const candidates = [ctx.workspaceRegistry, ctx.workspaceController, ctx.workspaces]
      for (const service of candidates) {
        if (!service || typeof service.resolveByPath !== 'function') continue
        try {
          const hit = await service.resolveByPath(path)
          if (hit) return sendJson(res, 200, { ok: true, workspaceId: hit.id ?? hit.workspaceId ?? null, path })
        } catch {
          // 换下一个候选
        }
      }
      sendJson(res, 200, { ok: true, workspaceId: null, path, target })
    })
  } catch (error) {
    console.error('[project-board] 插件未激活：', error)
    for (const dispose of disposers) dispose()
    return () => {}
  }

  return () => {
    for (const dispose of disposers) dispose()
  }
}
