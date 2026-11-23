// 引擎冒烟测试：不连真实模型，用假 call 跑队列、文件、失败、重启恢复。
// 用法：node test/smoke.mjs
import fs from 'node:fs'
import path from 'node:path'
import { Router, defaultConfig, mergeConfig, classify } from '../router.js'

const root = path.resolve(import.meta.dirname, '..')
const cfg = defaultConfig(root)
cfg.dataDir = path.join(root, 'data-test')
cfg.summaryChars = 60

let calls = 0
const router = new Router(cfg, {
  call: async (backend, { prompt }) => {
    calls += 1
    await new Promise((r) => setTimeout(r, 30))
    return { text: `后端=${backend.label} 收到 ${prompt.length} 字。\n结果：一句话。`, usage: { inputTokens: 10, outputTokens: 5 } }
  },
})
router.init()

console.log('classify simple:', classify('把这段润色一下'))
console.log('classify deep:', classify('分析这个报错并设计方案，代码在下面……'.repeat(20)))
console.log('classify plain:', classify('帮我把会议记录整理成要点'))

const f = path.join(root, 'data-test', 'sample.txt')
fs.mkdirSync(path.dirname(f), { recursive: true })
fs.writeFileSync(f, '原始内容：今天开会讨论了 A、B、C 三件事。')
const out = router.submit({ task: '把文件压缩成一句话', tier: 'cheap', files: [f], output: path.join(root, 'data-test', 'out.txt') })
console.log('submit:', out.job.id, out.label, 'pos', out.position)
console.log('deep:', router.submit({ task: '设计一个插件架构', tier: 'deep' }).message)

await new Promise((r) => setTimeout(r, 400))
const done = router.get(out.job.id)
console.log('status:', done.status, 'chars:', done.chars, 'usage:', JSON.stringify(done.usage))
console.log('summary:', done.summary)
console.log('full:', router.readResult(done.id, { full: true }).text)
console.log('output file:', fs.readFileSync(path.join(root, 'data-test', 'out.txt'), 'utf8'))
console.log('calls:', calls)

const badCfg = mergeConfig(defaultConfig(root), {
  tiers: { cheap: { backends: [{ kind: 'http', label: '坏后端', baseURL: 'http://127.0.0.1:1/v1', model: 'x', timeoutMs: 300 }] } },
})
badCfg.dataDir = path.join(root, 'data-test')
const bad = new Router(badCfg, { call: async () => { throw new Error('boom') } })
bad.init()
const badJob = bad.submit({ task: '测试失败', tier: 'cheap' })
await new Promise((r) => setTimeout(r, 200))
console.log('bad status:', bad.get(badJob.job.id).status, bad.get(badJob.job.id).error)

const again = new Router(cfg, { call: async () => ({ text: 'x' }) })
again.init()
console.log('restart sees jobs:', again.list().total, 'status of job:', again.get(out.job.id).status)

router.close()
bad.close()
again.close()
fs.rmSync(path.join(root, 'data-test'), { recursive: true, force: true })
console.log('OK')
