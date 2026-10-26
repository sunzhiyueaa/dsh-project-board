// dsh-project-board —— Host 半
//
// 两条只读路由：
//   GET /project-board            面板页面
//   GET /project-board/data.json  同一份数据的 JSON
//
// cordis 插件契约（从 task-board 插件源码确认）：
//   export const inject = [...服务名]   —— 声明依赖，缺失则插件不激活
//   export function apply(ctx, config)  —— 返回 disposer，卸载时调用
//   ctx.webServer.register({kind, path, handler}) -> disposer
//
// 加载期一律 fail-soft：这个插件坏掉时，代价只能是「面板打不开」，
// 绝不能是「dsh web 起不来」。

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'

import { foldAll } from './evidence.js'
import { renderPage } from './page.js'

/** 本包根目录（lib/host/ 往上两级）——projects.yaml 与代码同源，不靠绝对路径常量。 */
const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const SOURCE = join(ROOT, 'projects.yaml')

export const name = 'project-board'
export const inject = ['webServer']

/** 整份结果缓存 5 秒：页面和数据接口同时被打开时不会重复扫盘。 */
const CACHE_MS = 5000
let cache = { at: 0, data: null }

function loadDocument() {
  const doc = parseYaml(readFileSync(SOURCE, 'utf8'))
  return doc ?? {}
}

/** 折叠一次全部项目（带 5 秒缓存）。 */
export function snapshot(now = Date.now()) {
  if (cache.data && now - cache.at < CACHE_MS) return cache.data
  const data = foldAll(loadDocument(), now)
  cache = { at: now, data }
  return data
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
  send(res, status, 'application/json; charset=utf-8', JSON.stringify(body, null, 2))

const sendHtml = (res, status, html) =>
  send(res, status, 'text/html; charset=utf-8', html)

function failurePage(error) {
  const message = String(error?.message ?? error)
  return `<!doctype html><meta charset="utf-8"><title>项目进度 — 出错了</title>
<body style="font:14px/1.6 system-ui;padding:40px;max-width:760px;margin:0 auto">
<h1 style="font-size:18px">面板读不到数据</h1>
<p>读 <code>projects.yaml</code> 或折叠证据时出错：</p>
<pre style="white-space:pre-wrap;background:#f4f4f2;padding:12px;border-radius:8px">${message.replace(
    /[&<>]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c],
  )}</pre>
<p>常见原因：YAML 缩进错、<code>kind</code>/<code>status</code> 拼错。可以先跑
<code>node scripts/check.mjs</code> 定位。</p>
</body>`
}

export function apply(ctx) {
  const disposers = []
  try {
    disposers.push(
      ctx.webServer.register({
        kind: 'exact',
        path: '/project-board',
        handler: (_req, res) => {
          try {
            sendHtml(res, 200, renderPage(snapshot()))
          } catch (error) {
            console.error('[project-board] 渲染失败：', error)
            sendHtml(res, 500, failurePage(error))
          }
        },
      }),
      ctx.webServer.register({
        kind: 'exact',
        path: '/project-board/data.json',
        handler: (_req, res) => {
          try {
            sendJson(res, 200, { ok: true, source: SOURCE, ...snapshot() })
          } catch (error) {
            console.error('[project-board] 读取失败：', error)
            sendJson(res, 500, { ok: false, source: SOURCE, error: String(error?.message ?? error) })
          }
        },
      }),
    )
  } catch (error) {
    // 注册失败（例如没有 webServer 服务）不能拖垮整个 Host。
    console.error('[project-board] 插件未激活：', error)
    for (const dispose of disposers) dispose()
    return () => {}
  }

  return () => {
    for (const dispose of disposers) dispose()
  }
}
