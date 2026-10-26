// 证据折叠：把一个项目「最后真的动过」是什么时候算出来。
//
// 四路证据，取最大值：
//   1. DSH 会话   —— ~/.dsh/storages/session_projcache/sessions/*.json 的 identity.cwd + lastPromptAt
//   2. git 提交   —— git log -1 --format=%ct（只有 .git 的项目）
//   3. 文件改动   —— 目录内最新 mtime（有界遍历，跳过依赖与构建产物）
//   4. 任务看板   —— ledger-v2.json 里该工作区最后一张卡的执行时间
//
// 这一层是「只读、无副作用」的纯采集，不依赖 cordis，可以单独测。

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { execFileSync } from 'node:child_process'

export const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')

/** 遍历时跳过的目录名：依赖、虚拟环境、构建产物、版本库内部。 */
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.venv', 'venv', 'dist', 'build', 'release', 'out',
  '.next', '.cache', '__pycache__', '.pytest_cache', '.ruff_cache', '.idea', '.vscode',
  'coverage', '.turbo', 'target', 'bin', 'obj',
])

const MAX_FILES = 4000
const MAX_DEPTH = 6

/** 路径归一化：统一分隔符、去掉尾部分隔符、小写（Windows 大小写不敏感）。 */
export function normalizePath(value) {
  return String(value).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

function readJson(file, fallback = null) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

// ── 1. 会话索引 ───────────────────────────────────────────────────────────
let sessionCache = { at: 0, rows: [] }

/** 读全部会话投影快照，得到 [cwd, 最后活动时间]。60 秒缓存。 */
export function sessionIndex(now = Date.now()) {
  if (now - sessionCache.at < 60_000) return sessionCache.rows
  const dir = join(DSH_HOME, 'storages', 'session_projcache', 'sessions')
  const rows = []
  let names = []
  try {
    names = readdirSync(dir).filter((name) => name.endsWith('.json'))
  } catch {
    names = []
  }
  for (const name of names) {
    const record = readJson(join(dir, name))?.record
    const cwd = record?.identity?.cwd
    if (!cwd) continue
    const lastPromptAt = record?.rows?.sessionListMetadata?.val?.lastPromptAt
    const createdAt = record?.identity?.createdAt
    const lastAt = Math.max(Number(lastPromptAt) || 0, Number(createdAt) || 0)
    if (lastAt > 0) rows.push({ cwd: normalizePath(cwd), lastAt })
  }
  sessionCache = { at: now, rows }
  return rows
}

// ── 2. git ───────────────────────────────────────────────────────────────
function git(args, cwd) {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 4000,
      windowsHide: true,
    }).trim()
  } catch {
    return ''
  }
}

export function gitState(path) {
  if (!existsSync(join(path, '.git'))) return null
  const seconds = Number(git(['log', '-1', '--format=%ct'], path))
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], path)
  const status = git(['status', '--porcelain'], path)
  return {
    lastCommitAt: Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0,
    branch: branch || null,
    dirty: status !== '',
    dirtyAt: status === '' ? 0 : dirtyNewestMtime(path, status),
  }
}

/**
 * 工作区脏时，用「未提交文件的最新 mtime」当补充证据。
 * 只算 git 认为变过的文件 —— 所以 .gitignore、构建产物这类安装噪音不会污染信号。
 */
function dirtyNewestMtime(path, statusText) {
  let newest = 0
  for (const line of statusText.split('\n')) {
    const raw = line.slice(3).trim()
    if (raw === '') continue
    const target = raw.includes(' -> ') ? raw.split(' -> ').pop() : raw
    try {
      const stat = statSync(join(path, target.replace(/^"|"$/g, '')))
      if (stat.mtimeMs > newest) newest = stat.mtimeMs
    } catch {
      // 已删除的文件没有 mtime，忽略
    }
  }
  return newest
}

// ── 3. 文件改动 ───────────────────────────────────────────────────────────
/** 有界遍历，返回目录内最新的文件 mtime（毫秒）。 */
export function newestFileMtime(path) {
  let newest = 0
  let visited = 0
  const walk = (dir, depth) => {
    if (depth > MAX_DEPTH || visited >= MAX_FILES) return
    let entries = []
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (visited >= MAX_FILES) return
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name.toLowerCase())) continue
        walk(join(dir, entry.name), depth + 1)
      } else if (entry.isFile()) {
        visited += 1
        try {
          const stat = statSync(join(dir, entry.name))
          if (stat.mtimeMs > newest) newest = stat.mtimeMs
        } catch {
          // 单个文件读不到不影响整体判断
        }
      }
    }
  }
  walk(path, 0)
  return newest
}

// ── 4. 任务看板 ───────────────────────────────────────────────────────────
let boardCache = { at: 0, cards: [], workspaces: {} }

/** 看板卡片 + 工作区 id→路径 映射。60 秒缓存。 */
export function taskBoard(now = Date.now()) {
  if (now - boardCache.at < 60_000) return boardCache
  const ledger = readJson(join(DSH_HOME, 'task-board', 'ledger-v2.json'), {})
  const workspaceDoc = readJson(join(DSH_HOME, 'storages', 'workspace.json'), {})
  const workspaces = {}
  for (const [id, row] of Object.entries(workspaceDoc?.tables?.workspaces ?? {})) {
    if (row?.path) workspaces[id] = normalizePath(row.path)
  }
  const cards = Array.isArray(ledger?.tasks) ? ledger.tasks : []
  boardCache = { at: now, cards, workspaces }
  return boardCache
}

function boardEvidence(path) {
  const { cards, workspaces } = taskBoard()
  const target = normalizePath(path)
  let open = 0
  let lastAt = 0
  for (const card of cards) {
    const cardPath = card?.workspaceId ? workspaces[card.workspaceId] : undefined
    if (cardPath !== target) continue
    if (card.status !== 'done') open += 1
    for (const execution of card.executions ?? []) {
      const at = Number(execution?.endedAt ?? execution?.startedAt ?? 0)
      if (at > lastAt) lastAt = at
    }
  }
  return { openCards: open, lastAt }
}

// ── 汇总 ─────────────────────────────────────────────────────────────────
const DAY = 86_400_000

export function levelOf(days, settings) {
  if (days >= settings.zombieDays) return 'zombie'
  if (days >= settings.staleDays) return 'stale'
  return 'fresh'
}

/**
 * 折叠单个项目。返回机器算出来的那部分（人写的那部分原样带过）。
 * @param project - projects.yaml 里的一行
 * @param settings - {staleDays, zombieDays}
 * @param now - 毫秒时间戳，测试时可注入
 */
export function foldProject(project, settings, now = Date.now()) {
  const target = normalizePath(project.path)
  const sessions = sessionIndex(now).filter(
    (row) => row.cwd === target || row.cwd.startsWith(target + '/'),
  )
  const sessionAt = sessions.reduce((max, row) => Math.max(max, row.lastAt), 0)
  const git = gitState(project.path)
  // 有 git 就以提交时间为准（加上未提交改动）；没有 git 才退回去看文件 mtime。
  const fileAt = git ? git.dirtyAt : newestFileMtime(project.path)
  const board = boardEvidence(project.path)

  const lastAt = Math.max(sessionAt, git?.lastCommitAt ?? 0, fileAt, board.lastAt)
  const days = lastAt > 0 ? Math.floor((now - lastAt) / DAY) : null

  return {
    ...project,
    machine: {
      lastAt: lastAt || null,
      days,
      level: days === null ? 'unknown' : levelOf(days, settings),
      sessions: sessions.length,
      git,
      openCards: board.openCards,
    },
  }
}

/** 一次折叠全部项目，并按「最久没动」排序 —— 这就是首屏的顺序。 */
export function foldAll(doc, now = Date.now()) {
  const settings = {
    staleDays: Number(doc?.settings?.staleDays) || 5,
    zombieDays: Number(doc?.settings?.zombieDays) || 14,
    wipSoftLimit: Number(doc?.settings?.wipSoftLimit) || 3,
  }
  const projects = (Array.isArray(doc?.projects) ? doc.projects : []).map((project) =>
    foldProject(project, settings, now),
  )
  const weight = (project) => (project.machine.days === null ? 1e9 : project.machine.days)
  const isDone = (project) => project.status === 'shipped' || project.status === 'exported'
  const isShelved = (project) => project.status === 'shelved'

  // 首屏只放「还活着的」：已交付的进完成区，已认账的进搁置区。
  // 认账不做的项目如果还挂在榜首，就等于没请出去。
  const active = projects
    .filter((project) => !isDone(project) && !isShelved(project))
    .sort((a, b) => weight(b) - weight(a))
  const shelved = projects
    .filter(isShelved)
    .sort((a, b) => weight(b) - weight(a))
  const done = projects
    .filter(isDone)
    .sort((a, b) => (b.machine.lastAt ?? 0) - (a.machine.lastAt ?? 0))

  const wip = projects.filter((project) =>
    ['building', 'editing', 'collecting'].includes(project.status),
  ).length

  return {
    settings,
    active,
    shelved,
    done,
    summary: {
      total: projects.length,
      zombie: active.filter((project) => project.machine.level === 'zombie').length,
      stale: active.filter((project) => project.machine.level === 'stale').length,
      fresh: active.filter((project) => project.machine.level === 'fresh').length,
      wip,
      wipOver: wip > settings.wipSoftLimit,
      shelvedCount: shelved.length,
      doneCount: done.length,
    },
    at: new Date(now).toISOString(),
  }
}
