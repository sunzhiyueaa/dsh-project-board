// projects.yaml 的最小改写层。
//
// 只做三件事，而且都按「行」改，不走 yaml 全量序列化：
//   1. setStatus  —— 找到 - id: <id> 那块，只换 status 一行
//   2. appendProject —— 在文件末尾追加一个项目块
//   3. 每次写之前复制一份 .bak，写完重新 parse 校验，校验不过就回滚
//
// 为什么不 dump 整份 yaml：那会把文件头的注释、字段顺序、空行全冲掉，
// 而这份文件是「人要看、要手改」的，注释就是它的一半价值。

import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { parse as parseYaml } from 'yaml'

/** 允许的状态词（两套词表合起来的全集）。 */
export const STATUS_SET = new Set([
  'building', 'blocked', 'paused', 'shelved', 'shipped',
  'collecting', 'editing', 'exported',
])

/** 每个 kind 新建时的默认状态。 */
export const DEFAULT_STATUS = { code: 'building', material: 'collecting' }

const escapeRe = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * 按行拆开，同时记住这份文件用的是 CRLF 还是 LF。
 * 用 `split('\n')` 会让每行末尾留一个 `\r`：
 * 正则里的 `$` 不认 `\r`，于是 `status:` 那行匹配不上，代码就走「插入一行 status」的分支，
 * 而插入用的缩进又是猜的 —— 出来的 yaml 直接是坏的。Windows 上 git 检出就是 CRLF，
 * 所以这个坑不是「偶尔」，是「必然」。
 */
function splitLines(text) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  return { lines: text.split(/\r?\n/), eol }
}

/** 读一份文本，备份，改，校验，成功才落盘。 */
function rewrite(source, transform) {
  const before = readFileSync(source, 'utf8')
  const after = transform(before)
  if (after === before) return { changed: false, text: before }
  // 校验：改出来的东西必须仍然是合法 yaml，且还是原来那些项目
  const parsedAfter = parseYaml(after)
  if (!parsedAfter || !Array.isArray(parsedAfter.projects)) {
    throw new Error('改写后不再是合法的 projects.yaml，已放弃')
  }
  if (existsSync(source)) copyFileSync(source, source + '.bak')
  writeFileSync(source, after, 'utf8')
  return { changed: true, text: after, doc: parsedAfter }
}

/**
 * 找到某个项目的行区间 [start, end)。
 * 块的结束 = 下一个同级 `- ` 行，或者缩进回退到父级的行，或者文件结束。
 * @param lines 全文按行拆开
 * @param id 项目 id
 */
function findBlock(lines, id) {
  const head = new RegExp('^(\\s*)-\\s+id:\\s*' + escapeRe(id) + '\\s*$')
  let start = -1
  let dashIndent = ''
  for (let i = 0; i < lines.length; i += 1) {
    const m = head.exec(lines[i])
    if (m) {
      start = i
      dashIndent = m[1]
      break
    }
  }
  if (start === -1) return null
  const next = new RegExp('^' + escapeRe(dashIndent) + '-\\s+')
  let end = lines.length
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i]
    if (next.test(line)) { end = i; break }
    // 缩进比 dash 还浅的非空行 = 已经出了 projects 列表
    if (/^\S/.test(line)) { end = i; break }
  }
  return { start, end, dashIndent }
}

/** 只改一个项目的 status。 */
export function setStatus(source, id, status) {
  if (!STATUS_SET.has(status)) throw new Error(`不认识的状态：${status}`)
  return rewrite(source, (text) => {
    const { lines, eol } = splitLines(text)
    const block = findBlock(lines, id)
    if (!block) throw new Error(`projects.yaml 里没有 id 为 ${id} 的项目`)
    const statusRe = /^(\s*)status:\s*.*$/
    let hit = -1
    for (let i = block.start + 1; i < block.end; i += 1) {
      if (statusRe.test(lines[i])) { hit = i; break }
    }
    if (hit === -1) {
      // 没有 status 行：插在 kind 后面，缩进照抄同一块里已有的键（不能猜）
      let anchor = block.start
      let anchorIndent = block.dashIndent + '  '
      const anchorOf = /^(\s*)(kind|name|path):/
      for (let i = block.start + 1; i < block.end; i += 1) {
        const m = anchorOf.exec(lines[i])
        if (m && m[2] === 'kind') { anchor = i; anchorIndent = m[1]; break }
      }
      if (anchor === block.start) {
        for (let i = block.start + 1; i < block.end; i += 1) {
          const m = anchorOf.exec(lines[i])
          if (m) { anchor = i; anchorIndent = m[1]; break }
        }
      }
      lines.splice(anchor + 1, 0, `${anchorIndent}status: ${status}`)
    } else {
      const indent = statusRe.exec(lines[hit])[1]
      lines[hit] = `${indent}status: ${status}`
    }
    return lines.join(eol)
  })
}

/** 把用户输入变成安全的单行 yaml 标量（双引号 + JSON 转义就是合法 yaml）。 */
function scalar(value) {
  return JSON.stringify(String(value ?? '').replace(/\r?\n/g, ' ').trim())
}

/** 按名字派生一个 id；中文名原样保留。 */
export function deriveId(name, taken) {
  const base = String(name ?? '').trim() || 'project'
  let id = base.replace(/\s+/g, '-')
  if (taken.includes(id)) {
    let n = 2
    while (taken.includes(`${id}-${n}`)) n += 1
    id = `${id}-${n}`
  }
  return id
}

/** 追加一个新项目到文件末尾（行尾符跟着原文件走）。 */
export function appendProject(source, project) {
  const kind = project.kind === 'material' ? 'material' : 'code'
  const status = STATUS_SET.has(project.status) ? project.status : DEFAULT_STATUS[kind]
  const path = String(project.path ?? '').trim()
  return rewrite(source, (text) => {
    const { eol } = splitLines(text)
    const block = [
      `  - id: ${project.id}`,
      `    name: ${scalar(project.name)}`,
      ...(path === '' ? [] : [`    path: ${scalar(path)}`]),
      `    kind: ${kind}`,
      `    status: ${status}`,
      `    intent: ${scalar(project.intent)}`,
      `    next: ${scalar(project.next)}`,
    ].join(eol)
    const trimmed = text.replace(/\s*$/, '')
    return trimmed + eol + eol + block + eol
  })
}

/** 当前所有 id（用来派生不重名的 id）。 */
export function idsOf(source) {
  const doc = parseYaml(readFileSync(source, 'utf8'))
  return (doc?.projects ?? []).map((p) => p?.id).filter(Boolean)
}

/** 当前所有项目（原始字段）。 */
export function projectsOf(source) {
  const doc = parseYaml(readFileSync(source, 'utf8'))
  return Array.isArray(doc?.projects) ? doc.projects : []
}

/** 上传的素材落到哪 —— 有 path 就放 <path>/素材，否则放仓库的 materials/<id>。 */
export function materialDir(project, fallbackRoot) {
  const base = String(project?.path ?? '').trim()
  const dir = base === '' ? `${fallbackRoot}/materials/${project.id}` : `${base}/素材`
  return { dir, created: !existsSync(dir) }
}

/** Windows 文件名消毒：只留最后一段名字，去掉非法字符。 */
export function safeFileName(name) {
  const base = String(name ?? '').split(/[\\/]/).pop() || 'file'
  return base.replace(/[<>:"|?*\u0000-\u001f]/g, '_').slice(0, 120)
}

export function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}
