// 客户端半边冒烟测试：不渲染 DOM，只验证模块契约与插槽注册。
import fs from 'node:fs'

const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
let definition
const fakeWindow = {
  __ModuleLoader__: {
    load(value) {
      definition = value
    },
  },
}
const requireStub = (id) => {
  if (id === 'react') return { createElement: () => null, useState: () => [null, () => {}], useEffect: () => {}, useCallback: (fn) => fn }
  throw new Error(`unexpected require: ${id}`)
}

const fn = new Function('window', 'require', source)
fn(fakeWindow, requireStub)

if (!definition || !definition.factory) throw new Error('模块没有通过 __ModuleLoader__ 注册')
const mod = definition.factory(requireStub)
if (!Array.isArray(mod.inject) || mod.inject[0] !== 'slots') throw new Error('inject 不对')

const registered = []
const ctx = {
  slots: {
    register(spec, component) {
      registered.push({ spec, component })
    },
    inject(_name, cb) {
      cb()
    },
  },
}
mod.apply(ctx)

console.log('registered:', registered.map((item) => `${item.spec.name}:${item.spec.id || item.spec.key}`).join(', '))
if (registered.length !== 2) throw new Error('应该注册两个插槽')
if (registered[0].spec.name !== 'sidebar.panellist' || registered[0].spec.id !== 'tr-board') throw new Error('侧栏插槽不对')
if (registered[1].spec.name !== 'main' || registered[1].spec.key !== 'tr-board') throw new Error('main 插槽不对')
console.log('client smoke OK')
