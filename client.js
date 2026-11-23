// 任务路由 · 浏览器半边：对话看板
//
// 侧栏加一个「看板」图标，主区域列出最近的对话：
//   每个对话用了哪些模型（API / 本机）、各多少轮、多少 token，以及里面提交过哪些后台任务。
// 数据来自 Host 的 GET /tr/api/dashboard。
window.__ModuleLoader__.load({
  id: '@local/task-router',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const PANEL = 'tr-board'
    const API = '/tr/api/dashboard'
    const CONFIG_API = '/tr/api/config'

    const CSS = `
.tr-root { display: flex; flex-direction: column; gap: 16px; padding: 20px 24px 40px; max-width: 1180px; margin: 0 auto; color: var(--dsw-alias-label-primary); }
.tr-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.tr-title { margin: 0; font-size: 20px; font-weight: 650; letter-spacing: 0.2px; }
.tr-sub { margin: 4px 0 0; font-size: 12.5px; line-height: 1.5; color: var(--dsw-alias-label-secondary); }
.tr-actions { display: flex; align-items: center; gap: 10px; flex: none; }
.tr-updated { font-size: 11.5px; color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; }
.tr-btn { height: 30px; padding: 0 12px; font: inherit; font-size: 12.5px; border-radius: 8px; cursor: pointer;
  color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1); }
.tr-btn:hover { border-color: var(--dsw-alias-border-l2); }
.tr-btn:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.tr-btn[disabled] { opacity: .55; cursor: default; }
.tr-cards { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; }
.tr-card { padding: 12px 14px; border-radius: 10px; background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1); }
.tr-card-label { font-size: 11.5px; color: var(--dsw-alias-label-secondary); }
.tr-card-value { margin-top: 6px; font-size: 20px; font-weight: 650; font-variant-numeric: tabular-nums; }
.tr-card-hint { margin-top: 4px; font-size: 11px; color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; }
.tr-note { padding: 10px 14px; border-radius: 9px; font-size: 12.5px; line-height: 1.5;
  background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l2); }
.tr-note.err { border-color: var(--dsw-alias-label-tertiary); color: var(--dsw-alias-label-primary); }
.tr-table { border: 1px solid var(--dsw-alias-border-l1); border-radius: 12px; overflow: hidden; background: var(--dsw-alias-bg-base); }
.tr-row { display: grid; grid-template-columns: 88px minmax(200px, 1fr) minmax(250px, 1.25fr) 150px 110px; gap: 12px; align-items: center;
  padding: 10px 14px; border-top: 1px solid var(--dsw-alias-border-l1); font-size: 12.5px; }
.tr-row:first-child { border-top: 0; }
.tr-row:not(.tr-row-head) { cursor: pointer; }
.tr-row:not(.tr-row-head):hover { background: var(--dsw-alias-bg-layer-1); }
.tr-row.sel { background: var(--dsw-alias-bg-layer-1); box-shadow: inset 2px 0 0 var(--dsw-alias-brand-primary); }
.tr-row-head { font-size: 11.5px; color: var(--dsw-alias-label-secondary); background: transparent; }
.tr-time { color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; }
.tr-session { min-width: 0; }
.tr-session-title { font-weight: 550; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tr-session-sub { margin-top: 3px; font-size: 11px; color: var(--dsw-alias-label-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tr-chips { display: flex; flex-wrap: wrap; gap: 5px; }
.tr-chip { display: inline-flex; align-items: center; gap: 4px; padding: 2px 7px; border-radius: 999px;
  font-size: 11.5px; line-height: 1.5; border: 1px solid var(--dsw-alias-border-l1); color: var(--dsw-alias-label-secondary);
  background: transparent; white-space: nowrap; }
.tr-chip.api { color: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); }
.tr-chip.local { color: var(--dsw-alias-label-primary); border-color: var(--dsw-alias-border-l2); }
.tr-chip.muted { border-style: dashed; }
.tr-jobs { font-size: 12px; color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; }
.tr-tokens { text-align: right; font-variant-numeric: tabular-nums; color: var(--dsw-alias-label-secondary); }
.tr-detail { display: flex; flex-direction: column; gap: 12px; padding: 16px; border-radius: 12px;
  border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-base); }
.tr-detail-row { padding: 12px 14px 14px; border-top: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); }
.tr-detail-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.tr-detail-title { font-size: 14px; font-weight: 620; }
.tr-detail-sub { font-size: 11.5px; color: var(--dsw-alias-label-secondary); }
.tr-block-title { margin: 2px 0 6px; font-size: 12px; font-weight: 600; color: var(--dsw-alias-label-secondary); }
.tr-dtable { width: 100%; border-collapse: collapse; font-size: 12px; }
.tr-dtable th, .tr-dtable td { text-align: left; padding: 6px 10px; border-top: 1px solid var(--dsw-alias-border-l1); }
.tr-dtable thead th { border-top: 0; font-size: 11px; font-weight: 500; color: var(--dsw-alias-label-secondary); }
.tr-dtable td.num, .tr-dtable th.num { text-align: right; font-variant-numeric: tabular-nums; }
.tr-dtable tbody tr:hover { background: var(--dsw-alias-bg-layer-1); }
.tr-empty { padding: 26px 14px; text-align: center; font-size: 12.5px; color: var(--dsw-alias-label-secondary); }
.tr-foot { margin: 0; font-size: 11px; line-height: 1.6; color: var(--dsw-alias-label-secondary); }
.tr-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--dsw-alias-brand-primary); display: inline-block; }
.tr-dot.local { background: var(--dsw-alias-label-secondary); }
.tr-spin { display: inline-flex; align-items: center; gap: 6px; color: var(--dsw-alias-label-secondary); }
.tr-settings { border: 1px solid var(--dsw-alias-border-l1); border-radius: 12px; background: var(--dsw-alias-bg-base); }
.tr-settings > summary { display: flex; align-items: center; gap: 10px; padding: 11px 14px; cursor: pointer; font-size: 13px; font-weight: 600; }
.tr-settings > summary::-webkit-details-marker { display: none; }
.tr-settings-hint { font-weight: 400; font-size: 11.5px; color: var(--dsw-alias-label-secondary); }
.tr-settings-body { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; padding: 2px 14px 14px; }
.tr-field { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
.tr-field-label { font-size: 11.5px; color: var(--dsw-alias-label-secondary); }
.tr-field select { height: 32px; padding: 0 8px; border-radius: 8px; font: inherit; font-size: 12px;
  color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1); }
.tr-field select:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.tr-settings-foot { display: flex; align-items: center; gap: 10px; padding: 0 14px 14px; }
.tr-settings-msg { font-size: 11.5px; color: var(--dsw-alias-label-secondary); }
.tr-timeline { display: flex; flex-direction: column; gap: 2px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; overflow: hidden; }
.tr-seg { display: grid; grid-template-columns: 10px minmax(120px, 1fr) 52px 160px; gap: 8px; align-items: center;
  padding: 7px 10px; font-size: 12px; border-top: 1px solid var(--dsw-alias-border-l1); }
.tr-seg:first-child { border-top: 0; }
.tr-seg-model { font-weight: 550; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tr-seg-tag { font-size: 11px; color: var(--dsw-alias-label-secondary); }
.tr-seg-range { text-align: right; font-size: 11.5px; color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; }
.tr-hint { margin-top: 6px; font-size: 11px; color: var(--dsw-alias-label-secondary); }
@media (max-width: 900px) {
  .tr-cards { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .tr-row { grid-template-columns: 70px minmax(0, 1fr) minmax(200px, 1fr); }
  .tr-row > .tr-jobs, .tr-row > .tr-tokens { display: none; }
}
`

    const fmt = (value) => (typeof value === 'number' ? value.toLocaleString('zh-CN') : '0')

    function relTime(ts) {
      if (!ts) return '—'
      const diff = Date.now() - ts
      if (diff < 60_000) return '刚刚'
      if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
      if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
      return `${Math.floor(diff / 86_400_000)} 天前`
    }

    function absTime(ts) {
      if (!ts) return ''
      const d = new Date(ts)
      const pad = (n) => String(n).padStart(2, '0')
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
    }

    function duration(ms) {
      if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return '—'
      const seconds = Math.round(ms / 1000)
      if (seconds < 60) return `${seconds}s`
      const minutes = Math.floor(seconds / 60)
      return `${minutes}m${String(seconds % 60).padStart(2, '0')}s`
    }

    const STATUS = { queued: '排队', running: '运行中', done: '完成', failed: '失败', canceled: '取消' }
    const TIER = { cheap: '简单', standard: '一般', deep: '复杂' }

    function tierValueOf(tier, tiers) {
      const value = tiers && tiers[tier]
      if (!value) return ''
      if (value.stayInMain) return '__main__'
      return value.provider && value.model ? `${value.provider}|${value.model}` : ''
    }

    function modelChips(item) {
      const stats = item && item.stats
      if (!stats) {
        return item && item.live
          ? h('span', { className: 'tr-chip muted' }, '实时对话 · 未统计')
          : h('span', { className: 'tr-spin' }, h('span', { className: 'tr-dot' }), '统计中…')
      }
      if (!stats.models.length) return h('span', { className: 'tr-chip muted' }, '无模型记录')
      return h('div', { className: 'tr-chips' },
        stats.models.map((model) => h('span', {
          key: `${model.provider}/${model.model}`,
          className: `tr-chip ${model.local ? 'local' : 'api'}`,
          title: `${model.provider}/${model.model}`,
        },
          h('span', { className: `tr-dot ${model.local ? 'local' : ''}` }),
          model.local ? '本机' : 'API',
          model.model || model.provider,
          h('span', null, `×${model.turns}`))))
    }

    function StatCard(props) {
      return h('div', { className: 'tr-card' },
        h('div', { className: 'tr-card-label' }, props.label),
        h('div', { className: 'tr-card-value' }, props.value),
        props.hint ? h('div', { className: 'tr-card-hint' }, props.hint) : null)
    }

    function detail(item) {
      const jobs = item.jobs || []
      return h('section', { className: 'tr-detail' },
        h('div', { className: 'tr-detail-head' },
          h('div', null,
            h('div', { className: 'tr-detail-title' }, item.preview || `会话 ${item.id}`),
            h('div', { className: 'tr-detail-sub' }, `${item.cwd || '无目录'} · ${absTime(item.createdAt)} · ${item.id}`)),
          h('div', { className: 'tr-detail-sub' },
            item.stats
              ? `${item.stats.turns} 轮 · 输入 ${fmt(item.stats.input)} / 输出 ${fmt(item.stats.output)} token`
              : '正在统计会话…')),

        h('div', null,
          h('div', { className: 'tr-block-title' }, '模型明细'),
          item.stats && item.stats.models.length
            ? h('table', { className: 'tr-dtable' },
              h('thead', null, h('tr', null,
                h('th', null, '提供方 / 模型'), h('th', null, '类型'), h('th', { className: 'num' }, '轮次'),
                h('th', { className: 'num' }, '输入'), h('th', { className: 'num' }, '输出'))),
              h('tbody', null, item.stats.models.map((model) => h('tr', { key: `${model.provider}/${model.model}` },
                h('td', null, `${model.provider}/${model.model}`),
                h('td', null, model.local ? '本机' : 'API'),
                h('td', { className: 'num' }, fmt(model.turns)),
                h('td', { className: 'num' }, fmt(model.input)),
                h('td', { className: 'num' }, fmt(model.output))))))
            : h('div', { className: 'tr-empty' }, item.stats ? '这个对话没有模型回调记录' : '正在读取会话日志…')),

        h('div', null,
          h('div', { className: 'tr-block-title' }, '模型参与时间线'),
          item.stats && item.stats.timeline && item.stats.timeline.length
            ? h('div', { className: 'tr-timeline' }, item.stats.timeline.map((segment, index) => h('div', {
              key: `${index}-${segment.key}`,
              className: 'tr-seg',
            },
              h('span', { className: `tr-dot ${segment.local ? 'local' : ''}` }),
              h('span', { className: 'tr-seg-model', title: `${segment.provider}/${segment.model}` }, segment.model || segment.provider),
              h('span', { className: 'tr-seg-tag' }, segment.local ? '本机' : 'API'),
              h('span', { className: 'tr-seg-range' },
                segment.firstTurn !== undefined && segment.firstTurn !== null
                  ? `第 ${segment.firstTurn + 1}–${segment.lastTurn + 1} 轮 · ${segment.turns} 次`
                  : `${segment.turns} 次`))))
            : h('div', { className: 'tr-empty' },
              item.stats
                ? (item.live ? '当前对话还在写，结束后再统计时间线' : '没有模型参与记录')
                : '正在读取会话日志…'),
          item.stats && item.stats.timelineTruncated ? h('div', { className: 'tr-hint' }, '只显示前 40 段') : null),

        h('div', null,
          h('div', { className: 'tr-block-title' }, `后台任务（${jobs.length}）`),
          jobs.length
            ? h('table', { className: 'tr-dtable' },
              h('thead', null, h('tr', null,
                h('th', null, '任务'), h('th', null, '层'), h('th', null, '后端'), h('th', null, '状态'),
                h('th', { className: 'num' }, '耗时'), h('th', { className: 'num' }, 'token'))),
              h('tbody', null, jobs.map((job) => h('tr', { key: job.id },
                h('td', null, job.task || job.id),
                h('td', null, TIER[job.tier] || job.tier),
                h('td', null, job.backend || '—'),
                h('td', null, STATUS[job.status] || job.status),
                h('td', { className: 'num' }, duration(job.ms)),
                h('td', { className: 'num' }, job.input || job.output ? `${fmt(job.input)} / ${fmt(job.output)}` : '—')))))
            : h('div', { className: 'tr-empty' }, '这个对话没有提交过后台任务')),
        )
    }

    function Board() {
      const [data, setData] = React.useState(null)
      const [selectedId, setSelectedId] = React.useState(null)
      const [error, setError] = React.useState('')
      const [refreshing, setRefreshing] = React.useState(false)
      const [loading, setLoading] = React.useState(true)
      const [config, setConfig] = React.useState(null)
      const [draft, setDraft] = React.useState({})
      const [saving, setSaving] = React.useState(false)
      const [saveMsg, setSaveMsg] = React.useState('')

      const loadConfig = React.useCallback(async () => {
        try {
          const response = await fetch(CONFIG_API)
          const json = await response.json()
          if (json.ok) {
            setConfig(json)
            setDraft({
              deep: tierValueOf('deep', json.tiers),
              standard: tierValueOf('standard', json.tiers),
              cheap: tierValueOf('cheap', json.tiers),
            })
          }
        } catch {}
      }, [])

      React.useEffect(() => {
        loadConfig()
      }, [loadConfig])

      const saveConfig = async () => {
        setSaving(true)
        setSaveMsg('')
        try {
          const tiers = {}
          for (const tier of ['deep', 'standard', 'cheap']) {
            const value = draft[tier]
            if (!value) continue
            if (value === '__main__') tiers[tier] = { stayInMain: true }
            else {
              const [provider, model] = value.split('|')
              tiers[tier] = { provider, model }
            }
          }
          const response = await fetch(CONFIG_API, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ tiers }),
          })
          const json = await response.json()
          if (json.ok) {
            setConfig(json)
            setSaveMsg('已保存，新任务按这个配置走')
            load(true)
          } else {
            setSaveMsg(`保存失败：${json.error || '未知错误'}`)
          }
        } catch (err) {
          setSaveMsg(`保存失败：${err && err.message ? err.message : err}`)
        } finally {
          setSaving(false)
          window.setTimeout(() => setSaveMsg(''), 4000)
        }
      }

      const load = React.useCallback(async (refresh) => {
        if (refresh) setRefreshing(true)
        try {
          const response = await fetch(API + (refresh ? '?refresh=1' : ''), { headers: { 'x-tr-board': '1' } })
          const json = await response.json()
          setData(json)
          setError(json.ok ? '' : json.error || '')
        } catch (err) {
          setError(`看板数据加载失败：${err && err.message ? err.message : err}`)
        } finally {
          setRefreshing(false)
          setLoading(false)
        }
      }, [])

      React.useEffect(() => {
        load(false)
        const timer = window.setInterval(() => load(false), 4000)
        return () => window.clearInterval(timer)
      }, [load])

      const items = (data && data.items) || []
      const totals = data && data.totals
      const current = items.find((item) => item.id === selectedId) || null

      return h('div', { className: 'tr-root' },
        h('style', { dangerouslySetInnerHTML: { __html: CSS } }),

        h('header', { className: 'tr-head' },
          h('div', null,
            h('h1', { className: 'tr-title' }, '模型切换看板'),
            h('p', { className: 'tr-sub' }, '每个对话里哪几轮是哪个模型跑的；复杂 / 一般 / 简单 分别交给谁，也可以在这里改。')),
          h('div', { className: 'tr-actions' },
            h('span', { className: 'tr-updated' }, data ? `更新于 ${absTime(data.now)}` : ''),
            h('button', { className: 'tr-btn', disabled: refreshing, onClick: () => load(true) }, refreshing ? '统计中…' : '刷新'))),

        h('details', { className: 'tr-settings' },
          h('summary', null, '模型设置', h('span', { className: 'tr-settings-hint' }, '复杂 / 一般 / 简单 分别交给谁；改完保存')),
          h('div', { className: 'tr-settings-body' },
            ['deep', 'standard', 'cheap'].map((tier) => h('label', { key: tier, className: 'tr-field' },
              h('span', { className: 'tr-field-label' }, TIER[tier]),
              h('select', {
                value: draft[tier] || '',
                onChange: (event) => setDraft((prev) => ({ ...prev, [tier]: event.target.value })),
              },
                (tier === 'deep' ? [h('option', { key: '__main__', value: '__main__' }, '留在主对话（不转交）')] : [])
                  .concat(((config && config.options) || []).map((option) => h('option', {
                    key: `${tier}-${option.provider}-${option.model}`,
                    value: `${option.provider}|${option.model}`,
                  }, `${option.local ? '本机' : 'API'} · ${option.provider}/${option.model}`))))))),
          h('div', { className: 'tr-settings-foot' },
            h('button', { className: 'tr-btn', disabled: saving || !config, onClick: saveConfig }, saving ? '保存中…' : '保存'),
            saveMsg ? h('span', { className: 'tr-settings-msg' }, saveMsg) : null)),

        error ? h('div', { className: 'tr-note err' }, error) : null,

        h('section', { className: 'tr-cards' },
          h(StatCard, { label: '对话', value: fmt(totals ? totals.sessions : 0), hint: '最近 30 个' }),
          h(StatCard, { label: 'API 轮次', value: fmt(totals ? totals.apiTurns : 0), hint: totals ? `token ${fmt(totals.apiInput)} / ${fmt(totals.apiOutput)}` : '' }),
          h(StatCard, { label: '本机轮次', value: fmt(totals ? totals.localTurns : 0), hint: totals ? `token ${fmt(totals.localInput)} / ${fmt(totals.localOutput)}` : '' }),
          h(StatCard, { label: '后台任务', value: fmt(totals ? totals.jobsLocal + totals.jobsApi : 0), hint: totals ? `本机 ${totals.jobsLocal} · 免费池 ${totals.jobsApi}` : '' })),

        h('div', { className: 'tr-table' },
          h('div', { className: 'tr-row tr-row-head' },
            h('span', null, '时间'), h('span', null, '对话'), h('span', null, '主模型'),
            h('span', null, '后台任务'), h('span', { className: 'tr-tokens' }, 'token')),
          loading
            ? h('div', { className: 'tr-empty' }, '正在读取会话…')
            : items.length === 0
              ? h('div', { className: 'tr-empty' }, '还没有会话记录')
              : items.map((item) => {
                const localJobs = (item.jobs || []).filter((job) => !job.api).length
                const apiJobs = (item.jobs || []).length - localJobs
                const expanded = Boolean(current && current.id === item.id)
                return h(React.Fragment, { key: item.id },
                  h('div', {
                    className: `tr-row${expanded ? ' sel' : ''}`,
                    onClick: () => setSelectedId(expanded ? null : item.id),
                  },
                    h('span', { className: 'tr-time', title: absTime(item.createdAt) }, relTime(item.createdAt)),
                    h('div', { className: 'tr-session' },
                      h('div', { className: 'tr-session-title' }, `${expanded ? '▾' : '▸'} ${item.preview || `会话 ${item.id.slice(0, 14)}…`}`),
                      h('div', { className: 'tr-session-sub' }, item.cwd || '')),
                    modelChips(item),
                    h('div', { className: 'tr-jobs' }, item.jobs && item.jobs.length ? `本机 ${localJobs} · 免费池 ${apiJobs}` : '—'),
                    h('div', { className: 'tr-tokens' }, item.stats ? `${fmt(item.stats.input)} / ${fmt(item.stats.output)}` : '—')),
                  expanded ? h('div', { className: 'tr-detail-row' }, detail(item)) : null)
              })),

        h('p', { className: 'tr-foot' },
          '数据来自本机会话日志和任务路由的本地记录；只统计最近 30 个对话，本机模型按 Ollama 提供方识别。点一行展开明细，再点收起。看板每 4 秒自动刷新。'))

    }

    function Pages(props) {
      const size = props.size || 18
      return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true' },
        h('path', { d: 'M4 20V10' }),
        h('path', { d: 'M10 20V4' }),
        h('path', { d: 'M16 20v-7' }),
        h('path', { d: 'M22 20H2' }))
    }

    function apply(ctx) {
      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register({ name: 'sidebar.panellist', id: PANEL, order: 12, label: () => '模型切换看板' }, Pages))
      ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL }, Board))
    }

    return { inject: ['slots'], apply }
  },
})
