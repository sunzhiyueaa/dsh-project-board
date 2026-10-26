// dsh-project-board —— Host 半（第 3 步：探针版）
//
// 目的是先证明一件事：这个插件能被 DSH 的 loader 加载、能拿到 webServer
// 服务、注册的路由能在 :3080 上真的响应。证明之后再往里加证据折叠逻辑。
//
// cordis 插件契约（从 task-board 插件源码确认）：
//   export const inject = [...服务名]   —— 声明依赖，缺失则插件不激活
//   export function apply(ctx, config)  —— 返回 disposer，卸载时调用
//   ctx.webServer.register({kind, path, handler}) -> disposer

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'

/** 本包根目录（lib/host/ 往上两级），projects.yaml 就住在这里 —— 数据与代码同源。 */
const ROOT = fileURLToPath(new URL('../../', import.meta.url))

export const name = 'project-board'
export const inject = ['webServer']

function sendJson(res, status, body) {
  const text = JSON.stringify(body, null, 2)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  })
  res.end(text)
}

function loadProjects() {
  const file = join(ROOT, 'projects.yaml')
  const doc = parseYaml(readFileSync(file, 'utf8'))
  return { doc, file }
}

export function apply(ctx) {
  const disposers = []

  disposers.push(
    ctx.webServer.register({
      kind: 'exact',
      path: '/project-board/data.json',
      handler: (_req, res) => {
        try {
          const { doc, file } = loadProjects()
          sendJson(res, 200, {
            ok: true,
            source: file,
            settings: doc?.settings ?? {},
            projectCount: Array.isArray(doc?.projects) ? doc.projects.length : 0,
            at: new Date().toISOString(),
          })
        } catch (error) {
          sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
        }
      },
    }),
  )

  return () => {
    for (const dispose of disposers) dispose()
  }
}
