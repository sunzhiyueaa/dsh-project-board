// dsh-project-board —— 浏览器半边（手写 bundle，不走构建链）
//
// web shell 的客户端加载器不认裸 ESM：它用 window.__ModuleLoader__.load({id, factory})
// 收模块，factory 里 require() 取 react 与 @deepseek-ai/dsh-client-*（见 task-board 的
// lib/client.js 开头）。所以这里手写同一种外壳，内部一律 React.createElement：
// 没有 JSX、没有编译步骤，改完刷新页面就生效。
//
// 失败策略：apply() 里任何异常都必须吞掉 —— 客户端插件抛异常 = 整个 GUI 起不来。

window.__ModuleLoader__.load({
  id: "@local/dsh-project-board",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    const React = require("react");
    const h = React.createElement;
    const { useState, useEffect, useCallback, useRef } = React;

    /** 侧边栏行与中间列共用同一个 id。 */
    const PANEL_ID = "project-board";
    const inject = ["slots", "uiWorkspace"];

    const DATA_URL = "/project-board/data.json";
    const DAY = 86400000;

    /* ── 列定义：两套状态词表在列这一层被抹平 ───────────────────── */
    const COLS = [
      { id: "doing", name: "在做", statuses: ["building", "editing", "collecting"], drop: { code: "building", material: "editing" } },
      { id: "blocked", name: "卡住", statuses: ["blocked"], drop: { code: "blocked", material: "blocked" } },
      { id: "paused", name: "搁置", statuses: ["paused"], drop: { code: "paused", material: "paused" } },
      { id: "shipped", name: "已完成", statuses: ["shipped", "exported"], drop: { code: "shipped", material: "exported" } },
      { id: "shelved", name: "认账不做", statuses: ["shelved"], drop: { code: "shelved", material: "shelved" } },
    ];
    const STATUS_LABEL = {
      building: "开发中", blocked: "卡住", paused: "搁置", shelved: "认账不做", shipped: "已交付",
      collecting: "收集中", editing: "制作中", exported: "已出片",
    };

    /* ── 小工具 ─────────────────────────────────────────────────── */
    const pad = (n) => (n < 10 ? "0" + n : String(n));
    const mmdd = (at) => {
      const d = new Date(at);
      return pad(d.getMonth() + 1) + "-" + pad(d.getDate());
    };
    const cls = (...parts) => parts.filter(Boolean).join(" ");

    function allProjects(data) {
      if (!data) return [];
      return [].concat(data.active || [], data.shelved || [], data.done || []);
    }

    function colOf(project) {
      return COLS.find((c) => c.statuses.indexOf(project.status) >= 0) || COLS[0];
    }

    function evidence(project) {
      const m = project.machine || {};
      if (!m.lastAt) return "无动静";
      if (m.git && m.git.lastCommitAt) return "提交 " + mmdd(m.git.lastCommitAt);
      return "文件 " + mmdd(m.lastAt);
    }

    async function postJson(url, body) {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body || {}),
      });
      let json = {};
      try { json = await res.json(); } catch { json = {}; }
      if (!res.ok || json.ok === false) throw new Error(json.error || "HTTP " + res.status);
      return json;
    }

    /* ── 样式（只注入一次，全部挂在 .pb- 前缀下，不污染 GUI） ────── */
    const CSS = `
.pb-root{--pb-bg:var(--dsw-alias-bg-base,#151517);--pb-panel:var(--dsw-alias-bg-layer-1,#191919);
 --pb-card:var(--dsw-alias-bg-layer-2,#1e1e20);--pb-card-hi:var(--dsw-alias-bg-layer-3,#242427);
 --pb-ink:var(--dsw-alias-label-primary,#eceef1);--pb-label:var(--dsw-alias-label-secondary,#b9bdc4);
 --pb-mute:#8b9099;--pb-dim:#6f747c;--pb-hair:var(--dsw-alias-border-l1,rgba(255,255,255,.075));
 --pb-hair2:var(--dsw-alias-border-l2,rgba(255,255,255,.05));
 --pb-red:var(--dsw-alias-state-error-primary,#f25a5a);--pb-amber:var(--dsw-alias-state-warn-primary,#f7ad31);
 --pb-green:var(--dsw-alias-state-success-primary,#4ed17e);
 height:100%;min-height:0;display:flex;flex-direction:column;overflow:hidden;
 background:var(--pb-bg);color:var(--pb-ink);
 font-family:var(--dsw-font-family,-apple-system,"Segoe UI","Microsoft YaHei UI","Noto Sans SC",sans-serif);
 font-size:14px;line-height:1.6;-webkit-font-smoothing:antialiased;container-type:inline-size}
.pb-root *{box-sizing:border-box}
.pb-head{display:flex;align-items:baseline;gap:12px;padding:16px 22px 0;flex:none}
.pb-title{font-size:15px;font-weight:600;margin:0;letter-spacing:.01em}
.pb-meta{font-size:12px;color:var(--pb-mute);font-variant-numeric:tabular-nums}
.pb-tools{margin-left:auto;display:flex;align-items:center;gap:12px;font-size:12px;color:var(--pb-mute)}
.pb-btn{font:inherit;font-size:12px;color:var(--pb-label);background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.16);
 border-radius:7px;padding:4px 10px;height:28px;cursor:pointer;white-space:nowrap}
.pb-btn:hover{border-color:rgba(255,255,255,.24);color:var(--pb-ink)}
.pb-btn.primary{background:var(--pb-ink);color:var(--pb-bg);border-color:transparent;font-weight:600}
.pb-btn.primary:hover{opacity:.88;color:var(--pb-bg)}
.pb-btn:disabled{opacity:.45;cursor:default}
.pb-board{flex:1 1 auto;display:flex;gap:10px;padding:14px 14px 10px 22px;min-height:0;overflow-x:auto;overflow-y:hidden}
.pb-board::-webkit-scrollbar{height:8px}
.pb-board::-webkit-scrollbar-thumb{background:rgba(255,255,255,.12);border-radius:4px}
.pb-col{flex:1 1 0;min-width:150px;display:flex;flex-direction:column;min-height:0;border-radius:10px;
 border:1px solid transparent;background:var(--pb-panel);padding:10px 8px}
.pb-col.over{border-color:rgba(255,255,255,.28);background:#1d1d20}
.pb-ch{display:flex;align-items:baseline;gap:7px;padding:0 4px 9px}
.pb-ch .n{font-size:13px;font-weight:600;color:var(--pb-label)}
.pb-ch .c{font-size:12px;color:var(--pb-dim);font-variant-numeric:tabular-nums}
.pb-ch .warn{color:var(--pb-amber);font-size:12px;margin-left:auto}
.pb-ch .dot{width:5px;height:5px;border-radius:50%;flex:none;transform:translateY(-2px);background:var(--pb-dim)}
.pb-col[data-c=doing] .dot{background:var(--pb-green)}
.pb-col[data-c=blocked] .dot{background:var(--pb-amber)}
.pb-col[data-c=shipped] .dot{background:#5b8def}
.pb-col[data-c=shelved] .dot{background:#4a4a4d}
.pb-list{flex:1 1 auto;display:flex;flex-direction:column;gap:8px;overflow-y:auto;overflow-x:hidden;padding:0 2px 4px}
.pb-list::-webkit-scrollbar{width:6px}
.pb-list::-webkit-scrollbar-thumb{background:rgba(255,255,255,.1);border-radius:3px}
.pb-card{background:var(--pb-card);border:1px solid var(--pb-hair2);border-radius:8px;padding:10px 10px 9px;
 min-height:116px;display:flex;flex-direction:column;cursor:pointer;position:relative;
 transition:background .12s,border-color .12s,opacity .12s}
.pb-card:hover{background:var(--pb-card-hi);border-color:rgba(255,255,255,.14)}
.pb-card.dragging{opacity:.35}
.pb-top{display:flex;align-items:baseline;gap:6px}
.pb-nm{font-size:13px;font-weight:600;color:var(--pb-ink);line-height:1.35;flex:1 1 auto;min-width:0;
 display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere}
.pb-kd{flex:none;font-size:12px;color:var(--pb-dim)}
.pb-days{display:flex;align-items:baseline;gap:4px;margin-top:6px}
.pb-days b{font-size:21px;font-weight:300;letter-spacing:-.02em;line-height:1;font-variant-numeric:tabular-nums;color:var(--pb-dim)}
.pb-days i{font-size:12px;font-style:normal;color:var(--pb-dim)}
.pb-bar{height:4px;border-radius:2px;background:rgba(255,255,255,.11);margin-top:8px;position:relative;overflow:hidden}
.pb-bar i{position:absolute;left:0;top:0;bottom:0;border-radius:2px;background:var(--pb-dim)}
.pb-bar em{position:absolute;left:46.7%;top:0;bottom:0;width:1px;background:rgba(242,90,90,.75)}
.pb-nx{font-size:12px;color:var(--pb-label);line-height:1.5;margin-top:8px;
 display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.pb-ft{display:flex;align-items:baseline;gap:6px;margin-top:auto;padding-top:7px;font-size:12px;
 color:var(--pb-dim);font-variant-numeric:tabular-nums}
.pb-ft .go{margin-left:auto;color:rgba(255,255,255,.34);opacity:0;transition:opacity .12s}
.pb-card:hover .pb-ft .go{opacity:1}
.pb-card.z .pb-days b{color:var(--pb-red)} .pb-card.z .pb-bar i{background:var(--pb-red)}
.pb-card.s .pb-days b{color:var(--pb-amber)} .pb-card.s .pb-bar i{background:var(--pb-amber)}
.pb-card.f .pb-days b{color:var(--pb-green)} .pb-card.f .pb-bar i{background:var(--pb-green)}
.pb-card.mute{opacity:.62}
.pb-card.mute .pb-bar{display:none}
.pb-empty{font-size:12px;color:rgba(255,255,255,.22);padding:14px 6px;text-align:center;
 border:1px dashed rgba(255,255,255,.09);border-radius:8px}
.pb-ph{height:54px;border:1px dashed rgba(255,255,255,.3);border-radius:8px;display:flex;
 align-items:center;justify-content:center;font-size:12px;color:var(--pb-label)}
.pb-foot{flex:none;display:flex;align-items:baseline;gap:16px;padding:9px 22px 11px;
 border-top:1px solid var(--pb-hair2);font-size:12px;color:var(--pb-mute)}
.pb-foot kbd{font-family:inherit;font-size:12px;color:var(--pb-label);background:rgba(255,255,255,.06);
 border:1px solid var(--pb-hair);border-radius:4px;padding:1px 5px}
.pb-foot .r{margin-left:auto;color:rgba(255,255,255,.42)}
.pb-toast{position:fixed;left:50%;bottom:64px;transform:translateX(-50%) translateY(8px);
 background:var(--pb-card-hi,#242427);border:1px solid rgba(255,255,255,.14);border-radius:9px;padding:9px 14px;
 font-size:13px;color:var(--pb-ink);display:flex;align-items:center;gap:14px;opacity:0;pointer-events:none;
 transition:.18s;white-space:nowrap;z-index:60;box-shadow:0 10px 30px rgba(0,0,0,.45)}
.pb-toast.show{opacity:1;pointer-events:auto;transform:translateX(-50%) translateY(0)}
.pb-toast code{font-family:ui-monospace,Consolas,monospace;font-size:12px;color:#c9ccd2}
.pb-toast button{font:inherit;font-size:12px;color:#9db4d8;background:none;border:none;
 border-bottom:1px solid rgba(157,180,216,.35);cursor:pointer;padding:0}
/* 弹窗 */
.pb-mask{position:fixed;inset:0;background:rgba(0,0,0,.5);display:flex;align-items:center;
 justify-content:center;z-index:70;padding:24px}
.pb-modal{width:560px;max-width:100%;max-height:100%;overflow:auto;background:var(--pb-panel,#191919);
 border:1px solid rgba(255,255,255,.12);border-radius:12px;box-shadow:0 24px 60px rgba(0,0,0,.5)}
.pb-modal h3{margin:0;padding:16px 20px 0;font-size:15px;font-weight:600}
.pb-modal .sub{padding:4px 20px 0;font-size:12px;color:var(--pb-mute)}
.pb-form{padding:14px 20px 0}
.pb-field{margin-bottom:13px}
.pb-field label{display:block;font-size:12px;color:var(--pb-label);margin-bottom:5px}
.pb-field .hint{font-size:12px;color:var(--pb-dim);margin-left:6px}
.pb-field input[type=text],.pb-field textarea{width:100%;font:inherit;font-size:13px;color:var(--pb-ink);
 background:var(--pb-bg);border:1px solid var(--pb-hair);border-radius:7px;padding:8px 10px;outline:none}
.pb-field input[type=text]:focus,.pb-field textarea:focus{border-color:rgba(255,255,255,.3)}
.pb-field textarea{min-height:78px;resize:vertical;line-height:1.55}
.pb-seg{display:flex;gap:6px}
.pb-seg button{font:inherit;font-size:12px;padding:5px 14px;border-radius:7px;cursor:pointer;
 background:none;border:1px solid var(--pb-hair);color:var(--pb-label)}
.pb-seg button.on{background:rgba(255,255,255,.1);border-color:rgba(255,255,255,.3);color:var(--pb-ink)}
.pb-row{display:flex;align-items:center;gap:10px}
.pb-row .grow{flex:1 1 auto;min-width:0}
.pb-file{border:1px dashed var(--pb-hair);border-radius:7px;padding:9px 10px;font-size:12px;color:var(--pb-mute);
 cursor:pointer;display:flex;align-items:center;gap:8px}
.pb-file:hover{border-color:rgba(255,255,255,.26);color:var(--pb-label)}
.pb-file input{display:none}
.pb-file .pick{color:#9db4d8;border-bottom:1px solid rgba(157,180,216,.35)}
.pb-err{font-size:12px;color:var(--pb-red);padding:2px 0 0}
.pb-actions{display:flex;align-items:center;gap:10px;padding:4px 20px 18px}
.pb-actions .grow{flex:1 1 auto}
.pb-actions .pb-btn{height:30px;padding:4px 14px}
`;

    function ensureStyle() {
      if (document.getElementById("pb-style")) return;
      const style = document.createElement("style");
      style.id = "pb-style";
      style.textContent = CSS;
      document.head.appendChild(style);
    }

    /* ── 卡片 ───────────────────────────────────────────────────── */
    function Card(props) {
      const p = props.project;
      const days = p.machine && typeof p.machine.days === "number" ? p.machine.days : null;
      const level = (p.machine && p.machine.level) || "unknown";
      const levelCls = level === "zombie" ? "z" : level === "stale" ? "s" : level === "fresh" ? "f" : "mute";
      const width = days === null ? 0 : Math.max(3, (Math.min(days, 30) / 30) * 100);
      return h("div", {
        className: cls("pb-card", levelCls, props.dragging && "dragging"),
        draggable: true,
        onDragStart: (e) => {
          try {
            e.dataTransfer.effectAllowed = "move";
            e.dataTransfer.setData("text/plain", p.id);
          } catch {}
          props.onDragStart(p);
        },
        onDragEnd: props.onDragEnd,
        onClick: () => props.onOpen(p),
        title: p.intent || p.name,
      },
        h("div", { className: "pb-top" },
          h("span", { className: "pb-nm" }, p.name || p.id),
          h("span", { className: "pb-kd" }, p.kind === "material" ? "素材" : "代码"),
        ),
        h("div", { className: "pb-days" },
          h("b", null, days === null ? "—" : String(days)),
          days === null ? null : h("i", null, "天"),
        ),
        h("div", { className: "pb-bar" },
          h("i", { style: { width: width + "%" } }),
          h("em", null),
        ),
        h("div", { className: "pb-nx" }, p.next || "（还没有下一步）"),
        h("div", { className: "pb-ft" }, evidence(p), h("span", { className: "go" }, "进入")),
      );
    }

    /* ── 列 ─────────────────────────────────────────────────────── */
    function Column(props) {
      const col = props.col;
      const items = props.items;
      const warn = col.id === "doing" && props.wipOver;
      return h("div", {
        className: cls("pb-col", props.over && "over"),
        "data-c": col.id,
        onDragOver: (e) => { e.preventDefault(); props.onOver(col.id); },
        onDragLeave: () => props.onLeave(col.id),
        onDrop: (e) => { e.preventDefault(); props.onDrop(col, e); },
      },
        h("div", { className: "pb-ch" },
          h("span", { className: "dot" }),
          h("span", { className: "n" }, col.name),
          h("span", { className: "c" }, String(items.length)),
          warn ? h("span", { className: "warn" }, "超出上限 " + props.wipLimit) : null,
        ),
        h("div", { className: "pb-list" },
          props.over && props.dragId
            ? h("div", { className: "pb-ph" }, "松手 → " + col.name)
            : null,
          items.length === 0
            ? h("div", { className: "pb-empty" }, "拖到这里")
            : items.map((p) =>
                h(Card, {
                  key: p.id,
                  project: p,
                  dragging: props.dragId === p.id,
                  onDragStart: props.onDragStart,
                  onDragEnd: props.onDragEnd,
                  onOpen: props.onOpen,
                }),
              ),
        ),
      );
    }

    /* ── 新建项目弹窗 ───────────────────────────────────────────── */
    function CreateModal(props) {
      const [name, setName] = useState("");
      const [kind, setKind] = useState("code");
      const [next, setNext] = useState("");
      const [intent, setIntent] = useState("");
      const [path, setPath] = useState("");
      const [files, setFiles] = useState([]);
      const [busy, setBusy] = useState(false);
      const [aiBusy, setAiBusy] = useState(false);
      const [error, setError] = useState(null);
      const fileRef = useRef(null);

      useEffect(() => {
        const onKey = (e) => { if (e.key === "Escape" && !busy) props.onClose(); };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
      }, [busy, props]);

      const optimize = useCallback(async () => {
        if (intent.trim() === "" || aiBusy) return;
        setAiBusy(true);
        setError(null);
        try {
          const res = await postJson("/project-board/optimize", { text: intent, name: name, kind: kind });
          if (res.text) setIntent(res.text);
        } catch (err) {
          setError("优化失败：" + (err && err.message ? err.message : String(err)));
        } finally {
          setAiBusy(false);
        }
      }, [intent, name, kind, aiBusy]);

      const submit = useCallback(async () => {
        if (busy) return;
        if (name.trim() === "") { setError("先给项目起个名字"); return; }
        if (next.trim() === "") { setError("「要干的内容」不能空着"); return; }
        setBusy(true);
        setError(null);
        try {
          const created = await postJson("/project-board/create", {
            name: name.trim(),
            kind: kind,
            next: next.trim(),
            intent: intent.trim(),
            path: path.trim(),
          });
          for (const file of files) {
            const base64 = await readFileBase64(file);
            await postJson("/project-board/upload", { id: created.id, name: file.name, data: base64 });
          }
          props.onCreated(created.id, created.data, files.length);
        } catch (err) {
          setError("创建失败：" + (err && err.message ? err.message : String(err)));
        } finally {
          setBusy(false);
        }
      }, [busy, name, kind, next, intent, path, files, props]);

      return h("div", { className: "pb-mask", onClick: (e) => { if (e.target === e.currentTarget && !busy) props.onClose(); } },
        h("div", { className: "pb-modal" },
          h("h3", null, "新增项目"),
          h("div", { className: "sub" }, "写进 projects.yaml。名字和「要干的内容」是必填的，其余可以以后再补。"),
          h("div", { className: "pb-form" },
            h("div", { className: "pb-field" },
              h("label", null, "名称"),
              h("input", { type: "text", value: name, placeholder: "my-project", autoFocus: true,
                onChange: (e) => setName(e.target.value) }),
            ),
            h("div", { className: "pb-field" },
              h("label", null, "类型"),
              h("div", { className: "pb-seg" },
                h("button", { className: kind === "code" ? "on" : "", onClick: () => setKind("code"), type: "button" }, "代码"),
                h("button", { className: kind === "material" ? "on" : "", onClick: () => setKind("material"), type: "button" }, "素材"),
              ),
            ),
            h("div", { className: "pb-field" },
              h("label", null, "要干的内容", h("span", { className: "hint" }, "下一步那个具体动作")),
              h("input", { type: "text", value: next, placeholder: "审阅模式支持按字段混合合并",
                onChange: (e) => setNext(e.target.value) }),
            ),
            h("div", { className: "pb-field" },
              h("label", null, "描述", h("span", { className: "hint" }, "可以口语，能交给 AI 改写")),
              h("textarea", { value: intent, placeholder: "离线把多张 Excel 按规则匹配过滤并导出",
                onChange: (e) => setIntent(e.target.value) }),
              h("div", { style: { display: "flex", alignItems: "center", gap: 10, marginTop: 8 } },
                h("button", { className: "pb-btn", type: "button", disabled: aiBusy || intent.trim() === "", onClick: optimize },
                  aiBusy ? "优化中…" : "让 AI 改写"),
                h("span", { style: { fontSize: 12, color: "var(--pb-dim)" } }, "只改这段描述，不动别的"),
              ),
            ),
            h("div", { className: "pb-field" },
              h("label", null, "素材", h("span", { className: "hint" }, "可选，多个")),
              h("div", {
                className: "pb-file",
                onClick: () => fileRef.current && fileRef.current.click(),
              },
                h("input", { ref: fileRef, type: "file", multiple: true,
                  onChange: (e) => setFiles(Array.prototype.slice.call(e.target.files || [])) }),
                h("span", { className: "pick" }, files.length === 0 ? "选择文件" : "已选 " + files.length + " 个"),
                h("span", { style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } },
                  files.length === 0 ? "文件会存到 <项目路径>/素材/" : files.map((f) => f.name).join("、")),
              ),
            ),
            h("div", { className: "pb-field" },
              h("label", null, "路径", h("span", { className: "hint" }, "可选。给了路径才算得出「多久没动」")),
              h("input", { type: "text", value: path, placeholder: "留空也行，例如 D:\\work\\my-project",
                onChange: (e) => setPath(e.target.value) }),
            ),
            error ? h("div", { className: "pb-err" }, error) : null,
          ),
          h("div", { className: "pb-actions" },
            h("span", { className: "grow" }),
            h("button", { className: "pb-btn", type: "button", disabled: busy, onClick: props.onClose }, "取消"),
            h("button", { className: "pb-btn primary", type: "button", disabled: busy, onClick: submit },
              busy ? "创建中…" : "创建"),
          ),
        ),
      );
    }

    function readFileBase64(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          const text = String(reader.result || "");
          const comma = text.indexOf(",");
          resolve(comma >= 0 ? text.slice(comma + 1) : text);
        };
        reader.onerror = () => reject(new Error("读不了文件：" + file.name));
        reader.readAsDataURL(file);
      });
    }

    /* ── 主视图 ─────────────────────────────────────────────────── */
    function Board(props) {
      const ctx = props.ctx;
      const [data, setData] = useState(null);
      const [error, setError] = useState(null);
      const [loading, setLoading] = useState(true);
      const [dragId, setDragId] = useState(null);
      const [dragKind, setDragKind] = useState(null);
      const [overCol, setOverCol] = useState(null);
      const [modal, setModal] = useState(false);
      const [toast, setToast] = useState(null);
      const toastTimer = useRef(null);

      const load = useCallback(async () => {
        try {
          const res = await fetch(DATA_URL, { headers: { "cache-control": "no-cache" } });
          const json = await res.json();
          if (json && json.ok === false) throw new Error(json.error || "取数失败");
          setData(json);
          setError(null);
        } catch (err) {
          setError(err && err.message ? err.message : String(err));
        } finally {
          setLoading(false);
        }
      }, []);

      useEffect(() => { ensureStyle(); load(); }, [load]);

      const showToast = useCallback((text, undo) => {
        setToast({ text: text, undo: undo });
        if (toastTimer.current) clearTimeout(toastTimer.current);
        toastTimer.current = setTimeout(() => setToast(null), undo ? 4200 : 2600);
      }, []);

      const openProject = useCallback(async (project) => {
        try {
          if (!project.path) {
            showToast(project.name + " 还没登记路径，先补 projects.yaml 里的 path");
            return;
          }
          const where = await postJson("/project-board/open", { path: project.path });
          if (where.workspaceId && ctx.uiWorkspace && ctx.uiWorkspace.openWorkspace) {
            ctx.uiWorkspace.openWorkspace(where.workspaceId);
            return;
          }
          if (ctx.workspaces && ctx.workspaces.create) {
            const view = await ctx.workspaces.create({ path: project.path });
            const id = view && (view.id || view.workspaceId);
            if (id && ctx.uiWorkspace && ctx.uiWorkspace.openWorkspace) {
              ctx.uiWorkspace.openWorkspace(id);
              return;
            }
          }
          showToast("没找到也没能创建 " + project.name + " 的工作区");
        } catch (err) {
          showToast("进不去：" + (err && err.message ? err.message : String(err)));
        }
      }, [ctx, showToast]);

      const moveTo = useCallback(async (col) => {
        if (!dragId) return;
        const project = allProjects(data).find((p) => p.id === dragId);
        if (!project) return;
        const target = col.drop[dragKind === "material" ? "material" : "code"] || col.drop.code;
        if (project.status === target) return;
        const before = project.status;
        try {
          const res = await postJson("/project-board/status", { id: project.id, status: target });
          if (res.data) setData(res.data);
          showToast("已写回 " + project.id + " → " + (STATUS_LABEL[target] || target), async () => {
            try {
              const back = await postJson("/project-board/status", { id: project.id, status: before });
              if (back.data) setData(back.data);
            } catch (err) {
              showToast("撤销失败：" + (err && err.message ? err.message : String(err)));
            }
          });
        } catch (err) {
          showToast("写不进去：" + (err && err.message ? err.message : String(err)));
          load();
        }
      }, [dragId, dragKind, data, showToast, load]);

      const projects = allProjects(data);
      const total = projects.length;
      const wip = projects.filter((p) => ["building", "editing", "collecting"].indexOf(p.status) >= 0).length;
      const wipLimit = (data && data.settings && data.settings.wipSoftLimit) || 3;

      const header = h("div", { className: "pb-head" },
        h("h1", { className: "pb-title" }, "项目进度"),
        h("div", { className: "pb-meta" }, loading ? "读取中…" : total + " 个项目 · " + wip + " 个在做"),
        h("div", { className: "pb-tools" },
          h("span", null, data && data.at ? "更新于 " + mmdd(data.at).replace("-", "-") + " " + String(new Date(data.at).getHours()).padStart(2, "0") + ":" + pad(new Date(data.at).getMinutes()) : ""),
          h("button", { className: "pb-btn", onClick: () => { load(); }, type: "button" }, "刷新"),
          h("button", { className: "pb-btn primary", onClick: () => setModal(true), type: "button" }, "+ 新增项目"),
        ),
      );

      const body = error
        ? h("div", { style: { padding: "40px 24px", color: "var(--pb-mute)", fontSize: 13 } },
            "取数失败：" + error,
            h("div", { style: { marginTop: 10 } },
              h("button", { className: "pb-btn", onClick: load, type: "button" }, "重试")))
        : loading && !data
          ? h("div", { style: { padding: "40px 24px", color: "var(--pb-mute)", fontSize: 13 } }, "读取中…")
          : h("div", { className: "pb-board" },
              COLS.map((col) => h(Column, {
                key: col.id,
                col: col,
                items: projects
                  .filter((p) => col.statuses.indexOf(p.status) >= 0)
                  .sort((a, b) => ((b.machine && b.machine.days) || 0) - ((a.machine && a.machine.days) || 0)),
                over: overCol === col.id,
                dragId: dragId,
                wipOver: wip > wipLimit,
                wipLimit: wipLimit,
                onOver: (id) => setOverCol(id),
                onLeave: (id) => setOverCol((cur) => (cur === id ? null : cur)),
                onDrop: (c) => { setOverCol(null); setDragId(null); moveTo(c); },
                onDragStart: (p) => { setDragId(p.id); setDragKind(p.kind); },
                onDragEnd: () => { setDragId(null); setOverCol(null); },
                onOpen: openProject,
              })),
            );

      return h("div", { className: "pb-root" },
        header,
        body,
        h("div", { className: "pb-foot" },
          h("span", null, h("kbd", null, "拖"), " 改状态，写回 projects.yaml"),
          h("span", null, h("kbd", null, "单击"), " 进这个项目继续开发"),
          h("span", { className: "r" }, "天数只看机器时间，与状态无关 · 缓存 5 秒"),
        ),
        modal ? h(CreateModal, {
          onClose: () => setModal(false),
          onCreated: (id, fresh, fileCount) => {
            setModal(false);
            if (fresh) setData(fresh); else load();
            showToast("已新建 " + id + (fileCount ? "，素材 " + fileCount + " 个" : ""));
          },
        }) : null,
        toast ? h("div", { className: "pb-toast show" },
          h("span", null, toast.text),
          toast.undo ? h("button", { onClick: () => { const fn = toast.undo; setToast(null); fn(); }, type: "button" }, "撤销") : null,
        ) : null,
      );
    }

    /* ── 侧边栏图标 ─────────────────────────────────────────────── */
    function Icon(props) {
      const size = props && props.size ? props.size : 16;
      return h("svg", {
        viewBox: "0 0 16 16", width: size, height: size, fill: "none", stroke: "currentColor",
        strokeWidth: 1.3, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true",
      },
        h("rect", { x: 1.5, y: 2.5, width: 3.2, height: 11, rx: 1 }),
        h("rect", { x: 6.4, y: 2.5, width: 3.2, height: 7.5, rx: 1 }),
        h("rect", { x: 11.3, y: 2.5, width: 3.2, height: 4.5, rx: 1 }),
      );
    }

    function apply(ctx) {
      const disposers = [];
      try {
        if (typeof document !== "undefined") ensureStyle();
        const slots = ctx.slots;
        if (!slots || typeof slots.inject !== "function") {
          console.error("[project-board] 客户端没有 slots 服务，面板不挂载");
          return () => {};
        }
        disposers.push(
          slots.inject("sidebar.panellist", () =>
            slots.register(
              { name: "sidebar.panellist", id: PANEL_ID, order: 21, label: () => "项目进度" },
              Icon,
            ),
          ),
        );
        disposers.push(
          slots.inject("main", () =>
            slots.register({ name: "main", key: PANEL_ID, inject: () => ({ ctx: ctx }) }, Board),
          ),
        );
      } catch (error) {
        console.error("[project-board] 客户端挂载失败（已吞掉，不影响 GUI）：", error);
        for (const dispose of disposers.splice(0)) {
          try { dispose(); } catch {}
        }
        return () => {};
      }
      return () => {
        for (const dispose of disposers.splice(0)) {
          try { dispose(); } catch {}
        }
      };
    }

    exports.name = "project-board";
    exports.inject = inject;
    exports.apply = apply;
    exports.PANEL_ID = PANEL_ID;
    return module.exports;
  },
});
