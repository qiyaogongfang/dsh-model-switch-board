// 任务路由 · 队列与执行引擎（纯 Node，不依赖 DSH 运行时）
//
// 职责：
//   1. 接收任务（文本 + 文件路径），按层级入队；
//   2. 每层按并发上限在后台逐个跑，后端失败自动退下一个；
//   3. 结果落盘：全文 data/results/<id>.md，元数据 data/jobs/<id>.json；
//   4. 只把摘要交回主对话，长结果按需读取。
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const ID_ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz'

export function defaultConfig(pluginRoot) {
  return {
    dataDir: path.join(pluginRoot, 'data'),
    summaryChars: 800,
    maxResultChars: 200000,
    // 三层：复杂留在主对话，一般走本机 14b，简单走本机 8b；都不出网。
    tiers: {
      deep: {
        label: '复杂 · 主对话',
        concurrency: 0,
        stayInMain: true,
        maxInputChars: 200000,
        backends: [],
      },
      standard: {
        label: '一般 · 本机',
        concurrency: 2,
        maxInputChars: 12000,
        backends: [
          {
            kind: 'llm',
            label: '本机 deepseek-r1:14b',
            provider: 'ollama',
            model: 'deepseek-r1:14b',
            timeoutMs: 300000,
            maxTokens: 3072,
          },
        ],
      },
      cheap: {
        label: '简单 · 本机',
        concurrency: 1,
        maxInputChars: 12000,
        backends: [
          {
            kind: 'llm',
            label: '本机 qwen3.8',
            provider: 'ollama',
            model: 'qwen3.8:latest',
            timeoutMs: 300000,
            maxTokens: 3072,
          },
        ],
      },
    },
  }
}

/** 合并用户配置：tier 里只覆盖给出的字段，后端数组整体替换。 */
export function mergeConfig(base, override) {
  if (!override || typeof override !== 'object') return base
  const out = { ...base }
  for (const [key, value] of Object.entries(override)) {
    if (key === 'tiers' && value && typeof value === 'object') {
      out.tiers = { ...base.tiers }
      for (const [tier, cfg] of Object.entries(value)) {
        out.tiers[tier] = { ...(base.tiers[tier] || {}), ...cfg }
      }
    } else if (value !== undefined) out[key] = value
  }
  return out
}

const CHEAP_HINTS = /(摘要|总结|抽取|提取|分类|打标签|归类|翻译|润色|改写|精简|格式化|转换|整理成|列出|校对|错别字|关键词|标签|提取|去重|排序)/i
const DEEP_HINTS = /(架构|设计|重构|调试|报错|为什么|分析|评审|审核|方案|规划|迁移|性能|安全|接口|代码|实现|排查|debug|review)/i

export function classify(task, files = []) {
  const text = String(task || '')
  if (files.length > 0 && files.length > 20) return 'standard'
  if (DEEP_HINTS.test(text) && text.length > 300) return 'deep'
  if (CHEAP_HINTS.test(text)) return 'cheap'
  if (text.length > 4000) return 'standard'
  return 'standard'
}

function makeId() {
  const now = Date.now().toString(36)
  let tail = ''
  const bytes = crypto.randomBytes(3)
  for (const b of bytes) tail += ID_ALPHABET[b % ID_ALPHABET.length]
  return `j_${now}${tail}`
}

function atomicWrite(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(tmp, content)
  fs.renameSync(tmp, file)
}

function readFileText(file, maxChars) {
  const stat = fs.statSync(file)
  if (!stat.isFile()) throw new Error(`不是文件：${file}`)
  const raw = fs.readFileSync(file)
  if (raw.includes(0)) throw new Error(`看起来是二进制文件，跳过：${file}`)
  const text = raw.toString('utf8')
  if (text.length > maxChars) {
    throw new Error(`文件太大：${file}（${text.length} 字，上限 ${maxChars}）。请先拆分，或改用标准层。`)
  }
  return text
}

function collapse(text, limit) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim()
  if (flat.length <= limit) return flat
  return `${flat.slice(0, limit)}…`
}

function formatDuration(ms) {
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m${seconds % 60}s`
}

export class Router {
  /**
   * @param {object} config 合并后的配置
   * @param {{ call: (backend, request) => Promise<{text: string, usage?: object}>, log?: Function }} options
   */
  constructor(config, { call, log } = {}) {
    this.config = config
    this.call = call
    this.log = log || (() => {})
    this.jobs = new Map()
    this.controllers = new Map()
    this.timers = new Map()
    this.dirty = new Set()
  }

  get jobsDir() {
    return path.join(this.config.dataDir, 'jobs')
  }

  get resultsDir() {
    return path.join(this.config.dataDir, 'results')
  }

  init() {
    fs.mkdirSync(this.jobsDir, { recursive: true })
    fs.mkdirSync(this.resultsDir, { recursive: true })
    let files = []
    try {
      files = fs.readdirSync(this.jobsDir).filter((name) => name.endsWith('.json'))
    } catch {}
    for (const name of files) {
      try {
        const job = JSON.parse(fs.readFileSync(path.join(this.jobsDir, name), 'utf8'))
        if (!job || !job.id) continue
        if (job.status === 'running') {
          job.status = 'failed'
          job.endedAt = job.endedAt || new Date().toISOString()
          job.error = job.error || 'DSH 进程重启，任务中断（可重新提交）'
          this.save(job)
        }
        this.jobs.set(job.id, job)
      } catch (error) {
        this.log(`跳过损坏的任务记录 ${name}：${error.message}`)
      }
    }
    this.pump()
  }

  close() {
    for (const timer of this.timers.values()) clearTimeout(timer)
    for (const controller of this.controllers.values()) controller.abort()
    this.timers.clear()
    this.controllers.clear()
  }

  save(job) {
    atomicWrite(path.join(this.jobsDir, `${job.id}.json`), JSON.stringify(job, null, 2))
  }

  /** 提交任务。deep 层不转交，直接告诉调用方留在主对话。 */
  submit({ task, tier = 'auto', files = [], output, sessionId } = {}) {
    const text = String(task || '').trim()
    if (!text) throw new Error('缺少 task：要交给后台做什么')
    const chosen = tier === 'auto' ? classify(text, files) : tier
    const tierCfg = this.config.tiers[chosen]
    if (!tierCfg) throw new Error(`未知层级 ${chosen}，可选 auto / deep / standard / cheap`)

    if (tierCfg.stayInMain) {
      return {
        stayInMain: true,
        tier: chosen,
        label: tierCfg.label,
        message: '这是复杂任务，留在主对话做，不转交。',
      }
    }
    if (!Array.isArray(tierCfg.backends) || tierCfg.backends.length === 0) {
      throw new Error(`层级 ${chosen} 没有配置后端，先在插件配置里补上 backends。`)
    }

    const fileList = (files || []).map((item) => String(item)).filter(Boolean)
    if (!Array.isArray(fileList)) throw new Error('files 应该是路径字符串数组')
    const resolved = fileList.map((file) => path.resolve(file))
    const contents = resolved.map((file) => ({
      path: file,
      name: path.basename(file),
      text: readFileText(file, tierCfg.maxInputChars),
    }))
    const prompt = buildPrompt(text, contents)
    if (prompt.length > tierCfg.maxInputChars) {
      throw new Error(
        `任务内容 ${prompt.length} 字，超过「${tierCfg.label}」上限 ${tierCfg.maxInputChars} 字。请拆小，或用更高层级。`,
      )
    }

    const job = {
      id: makeId(),
      sessionId: sessionId || undefined,
      tier: chosen,
      status: 'queued',
      task: text,
      files: resolved,
      output: output ? path.resolve(output) : undefined,
      backend: undefined,
      attempts: [],
      createdAt: new Date().toISOString(),
      summary: '',
      resultPath: undefined,
      usage: undefined,
      error: undefined,
    }
    this.jobs.set(job.id, job)
    this.save(job)
    this.pump()
    const position = this.queuePosition(job.id)
    return {
      job,
      tier: chosen,
      label: tierCfg.label,
      position,
      backends: (tierCfg.backends || []).map((b) => b.label || b.model || b.provider || 'backend'),
    }
  }

  queuePosition(jobId) {
    const job = this.jobs.get(jobId)
    if (!job) return 0
    const queue = [...this.jobs.values()]
      .filter((item) => item.tier === job.tier && item.status === 'queued')
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
    return queue.findIndex((item) => item.id === jobId) + 1
  }

  pump() {
    for (const [tier, cfg] of Object.entries(this.config.tiers)) {
      const limit = Number(cfg.concurrency || 0)
      if (limit <= 0) continue
      const running = [...this.jobs.values()].filter((j) => j.tier === tier && j.status === 'running').length
      if (running >= limit) continue
      const queued = [...this.jobs.values()]
        .filter((j) => j.tier === tier && j.status === 'queued')
        .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
      for (const job of queued.slice(0, limit - running)) this.start(job)
    }
  }

  start(job) {
    job.status = 'running'
    job.startedAt = new Date().toISOString()
    this.save(job)
    const controller = new AbortController()
    this.controllers.set(job.id, controller)
    this.run(job, controller).finally(() => {
      this.controllers.delete(job.id)
      this.pump()
    })
  }

  async run(job, controller) {
    const tierCfg = this.config.tiers[job.tier]
    const contents = []
    for (const file of job.files) {
      try {
        contents.push({ path: file, name: path.basename(file), text: readFileText(file, tierCfg.maxInputChars) })
      } catch (error) {
        return this.fail(job, `读取文件失败：${error.message}`)
      }
    }
    const prompt = buildPrompt(job.task, contents)

    for (const backend of tierCfg.backends || []) {
      if (controller.signal.aborted) return this.fail(job, '任务已取消')
      const started = Date.now()
      job.backend = backend.label || backend.model || backend.provider || 'backend'
      this.save(job)
      try {
        const result = await this.call(backend, {
          prompt,
          signal: controller.signal,
        })
        const text = String(result?.text || '').trim()
        if (!text) throw new Error('模型没有返回内容')
        job.attempts.push({ backend: job.backend, ok: true, ms: Date.now() - started })
        return this.finish(job, text, result.usage)
      } catch (error) {
        const message = controller.signal.aborted ? '任务已取消' : error.message || String(error)
        job.attempts.push({ backend: job.backend, ok: false, ms: Date.now() - started, error: message })
        if (controller.signal.aborted) return this.fail(job, '任务已取消')
        this.log(`后端 ${job.backend} 失败：${message}`)
      }
    }
    return this.fail(job, `所有后端都失败：${job.attempts.map((a) => `${a.backend}=${a.error}`).join('；')}`)
  }

  finish(job, text, usage) {
    const summary = collapse(text, this.config.summaryChars)
    const resultPath = path.join(this.resultsDir, `${job.id}.md`)
    try {
      atomicWrite(resultPath, text)
      if (job.output) {
        atomicWrite(job.output, text)
      }
    } catch (error) {
      this.log(`写结果文件失败：${error.message}`)
    }
    job.status = 'done'
    job.endedAt = new Date().toISOString()
    job.summary = summary
    job.chars = text.length
    job.resultPath = resultPath
    job.usage = usage
    this.save(job)
  }

  fail(job, error) {
    job.status = 'failed'
    job.endedAt = new Date().toISOString()
    job.error = String(error)
    this.save(job)
  }

  get(jobId) {
    const job = this.jobs.get(String(jobId || '').trim())
    if (!job) throw new Error(`找不到任务 ${jobId}，用 route_status 看队列。`)
    return job
  }

  list(limit = 12) {
    const items = [...this.jobs.values()].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    const counts = { queued: 0, running: 0, done: 0, failed: 0, canceled: 0 }
    for (const job of items) if (counts[job.status] !== undefined) counts[job.status] += 1
    return { items: items.slice(0, limit), counts, total: items.length }
  }

  cancel(jobId) {
    const job = this.get(jobId)
    if (job.status === 'done' || job.status === 'failed' || job.status === 'canceled') {
      return { job, message: `任务已经是 ${statusText(job.status)}，不需要取消。` }
    }
    const controller = this.controllers.get(job.id)
    if (controller) controller.abort()
    job.status = 'canceled'
    job.endedAt = new Date().toISOString()
    this.save(job)
    return { job, message: '已取消。' }
  }

  readResult(jobId, { full = false } = {}) {
    const job = this.get(jobId)
    let text = ''
    if (job.resultPath) {
      try {
        text = fs.readFileSync(job.resultPath, 'utf8')
      } catch {}
    }
    const limit = full ? this.config.maxResultChars : this.config.summaryChars
    const body = text.length > limit ? `${text.slice(0, limit)}…（还有 ${text.length - limit} 字，读文件 ${job.resultPath}）` : text
    return { job, text: body, truncated: text.length > limit }
  }

  /** 系统提示里的段落：指引 + 当前队列概况。 */
  promptText() {
    const { items, counts } = this.list(5)
    const recent = items
      .filter((job) => job.status === 'done' || job.status === 'failed')
      .slice(0, 3)
      .map((job) => `${job.id}（${job.tier}，${job.status === 'done' ? '完成' : '失败'}）：${collapse(job.task, 24)}`)
    const describe = (tier) => {
      const cfg = this.config.tiers[tier]
      if (!cfg) return ''
      if (cfg.stayInMain) return `${tier}=留在主对话`
      const backend = (cfg.backends || [])[0]
      return backend ? `${tier}=${backend.label || backend.model || backend.provider}` : `${tier}=未配置`
    }
    const tiers = ['cheap', 'standard', 'deep'].map(describe).filter(Boolean).join('，')
    const lines = [
      '# 任务路由',
      `简单和一般的文本任务不要自己硬做，也不要整段搬进上下文：用 route_submit 丢给后台（${tiers}），后台跑完只回摘要。模型可以随时在「模型切换看板」里改。`,
      '- 机械、可验证的编码活也可以外包：批量替换/重命名、格式化、按模板生成样板、数据格式转换（CSV/JSON/SQL）、翻译注释、生成测试数据、把日志归类。规则要写死，files 传路径，output 指到临时文件；拿回来自己 diff + 编译/测试验收，不合格退回或自己改。',
      '- 设计、跨文件重构、调试、并发正确性、需要当前对话或代码上下文的任务，留在主对话做；不要为了省 token 把这类任务塞给弱模型。',
      '- 提交时把要求、输出格式写清楚；要处理的文件传绝对路径（files），不要让用户/你把正文贴进 task。',
      '- 提交后继续手头工作；用户问起，或下一轮需要结果时，用 route_result 取摘要，细节读结果文件。',
      `当前后台：排队 ${counts.queued}，运行 ${counts.running}，完成 ${counts.done}，失败 ${counts.failed}。`,
    ]
    if (recent.length) lines.push(`最近完成：${recent.join('；')}`)
    return lines.join('\n')
  }
}

export function statusText(status) {
  return (
    {
      queued: '排队中',
      running: '运行中',
      done: '已完成',
      failed: '失败',
      canceled: '已取消',
    }[status] || status
  )
}

export function jobLine(job) {
  const bits = [`[${statusText(job.status)}] ${job.id}`, job.tier]
  if (job.backend) bits.push(job.backend)
  const started = job.startedAt ? new Date(job.startedAt).getTime() : new Date(job.createdAt).getTime()
  const ended = job.endedAt ? new Date(job.endedAt).getTime() : Date.now()
  bits.push(formatDuration(Math.max(0, ended - started)))
  bits.push(collapse(job.task, 40))
  return bits.join(' · ')
}

function buildPrompt(task, contents) {
  const parts = [`# 任务\n${task}`, '', '直接输出结果本身，不要复述任务，不要写“好的”之类的话。']
  for (const item of contents) {
    parts.push('', `# 文件 ${item.name}（${item.text.length} 字，路径 ${item.path}）`, '```', item.text, '```')
  }
  return parts.join('\n')
}
