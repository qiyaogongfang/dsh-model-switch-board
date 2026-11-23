// 任务路由 · Host 半边
//
// 五个工具：route_submit / route_status / route_result / route_cancel / route_backends。
// 另有系统提示段落，告诉主模型什么任务该丢给哪一层。
//
// 后端两种：
//   kind: 'llm'  —— 走 DSH 已注册的模型提供方（ctx.llm.stream），不用自己管 key；
//   kind: 'http' —— 直接打 OpenAI 兼容接口（本机 ollama、dsh-model 网关等）。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Router, defaultConfig, mergeConfig, jobLine, statusText } from './router.js'

export const name = 'task-router'
export const inject = ['tools', 'webServer']

const PLUGIN_ROOT = fileURLToPath(new URL('.', import.meta.url))

const text = (value) => [{ type: 'text', text: value }]
const str = (description, extra = {}) => ({ type: 'string', description, ...extra })

function checkArgs(args, schema) {
  const errors = []
  const input = args && typeof args === 'object' ? args : {}
  for (const key of schema.required || []) {
    if (input[key] === undefined || input[key] === '') errors.push(`缺少 ${key}`)
  }
  for (const [key, value] of Object.entries(input)) {
    const property = schema.properties[key]
    if (!property) {
      errors.push(`未知参数 ${key}`)
      continue
    }
    if (value === undefined || value === null) continue
    if (property.type === 'array') {
      if (!Array.isArray(value)) errors.push(`${key} 应该是字符串数组`)
    } else if (property.type === 'boolean') {
      if (typeof value !== 'boolean') errors.push(`${key} 应该是 true 或 false`)
    } else if (typeof value !== 'string') {
      errors.push(`${key} 应该是字符串`)
    } else if (property.enum && !property.enum.includes(value)) {
      errors.push(`${key} 只能是 ${property.enum.join(' / ')}`)
    }
  }
  if (errors.length) throw new Error(errors.join('；'))
  return input
}

// ---------------------------------------------------------------- 模型调用

function getLlm(ctx) {
  try {
    return ctx.get('llm')
  } catch {
    return undefined
  }
}

function usageText(usage) {
  if (!usage) return ''
  const input = usage.inputTokens ?? usage.input ?? usage.promptTokens
  const output = usage.outputTokens ?? usage.output ?? usage.completionTokens
  if (input === undefined && output === undefined) return ''
  return `token ${input ?? '?'}+${output ?? '?'}`
}

function abortable(signal, timeoutMs) {
  const controller = new AbortController()
  let timedOut = false
  const timer = timeoutMs
    ? setTimeout(() => {
        timedOut = true
        controller.abort()
      }, timeoutMs)
    : undefined
  const onAbort = () => controller.abort()
  if (signal) {
    if (signal.aborted) controller.abort()
    else signal.addEventListener('abort', onAbort, { once: true })
  }
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    dispose() {
      if (timer) clearTimeout(timer)
      if (signal) signal.removeEventListener('abort', onAbort)
    },
  }
}

export async function callHttpBackend(backend, prompt, signal) {
  const guard = abortable(signal, backend.timeoutMs)
  const headers = { 'content-type': 'application/json' }
  const key = resolveKey(backend)
  if (key) headers.authorization = `Bearer ${key}`
  const body = {
    model: backend.model,
    messages: [{ role: 'user', content: prompt }],
    stream: false,
    ...(backend.maxTokens ? { max_tokens: backend.maxTokens } : {}),
    ...(backend.temperature !== undefined ? { temperature: backend.temperature } : {}),
    ...(backend.extra && typeof backend.extra === 'object' ? backend.extra : {}),
  }
  try {
    const response = await fetch(`${String(backend.baseURL).replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: guard.signal,
    })
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      throw new Error(`HTTP ${response.status}${detail ? `：${detail.slice(0, 300)}` : ''}`)
    }
    const data = await response.json()
    const textOut = data?.choices?.[0]?.message?.content
    const usage = data?.usage ? { promptTokens: data.usage.prompt_tokens, completionTokens: data.usage.completion_tokens } : undefined
    return { text: typeof textOut === 'string' ? textOut : '', usage }
  } finally {
    guard.dispose()
  }
}

function makeCaller(ctx) {
  const llm = getLlm(ctx)

  return async (backend, { prompt, signal }) => {
    if (backend.kind === 'http') return callHttpBackend(backend, prompt, signal)
    if (backend.kind !== 'llm') throw new Error(`未知后端类型 ${backend.kind}（只支持 llm / http）`)

    const service = llm || getLlm(ctx)
    if (!service || typeof service.stream !== 'function') {
      throw new Error('LLM 服务不可用（ctx.get("llm") 拿不到），请在插件配置里改用 kind: http')
    }
    const guard = abortable(signal, backend.timeoutMs)
    let textOut = ''
    let usage
    let finish
    try {
      const stream = service.stream({
        provider: backend.provider,
        model: backend.model,
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
        ...(backend.maxTokens ? { maxTokens: backend.maxTokens } : {}),
        ...(backend.temperature !== undefined ? { temperature: backend.temperature } : {}),
        signal: guard.signal,
      })
      for await (const chunk of stream) {
        if (chunk.type === 'text-delta') textOut += chunk.text
        else if (chunk.type === 'usage') usage = chunk.usage
        else if (chunk.type === 'finish') finish = chunk.reason
      }
    } finally {
      guard.dispose()
    }
    if (guard.timedOut()) throw new Error(`超时（${Math.round((backend.timeoutMs || 0) / 1000)}s）`)
    if (finish && finish.kind === 'error') {
      const failure = finish.failure || {}
      throw new Error(`${failure.code || 'ERROR'}：${failure.message || '模型调用失败'}`)
    }
    if (finish && finish.kind === 'aborted') throw new Error('调用被中止')
    return { text: textOut, usage }
  }
}

function resolveKey(backend) {
  if (backend.apiKey) return backend.apiKey
  if (backend.apiKeyEnv && process.env[backend.apiKeyEnv]) return process.env[backend.apiKeyEnv]
  if (!backend.apiKeyFile) return ''
  try {
    const data = JSON.parse(fs.readFileSync(backend.apiKeyFile, 'utf8'))
    if (Array.isArray(data.keys)) {
      const hit = data.keys.find((item) => item && item.key)
      if (hit) return hit.key
    }
    if (typeof data.key === 'string') return data.key
  } catch {}
  return ''
}

// ---------------------------------------------------------------- 工具

function buildTools(router) {
  const SUBMIT_PARAMS = {
    type: 'object',
    additionalProperties: false,
    required: ['task'],
    properties: {
      task: str('要后台做什么：目标 + 输出格式。不要贴大段原文，文件用 files 传路径。'),
      tier: {
        type: 'string',
        enum: ['auto', 'cheap', 'standard', 'deep'],
        description: 'cheap=本机小模型（简单、批量、机械）；standard=本机 14b（一般文本）；auto=按内容判断；deep=不转交，留在主对话',
      },
      files: {
        type: 'array',
        items: { type: 'string' },
        description: '要处理/参考的文件的绝对路径（插件自己读，不经过主对话）',
      },
      output: str('可选：把完整结果写到这个绝对路径（同时仍会存一份到插件数据目录）'),
    },
  }

  const STATUS_PARAMS = {
    type: 'object',
    additionalProperties: false,
    properties: {
      job: str('只看某个任务 id；不填列出最近的'),
    },
  }

  const RESULT_PARAMS = {
    type: 'object',
    additionalProperties: false,
    required: ['job'],
    properties: {
      job: str('任务 id（route_submit 返回）'),
      full: { type: 'boolean', description: 'true 时返回全文（默认只给摘要）' },
    },
  }

  const CANCEL_PARAMS = {
    type: 'object',
    additionalProperties: false,
    required: ['job'],
    properties: { job: str('要取消的任务 id') },
  }

  return [
    {
      name: 'route_submit',
      description:
        '把任务丢进后台队列，立刻返回 job id，不占用主对话上下文。简单/机械文本走 cheap（本机 8b），一般文本走 standard（本机 14b），都不出网；复杂任务不要提交、留在主对话。要处理的文件传绝对路径。',
      parameters: SUBMIT_PARAMS,
      output: {
        schema: { type: 'object', additionalProperties: false, required: ['summary'], properties: { summary: { type: 'string' } } },
        render: (_args, value) => text(value.summary),
      },
      async execute(rawArgs, exec) {
        const args = checkArgs(rawArgs, SUBMIT_PARAMS)
        const sessionId = exec?.agent?.session?.header?.id
        const outcome = router.submit({
          task: args.task,
          tier: args.tier || 'auto',
          files: args.files || [],
          output: args.output,
          sessionId,
        })
        if (outcome.stayInMain) {
          return { summary: `未提交：${outcome.message}（tier=${outcome.tier}）` }
        }
        const lines = [
          `已提交 ${outcome.job.id} · ${outcome.label} · 后端 ${outcome.backends.join(' → ')}`,
          outcome.position > 0
            ? `排队第 ${outcome.position} 位，后台执行中；结果用 route_result 取（默认只回摘要）。`
            : '已开始执行，结果用 route_result 取（默认只回摘要）。',
        ]
        return { summary: lines.join('\n') }
      },
    },
    {
      name: 'route_status',
      description: '看后台队列：排队/运行/完成/失败，以及最近任务。',
      parameters: STATUS_PARAMS,
      output: {
        schema: { type: 'object', additionalProperties: false, required: ['summary'], properties: { summary: { type: 'string' } } },
        render: (_args, value) => text(value.summary),
      },
      async execute(rawArgs) {
        const args = checkArgs(rawArgs, STATUS_PARAMS)
        if (args.job) {
          const job = router.get(args.job)
          const usage = usageText(job.usage)
          return {
            summary: [
              jobLine(job),
              job.error ? `错误：${job.error}` : '',
              job.summary ? `摘要：${job.summary}` : '',
              usage ? `用量：${usage}` : '',
            ]
              .filter(Boolean)
              .join('\n'),
          }
        }
        const { items, counts, total } = router.list(12)
        const header = `后台任务：排队 ${counts.queued}，运行 ${counts.running}，完成 ${counts.done}，失败 ${counts.failed}（共 ${total}）`
        const lines = items.map((job) => jobLine(job))
        return { summary: [header, ...lines].join('\n') }
      },
    },
    {
      name: 'route_result',
      description: '取后台任务的结果：默认返回摘要和结果文件路径；full=true 才返回全文。',
      parameters: RESULT_PARAMS,
      output: {
        schema: { type: 'object', additionalProperties: false, required: ['summary'], properties: { summary: { type: 'string' } } },
        render: (_args, value) => text(value.summary),
      },
      async execute(rawArgs) {
        const args = checkArgs(rawArgs, RESULT_PARAMS)
        const job = router.get(args.job)
        if (job.status === 'queued' || job.status === 'running') {
          return { summary: `${job.id} 还在${statusText(job.status)}（${job.tier}，${job.backend || '等待调度'}），稍后再取。` }
        }
        if (job.status === 'failed') {
          return { summary: `${job.id} 失败：${job.error || '未知错误'}。可以换层级或换后端重新提交。` }
        }
        if (job.status === 'canceled') return { summary: `${job.id} 已取消。` }
        const result = router.readResult(job.id, { full: Boolean(args.full) })
        const usage = usageText(job.usage)
        const head = [
          `${job.id} 已完成 · ${job.tier} · ${job.backend || ''}${usage ? ` · ${usage}` : ''} · ${job.chars || 0} 字`,
          `结果文件：${job.resultPath}${job.output ? `；已另存 ${job.output}` : ''}`,
        ]
        return { summary: [head.join('\n'), '', result.text].join('\n') }
      },
    },
    {
      name: 'route_cancel',
      description: '取消排队中或运行中的后台任务。',
      parameters: CANCEL_PARAMS,
      output: {
        schema: { type: 'object', additionalProperties: false, required: ['summary'], properties: { summary: { type: 'string' } } },
        render: (_args, value) => text(value.summary),
      },
      async execute(rawArgs) {
        const args = checkArgs(rawArgs, CANCEL_PARAMS)
        const outcome = router.cancel(args.job)
        return { summary: `${outcome.job.id}：${outcome.message}` }
      },
    },
    {
      name: 'route_backends',
      description: '看任务路由现在挂了哪些层、哪些后端，以及 DSH 里实际可用的模型提供方和模型。',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      output: {
        schema: { type: 'object', additionalProperties: false, required: ['summary'], properties: { summary: { type: 'string' } } },
        render: (_args, value) => text(value.summary),
      },
      async execute() {
        const tierLines = []
        for (const [tier, cfg] of Object.entries(router.config.tiers)) {
          const backends = (cfg.backends || []).map((b) => b.label || b.model || b.provider || 'backend')
          tierLines.push(`${tier}（${cfg.label}，并发 ${cfg.concurrency}）：${cfg.stayInMain ? '留在主对话' : backends.join(' → ') || '未配置后端'}`)
        }
        const lines = ['## 配置的分层', ...tierLines]
        const service = getLlm(router.ctx)
        if (service && typeof service.listProviders === 'function') {
          try {
            const providers = service.listProviders()
            const ids = providers.map((item) => (typeof item === 'string' ? item : item?.provider ?? item?.id ?? item?.name)).filter(Boolean)
            lines.push('', `## DSH 模型提供方：${ids.join('、') || '（无）'}`)
            for (const id of ids.slice(0, 8)) {
              try {
                const models = await service.listModels(id)
                const names = (models || []).map((m) => (typeof m === 'string' ? m : m?.id ?? m?.name)).filter(Boolean)
                lines.push(`- ${id}：${names.slice(0, 12).join('、') || '（无模型）'}`)
              } catch (error) {
                lines.push(`- ${id}：读模型失败（${error.message}）`)
              }
            }
          } catch (error) {
            lines.push('', `读提供方失败：${error.message}`)
          }
        } else {
          lines.push('', 'ctx.get("llm") 不可用，只能走 kind: http 后端。')
        }
        return { summary: lines.join('\n') }
      },
    },
  ]
}

// ---------------------------------------------------------------- 对话看板

const DASH = '/tr/api'

function usageNumbers(usage) {
  if (!usage || typeof usage !== 'object') return { input: 0, output: 0 }
  const input = usage.inputTokens ?? usage.input ?? usage.promptTokens
  const output = usage.outputTokens ?? usage.output ?? usage.completionTokens
  return { input: Number(input) || 0, output: Number(output) || 0 }
}

function isLocalModel(provider, model) {
  return /ollama/i.test(provider || '') || /qwen|deepseek-r1/i.test(model || '')
}

function textOfContent(content) {
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join(' ').trim()
}

/** 读一个会话的事件，算出每个模型用了多少轮、多少 token，以及里面提交过哪些后台任务。 */
async function scanSession(sp, id, ctx) {
  let events = []
  let liveSeq

  // 正在运行的会话直接读内存，避免和写句柄抢锁；落盘的才走持久化读取。
  const live = ctx.get('sessions')?.get?.(id)
  if (live) {
    liveSeq = typeof live.seq === 'number' ? live.seq : undefined
    if (typeof live.snapshotEvents !== 'function') throw new Error('运行中会话没有 snapshotEvents，无法读取')
    try {
      events = live.snapshotEvents() || []
    } catch (error) {
      throw new Error(`读取运行中会话失败：${error.message}`)
    }
  } else {
    const handle = await sp.open(id, 'read')
    try {
      const result = await handle.read(0)
      events = result?.events || []
    } finally {
      try {
        await handle.close?.()
      } catch {}
    }
  }

  const models = new Map()
  const jobIds = new Set()
  const timeline = []
  let preview = ''
  let lastAt = 0
  for (const event of events) {
    if (event.type === 'assistant/message') {
      const source = event.data?.message?.source || {}
      const provider = String(source.provider || '')
      const model = String(source.model || '')
      const key = `${provider}/${model}`
      const local = isLocalModel(provider, model)
      const item = models.get(key) || {
        provider,
        model,
        local,
        turns: 0,
        input: 0,
        output: 0,
      }
      item.turns += 1
      const usage = usageNumbers(event.data?.usage)
      item.input += usage.input
      item.output += usage.output
      models.set(key, item)

      // 连续同一模型的参与段，用来回答「哪几轮是谁在跑」。
      const turn = Number.isFinite(event.data?.turn) ? event.data.turn : undefined
      const last = timeline[timeline.length - 1]
      if (last && last.key === key) {
        last.turns += 1
        if (turn !== undefined) last.lastTurn = turn
      } else {
        timeline.push({
          key,
          provider,
          model,
          local,
          turns: 1,
          firstTurn: turn,
          lastTurn: turn,
        })
      }
    } else if (event.type === 'user/message' && !preview) {
      const text = textOfContent(event.data?.message?.content || event.data?.content)
      if (text) preview = text.replace(/\s+/g, ' ').slice(0, 90)
    } else if (event.type === 'tool/result') {
      const raw = JSON.stringify(event.data || '')
      for (const hit of raw.match(/j_[a-z0-9]{6,}/g) || []) jobIds.add(hit)
    }
    if (typeof event.seq === 'number') lastAt = Math.max(lastAt, event.seq)
  }

  const list = [...models.values()]
  return {
    models: list,
    timeline: timeline.slice(0, 40),
    timelineTruncated: timeline.length > 40,
    turns: list.reduce((sum, item) => sum + item.turns, 0),
    input: list.reduce((sum, item) => sum + item.input, 0),
    output: list.reduce((sum, item) => sum + item.output, 0),
    preview,
    jobIds: [...jobIds],
    lastSeq: lastAt,
    liveSeq,
  }
}

/** 把后台任务的后端合并进「每个模型的 token 消耗」，本地 ollama 任务也会出现在表里。 */
function mergeJobModels(models, jobs) {
  const map = new Map((models || []).map((model) => [`${model.provider}/${model.model}`, { ...model }]))
  for (const job of jobs || []) {
    if (!job || !job.backend) continue
    if (!['done', 'running', 'completed'].includes(job.status)) continue
    const raw = String(job.backend).trim()
    let provider = 'job'
    let model = raw
    if (/^本机\s+/.test(raw)) {
      provider = 'ollama'
      model = raw.replace(/^本机\s+/, '')
    } else if (/^免费池\s+/.test(raw)) {
      const text = raw.replace(/^免费池\s+/, '')
      const slash = text.indexOf('/')
      provider = slash > 0 ? text.slice(0, slash) : 'free'
      model = slash > 0 ? text.slice(slash + 1) : text
    } else {
      const slash = raw.indexOf('/')
      provider = slash > 0 ? raw.slice(0, slash) : 'job'
      model = slash > 0 ? raw.slice(slash + 1) : raw
    }
    model = model.replace(/:latest$/, '')
    const key = `${provider}/${model}`
    const row = map.get(key) || {
      provider,
      model,
      local: isLocalModel(provider, model) || !job.api,
      turns: 0,
      input: 0,
      output: 0,
      jobs: 0,
    }
    row.turns += 1
    row.jobs = (row.jobs || 0) + 1
    row.input += Number(job.input) || 0
    row.output += Number(job.output) || 0
    map.set(key, row)
  }
  return [...map.values()]
}

const TIER_NAMES = { deep: '复杂', standard: '一般', cheap: '简单' }

function backendFromPatch(patch) {
  return {
    kind: 'llm',
    provider: String(patch.provider),
    model: String(patch.model),
    label: `${patch.provider}/${patch.model}`,
    timeoutMs: 300000,
    maxTokens: 4096,
  }
}

/** 把用户在面板里选的后端应用到某一层；stayInMain 表示这一层不转交。 */
function applyTierOverride(tierCfg, patch) {
  if (!tierCfg || !patch) return
  if (patch.stayInMain) {
    tierCfg.stayInMain = true
    tierCfg.backends = []
    return
  }
  if (!patch.provider || !patch.model) return
  tierCfg.stayInMain = false
  tierCfg.backends = [backendFromPatch(patch)]
  if (!tierCfg.concurrency) tierCfg.concurrency = 2
  if (!tierCfg.maxInputChars) tierCfg.maxInputChars = 12000
}

function describeTier(tierCfg) {
  if (!tierCfg) return {}
  if (tierCfg.stayInMain) return { stayInMain: true }
  const backend = (tierCfg.backends || [])[0]
  return backend
    ? { stayInMain: false, provider: backend.provider, model: backend.model, label: backend.label }
    : { stayInMain: false }
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > 1024 * 1024) {
        req.destroy()
        reject(new Error('请求体太大'))
      } else chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
      } catch {
        reject(new Error('请求体不是合法 JSON'))
      }
    })
    req.on('error', reject)
  })
}

function publicJob(job) {  const started = job.startedAt ? new Date(job.startedAt).getTime() : undefined
  const ended = job.endedAt ? new Date(job.endedAt).getTime() : undefined
  const usage = usageNumbers(job.usage)
  const backend = job.backend || ''
  return {
    id: job.id,
    tier: job.tier,
    backend,
    api: /免费池|free\//i.test(backend),
    status: job.status,
    task: String(job.task || '').replace(/\s+/g, ' ').slice(0, 80),
    input: usage.input,
    output: usage.output,
    ms: started && ended ? ended - started : undefined,
    createdAt: job.createdAt,
    error: job.error ? String(job.error).slice(0, 160) : undefined,
  }
}

function createDashboard(ctx, router, configState = {}) {
  const cacheFile = path.join(router.config.dataDir, 'dashboard-cache.json')
  let cache = {}
  try {
    cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8'))
  } catch {}
  const CACHE_VERSION = 4
  let computing = false

  const withTimeout = (work, ms, label) => {
    let timer
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} 超时`)), ms)
    })
    return Promise.race([work, timeout]).finally(() => clearTimeout(timer))
  }

  const saveCache = () => {
    try {
      const tmp = `${cacheFile}.tmp-${process.pid}`
      fs.mkdirSync(path.dirname(cacheFile), { recursive: true })
      fs.writeFileSync(tmp, JSON.stringify(cache))
      fs.renameSync(tmp, cacheFile)
    } catch {}
  }

  const sendJson = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(body))
  }

  async function listSessions(sp, limit) {
    const all = await sp.list()
    return all
      .map((snap) => ({ id: snap.header?.id, header: snap.header, revision: snap.revision, sizeBytes: snap.sizeBytes }))
      .filter(
        (snap) =>
          snap.id &&
          !/^(mnemon-run-|subagent-)/.test(snap.id) &&
          !snap.header?.parentSession &&
          snap.header?.origin !== 'subagent',
      )
      .sort((a, b) => (b.header?.createdAt || 0) - (a.header?.createdAt || 0))
      .slice(0, limit)
  }

  async function prefill(sp, sessions, force) {
    if (computing) return
    computing = true
    try {
      for (const session of sessions) {
        if (session.live) continue
        const cached = cache[session.id]
        if (!force && cached && cached.v === CACHE_VERSION && cached.revision === session.revision) continue
        if (!force && cached && cached.v === CACHE_VERSION && Date.now() - (cached.at || 0) < 15000) continue
        try {
          const stats = await withTimeout(scanSession(sp, session.id, ctx), 20000, `扫描 ${session.id}`)
          cache[session.id] = { v: CACHE_VERSION, revision: session.revision, at: Date.now(), stats }
        } catch (error) {
          cache[session.id] = { v: CACHE_VERSION, revision: session.revision, at: Date.now(), error: error.message }
        }
        saveCache()
      }
    } finally {
      computing = false
    }
  }

  async function refreshLive(sp, sessions) {
    const now = Date.now()
    for (const session of sessions) {
      if (!session.live) continue
      const live = ctx.get('sessions')?.get?.(session.id)
      const seq = typeof live?.seq === 'number' ? live.seq : undefined
      const cached = cache[session.id]
      if (cached && cached.v === CACHE_VERSION && cached.liveSeq === seq && cached.stats && now - (cached.at || 0) < 1500) continue
      try {
        const stats = await scanSession(sp, session.id, ctx)
        cache[session.id] = { v: CACHE_VERSION, liveSeq: seq, at: Date.now(), stats }
      } catch (error) {
        cache[session.id] = { v: CACHE_VERSION, liveSeq: seq, at: Date.now(), error: error.message }
      }
      saveCache()
    }
  }

  async function configPayload() {
    const tiers = {}
    for (const tier of ['deep', 'standard', 'cheap']) tiers[tier] = describeTier(router.config.tiers[tier])
    const options = []
    const llm = getLlm(ctx)
    if (llm && typeof llm.listProviders === 'function') {
      for (const raw of llm.listProviders()) {
        const id = typeof raw === 'string' ? raw : raw?.provider ?? raw?.id ?? raw?.name
        if (!id) continue
        let models = []
        try {
          models = await llm.listModels(id)
        } catch {
          models = []
        }
        for (const item of models || []) {
          const model = typeof item === 'string' ? item : item?.id ?? item?.name
          if (!model) continue
          options.push({ provider: String(id), model: String(model), label: `${id} / ${model}`, local: isLocalModel(id, model) })
        }
      }
    }
    return { ok: true, tiers, options, names: TIER_NAMES }
  }

  function saveOverrides() {
    if (!configState.file || !configState.overrides) return
    try {
      fs.mkdirSync(path.dirname(configState.file), { recursive: true })
      const tmp = `${configState.file}.tmp-${process.pid}`
      fs.writeFileSync(tmp, JSON.stringify(configState.overrides, null, 2))
      fs.renameSync(tmp, configState.file)
    } catch {}
  }

  return async function handler(req, res) {
    const url = new URL(req.url || '/', 'http://localhost')

    if (url.pathname === `${DASH}/config`) {
      if (req.method === 'GET') return sendJson(res, 200, await configPayload())
      if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: '只接受 GET 或 POST' })
      let body = {}
      try {
        body = await readRequestBody(req)
      } catch (error) {
        return sendJson(res, 400, { ok: false, error: error.message })
      }
      const tiersPatch = body?.tiers && typeof body.tiers === 'object' ? body.tiers : {}
      for (const tier of ['deep', 'standard', 'cheap']) {
        const patch = tiersPatch[tier]
        if (!patch || typeof patch !== 'object') continue
        if (patch.stayInMain) configState.overrides[tier] = { stayInMain: true }
        else if (typeof patch.provider === 'string' && typeof patch.model === 'string') {
          configState.overrides[tier] = { provider: patch.provider, model: patch.model }
        } else continue
        applyTierOverride(router.config.tiers[tier], configState.overrides[tier])
      }
      saveOverrides()
      return sendJson(res, 200, await configPayload())
    }

    if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: '只接受 GET' })
    if (url.pathname !== `${DASH}/dashboard`) return sendJson(res, 404, { ok: false, error: 'not found' })

    const force = url.searchParams.get('refresh') === '1'
    const sp = ctx.get('sessionPersistence')
    if (!sp) return sendJson(res, 200, { ok: true, error: '会话持久化服务不可用', items: [], totals: null })

    let sessions = []
    try {
      sessions = await listSessions(sp, Number(url.searchParams.get('limit') || 30))
    } catch (error) {
      return sendJson(res, 200, { ok: false, error: `列会话失败：${error.message}`, items: [], totals: null })
    }

    const liveIds = new Set()
    try {
      for (const session of ctx.get('sessions')?.list?.() || []) {
        const id = session?.header?.id
        if (id) liveIds.add(id)
      }
    } catch {}
    sessions = sessions.map((session) => ({ ...session, live: liveIds.has(session.id) }))
    await refreshLive(sp, sessions)

    const jobsBySession = new Map()
    for (const job of router.jobs.values()) {
      if (!job.sessionId) continue
      if (!jobsBySession.has(job.sessionId)) jobsBySession.set(job.sessionId, [])
      jobsBySession.get(job.sessionId).push(job)
    }

    const items = sessions.map((session) => {
      // 已结束的会话只认当前版本缓存；正在写的会话允许用旧版本缓存，否则它会一直空着。
      const raw = cache[session.id]
      const cached = raw && (raw.v === CACHE_VERSION || session.live) ? raw : undefined
      // 正在跑写的会话不读日志（会和写句柄抢锁），只展示上一次缓存的统计。
      const stats =
        cached?.stats && (session.live || cached.revision === session.revision) ? cached.stats : null
      const jobIds = new Set((jobsBySession.get(session.id) || []).map((job) => job.id))
      const jobs = [...jobIds].map((id) => router.jobs.get(id)).filter(Boolean).map(publicJob)
      const mergedModels = stats ? mergeJobModels(stats.models, jobs) : null
      const mergedTurns = mergedModels ? mergedModels.reduce((sum, row) => sum + row.turns, 0) : 0
      const mergedInput = mergedModels ? mergedModels.reduce((sum, row) => sum + row.input, 0) : 0
      const mergedOutput = mergedModels ? mergedModels.reduce((sum, row) => sum + row.output, 0) : 0
      return {
        id: session.id,
        live: Boolean(session.live),
        cwd: session.header?.cwd || '',
        createdAt: session.header?.createdAt || 0,
        sizeBytes: session.sizeBytes || 0,
        preview: (stats || cached?.stats)?.preview || '',
        stats: stats
          ? {
              models: mergedModels,
              turns: mergedTurns,
              input: mergedInput,
              output: mergedOutput,
              timeline: stats.timeline || [],
              timelineTruncated: Boolean(stats.timelineTruncated),
            }
          : null,
        error: cached?.revision === session.revision ? cached?.error : undefined,
        jobs,
      }
    })

    const totals = { sessions: items.length, apiTurns: 0, localTurns: 0, apiInput: 0, apiOutput: 0, localInput: 0, localOutput: 0, jobsLocal: 0, jobsApi: 0 }
    for (const item of items) {
      if (item.stats) {
        for (const model of item.stats.models) {
          if (model.local) {
            totals.localTurns += model.turns
            totals.localInput += model.input
            totals.localOutput += model.output
          } else {
            totals.apiTurns += model.turns
            totals.apiInput += model.input
            totals.apiOutput += model.output
          }
        }
      }
      for (const job of item.jobs) {
        if (job.status === 'done' || job.status === 'running' || job.status === 'queued') {
          if (job.api) totals.jobsApi += 1
          else totals.jobsLocal += 1
        }
      }
    }

    const pending = items.filter((item) => !item.stats && !item.error && !item.live).length
    if (pending > 0 || force) prefill(sp, sessions, force)

    return sendJson(res, 200, { ok: true, computing, pending, items, totals, now: Date.now() })
  }
}

// ---------------------------------------------------------------- 插件入口

export function apply(ctx, pluginConfig) {
  const config = mergeConfig(defaultConfig(PLUGIN_ROOT), pluginConfig)

  // 面板里改过的分层模型，重启后继续生效。
  const configFile = path.join(config.dataDir, 'models.json')
  const overrides = {}
  try {
    Object.assign(overrides, JSON.parse(fs.readFileSync(configFile, 'utf8')))
  } catch {}
  for (const tier of ['deep', 'standard', 'cheap']) applyTierOverride(config.tiers[tier], overrides[tier])

  const router = new Router(config, { call: makeCaller(ctx), log: (line) => ctx.logger?.debug?.(line) })
  router.ctx = ctx
  router.init()

  for (const tool of buildTools(router, ctx)) ctx.effect(() => ctx.tools.register(tool))

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'prefix',
      path: DASH,
      handler: createDashboard(ctx, router, { file: configFile, overrides }),
    }),
  )

  const systemPrompt = ctx.get('systemPrompt')
  if (systemPrompt) {
    ctx.effect(() =>
      systemPrompt.section({
        name: 'task-router',
        order: 43,
        text: () => router.promptText(),
      }),
    )
  }

  ctx.effect(() => () => router.close())
}
