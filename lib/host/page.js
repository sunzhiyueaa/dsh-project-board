// 面板页面：一个自包含的 HTML 字符串，没有构建、没有前端框架、没有外部请求。
// 数据由 /project-board/data.json 提供，页面打开即渲染；点「刷新」重新取一次。

const STATUS_LABEL = {
  building: '开发中',
  blocked: '卡住',
  paused: '搁置',
  shelved: '认账不做',
  shipped: '已交付',
  collecting: '收集中',
  editing: '制作中',
  exported: '已出片',
}

const LEVEL_LABEL = { zombie: '停滞', stale: '变慢', fresh: '在动', unknown: '无记录' }

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[char])
}

/** 天数 → 人话。 */
function since(days) {
  if (days === null || days === undefined) return '无记录'
  if (days <= 0) return '今天'
  if (days === 1) return '昨天'
  return `${days} 天`
}

function levelClass(project) {
  const { status, machine } = project
  if (status === 'shipped' || status === 'exported') return 'done'
  if (status === 'shelved') return 'shelved'
  return machine.level
}

function rowHtml(project) {
  const cls = levelClass(project)
  const git = project.machine.git
  const gitNote = git
    ? `${escapeHtml(git.branch ?? '?')}${git.dirty ? ' · 有未提交改动' : ''}`
    : project.kind === 'material'
      ? '不进版本控制'
      : '无版本控制'
  return `
    <tr class="row ${cls}">
      <td class="name">
        <div class="title">${escapeHtml(project.name)}</div>
        <div class="path" title="${escapeHtml(project.path)}">${escapeHtml(project.path)}</div>
      </td>
      <td><span class="kind ${escapeHtml(project.kind)}">${project.kind === 'code' ? '代码' : '素材'}</span></td>
      <td>
        <span class="status ${escapeHtml(project.status)}">${escapeHtml(STATUS_LABEL[project.status] ?? project.status)}</span>
        ${project.stage ? `<div class="stage">${escapeHtml(project.stage)}</div>` : ''}
      </td>
      <td class="work">
        <div class="next">${escapeHtml(project.next)}</div>
        <div class="intent">${escapeHtml(project.intent)}</div>
      </td>
      <td class="when">
        <div class="days">${escapeHtml(since(project.machine.days))}</div>
        <div class="meta">${escapeHtml(LEVEL_LABEL[project.machine.level] ?? '')}${
          project.machine.sessions > 0 ? ` · ${project.machine.sessions} 个会话` : ''
        }</div>
        <div class="meta">${gitNote}</div>
      </td>
    </tr>`
}

export function renderPage(data) {
  const { summary, settings, active, shelved, done, at } = data
  const wipNote = summary.wipOver
    ? `<span class="warn">⚠ ${summary.wip} 个在做，超过软上限 ${settings.wipSoftLimit}</span>`
    : ''
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>项目进度</title>
<style>
  :root { color-scheme: light dark; --fg:#1a1a19; --mute:#6b6b66; --line:#e4e4e0; --bg:#fdfdfc; --card:#fff;
          --red:#c0392b; --amber:#b7791f; --green:#2f855a; --grey:#8a8a85; }
  @media (prefers-color-scheme: dark) {
    :root { --fg:#e8e8e4; --mute:#9a9a94; --line:#2e2e2c; --bg:#161615; --card:#1d1d1c; }
  }
  * { box-sizing: border-box; }
  body { margin:0; padding:28px 20px 60px; background:var(--bg); color:var(--fg);
         font:14px/1.6 "Segoe UI", "Microsoft YaHei UI", system-ui, sans-serif; }
  .wrap { max-width:1080px; margin:0 auto; }
  h1 { font-size:19px; margin:0 0 2px; font-weight:600; letter-spacing:.01em; }
  .sub { color:var(--mute); font-size:12px; margin-bottom:18px; }
  .chips { display:flex; flex-wrap:wrap; gap:8px; align-items:center; margin-bottom:18px; }
  .chip { border:1px solid var(--line); background:var(--card); border-radius:999px;
          padding:3px 11px; font-size:12px; color:var(--mute); }
  .chip b { color:var(--fg); font-weight:600; }
  .chip.red b { color:var(--red); }
  .chip.amber b { color:var(--amber); }
  .chip.green b { color:var(--green); }
  .warn { color:var(--amber); font-size:12px; }
  table { width:100%; border-collapse:collapse; background:var(--card); border:1px solid var(--line);
          border-radius:10px; overflow:hidden; }
  th { text-align:left; font-size:11px; font-weight:600; color:var(--mute); text-transform:uppercase;
       letter-spacing:.06em; padding:10px 12px; border-bottom:1px solid var(--line); }
  td { padding:11px 12px; border-bottom:1px solid var(--line); vertical-align:top; }
  tr:last-child td { border-bottom:none; }
  tr.row.zombie { box-shadow: inset 3px 0 0 var(--red); }
  tr.row.stale  { box-shadow: inset 3px 0 0 var(--amber); }
  tr.row.fresh  { box-shadow: inset 3px 0 0 var(--green); }
  tr.row.shelved { box-shadow: inset 3px 0 0 var(--grey); opacity:.72; }
  tr.row.done { box-shadow: inset 3px 0 0 var(--green); opacity:.72; }
  .title { font-weight:600; }
  .path { color:var(--mute); font-size:11px; word-break:break-all; font-family:ui-monospace, Consolas, monospace; }
  .kind { font-size:11px; padding:1px 7px; border-radius:5px; border:1px solid var(--line); color:var(--mute); white-space:nowrap; }
  .kind.code { border-color:#7aa2c8; color:#7aa2c8; }
  .kind.material { border-color:#b48ead; color:#b48ead; }
  .status { font-size:12px; font-weight:600; }
  .status.blocked { color:var(--red); }
  .status.building, .status.editing, .status.collecting { color:var(--green); }
  .status.paused { color:var(--amber); }
  .status.shelved, .status.shipped, .status.exported { color:var(--grey); }
  .stage { font-size:11px; color:var(--mute); margin-top:2px; }
  .work .next { font-weight:500; }
  .work .intent { color:var(--mute); font-size:12px; margin-top:3px; }
  .when { white-space:nowrap; text-align:right; }
  .days { font-variant-numeric:tabular-nums; font-weight:600; }
  .meta { color:var(--mute); font-size:11px; }
  details { margin-top:22px; }
  summary { cursor:pointer; color:var(--mute); font-size:12px; }
  details table { margin-top:10px; }
  footer { margin-top:26px; color:var(--mute); font-size:11px; }
  button { font:inherit; font-size:12px; padding:4px 12px; border-radius:7px; cursor:pointer;
           border:1px solid var(--line); background:var(--card); color:var(--fg); }
  button:hover { border-color:var(--mute); }
  .empty { padding:26px; text-align:center; color:var(--mute); }
</style>
</head>
<body>
<div class="wrap">
  <h1>项目进度</h1>
  <div class="sub">按「最久没动」排在前面 · 生成于 ${escapeHtml(new Date(at).toLocaleString('zh-CN'))}
    <button id="reload">刷新</button>
  </div>

  <div class="chips">
    <span class="chip red"><b>${summary.zombie}</b> 个停滞</span>
    <span class="chip amber"><b>${summary.stale}</b> 个变慢</span>
    <span class="chip green"><b>${summary.fresh}</b> 个在动</span>
    <span class="chip"><b>${summary.wip}</b> 个在做</span>
    <span class="chip"><b>${summary.shelvedCount}</b> 个已认账</span>
    <span class="chip"><b>${summary.doneCount}</b> 个已完成</span>
    ${wipNote}
  </div>

  ${
    active.length === 0
      ? '<div class="empty">没有在进行的项目。</div>'
      : `<table>
    <thead><tr><th>项目</th><th>类型</th><th>状态</th><th>下一步 / 为了什么</th><th style="text-align:right">最后动静</th></tr></thead>
    <tbody>${active.map(rowHtml).join('')}</tbody>
  </table>`
  }

  ${
    shelved.length > 0
      ? `<details><summary>已认账不做 ${shelved.length} 个 —— 随时可以一句话捞回来</summary>
    <table><tbody>${shelved.map(rowHtml).join('')}</tbody></table></details>`
      : ''
  }

  ${
    done.length > 0
      ? `<details><summary>已完成 ${done.length} 个</summary>
    <table><tbody>${done.map(rowHtml).join('')}</tbody></table></details>`
      : ''
  }

  <footer>
    数据源：<code>projects.yaml</code>（人写 intent / next / status）+ DSH 会话记录 + git + 文件时间 + 任务看板。<br>
    红的判定只看时间，和状态无关：${settings.staleDays} 天没动变黄，${settings.zombieDays} 天变红。
  </footer>
</div>
<script>
  document.getElementById('reload').addEventListener('click', () => location.reload())
</script>
</body>
</html>`
}
