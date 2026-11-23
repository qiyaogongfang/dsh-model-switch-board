// 真实后端连通性测试：会真的调用本机 Ollama 和 dsh-model 网关。
// 用法：node test/backends.mjs
import { callHttpBackend } from '../index.js'
import { defaultConfig } from '../router.js'

const cfg = defaultConfig(import.meta.dirname)
const prompt = '把这句话压缩成不超过 20 字：今天下午我们要把服务器上的旧日志文件清理掉，保留最近七天的，其他的都删除，删之前先确认没有被任何程序占用。'

for (const tier of ['cheap', 'standard']) {
  const backend = cfg.tiers[tier].backends[0]
  const started = Date.now()
  try {
    const result = await callHttpBackend(backend, prompt, undefined)
    console.log(`${tier} [${backend.label}] ${Math.round((Date.now() - started) / 1000)}s usage=${JSON.stringify(result.usage)}`)
    console.log('  →', result.text.replace(/\s+/g, ' ').slice(0, 200))
  } catch (error) {
    console.log(`${tier} ✗ ${error.message}`)
  }
}
