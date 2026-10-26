// 「描述」框的 AI 优化 —— Host 侧一次性调用，浏览器不碰模型。
//
// 做法抄自 task-board 的 host-ai.ts：模型只被要求产出纯文本，
// 回复当不可信输入处理（去掉代码围栏、限长、失败就返回原文，不让表单变空）。

const TIMEOUT_MS = 45_000
const MAX_REPLY = 400

const SYSTEM = [
  '你是一个技术项目登记助手。用户会用口语写一句「这个项目要干什么」，',
  '你把它改写成一条可以直接交给 AI 助手执行的项目说明，要求：',
  '- 中文，一段话，不超过 90 字，不要序号、不要 markdown、不要引号；',
  '- 说清三件事：要产出什么、给谁/为什么、边界或不做的事；',
  '- 保留用户原话里的专有名词、数字、工具名，不要自己发明新需求；',
  '- 只输出改写后的这一段文字，不要任何解释。',
].join('\n')

/** 从模型回复里收出可用的那段文字。 */
export function cleanReply(reply) {
  let text = String(reply ?? '')
    .replace(/```[a-zA-Z]*\s*/g, '')
    .replace(/```/g, '')
    .trim()
  // 模型偶尔会自带「改写后：」这种前缀
  text = text.replace(/^(改写后|优化后|项目说明|描述)[:：]\s*/, '')
  if (text.length > MAX_REPLY) text = text.slice(0, MAX_REPLY).trim()
  return text
}

/** 取默认模型路由；拿不到就报错，让上层回 503。 */
function routeOf(agentDefaultModel) {
  const selection = agentDefaultModel?.currentSelection?.()
  const provider = typeof selection?.provider === 'string' ? selection.provider.trim() : ''
  const model = typeof selection?.model === 'string' ? selection.model.trim() : ''
  if (provider === '' || model === '') return null
  return { provider, model }
}

/**
 * 一次性改写。
 * @param services - { llm, agentDefaultModel }
 * @param input - { text, name, kind }
 * @param signal - 客户端断开时取消
 */
export async function optimizeText(services, input, signal) {
  const text = String(input?.text ?? '').trim()
  if (text === '') throw new Error('描述是空的，没什么可优化')

  const route = routeOf(services.agentDefaultModel)
  if (!route) throw new Error('没有可用的默认模型（agentDefaultModel 没给出 provider/model）')
  const llm = services.llm
  if (!llm || typeof llm.stream !== 'function') throw new Error('Host 没有加载 llm 服务')

  const timeout = new AbortController()
  const timer = setTimeout(() => timeout.abort(), TIMEOUT_MS)
  const onAbort = () => timeout.abort()
  signal?.addEventListener('abort', onAbort, { once: true })

  const context = [
    input?.name ? `项目名：${String(input.name).trim()}` : '',
    input?.kind === 'material' ? '类型：素材型（产出是文件/片子，不是代码）' : '类型：代码型',
  ].filter(Boolean).join('\n')

  const messages = [{
    role: 'user',
    content: [{ type: 'text', text: `${context}\n\n用户原话：${text}` }],
    source: { kind: 'user' },
  }]

  try {
    const config = { provider: route.provider, model: route.model }
    let stream
    if (typeof llm.prepareCall === 'function') {
      const prepared = await llm.prepareCall(config, timeout.signal)
      stream = prepared.stream({ ...prepared.config, system: SYSTEM, messages, signal: timeout.signal })
    } else {
      stream = llm.stream({ ...config, system: SYSTEM, messages, signal: timeout.signal })
    }
    let reply = ''
    for await (const chunk of stream) {
      if (chunk?.type === 'text-delta') reply += chunk.text ?? ''
    }
    const clean = cleanReply(reply)
    if (clean === '') throw new Error('模型没有返回可用的文字')
    return { text: clean, provider: route.provider, model: route.model }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}
