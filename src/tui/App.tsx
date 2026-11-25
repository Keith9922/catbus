import { Box, type Key, Text, useApp, useInput, usePaste, useWindowSize } from 'ink'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { type CatbusError, toCatbusError } from '../core/errors.js'
import type { Command, Platform } from '../core/registry.js'
import { PLATFORMS } from '../platforms/index.js'
import { BrowseKeys, CommandPane, FormPane, PlatformPane } from './Browse.js'
import { copyText, openFile, openUrl } from './clipboard.js'
import { edit, initial, type TextState } from './input.js'
import { type LogBuffer, bufferLogger } from './logs.js'
import { Mascot, MASCOT_ROWS } from './MascotView.js'
import { availability, usable, cliFromInvocation, cliLine, DOWNLOAD_ACTIONS, fields, type FormValue, endpointOf, groupCommands, type PlatformRow, platformRows, primaryCommand, quote, runnableCommand, toInvocation } from './model.js'
import { AccountsView, accountKeys, type AccountsState } from './AccountsView.js'
import { type LoginSession, type LoginView as LoginState, accountsOf, checkAccount, loginCommand, loginFields, loginMethods, logoutAccount, startLogin, useAccount } from './login.js'
import { ListenScreen } from './ListenScreen.js'
import { type Next, nextSteps, refOf } from './follow.js'
import { NextKeys, NextView } from './NextView.js'
import { ProgressKeys, ProgressView, ResultView, SetupKeys, SetupView, type SetupState, setupRows } from './LoginView.js'
import { Splash } from './Splash.js'
import { PaletteView } from './Palette.js'
import { ResultKeys, ResultsView, resultsVisible } from './Results.js'
import { type RunRequest, runCommand } from './run.js'
import {
  clamp, commandVisible, filterPalette, originOf, layoutFor, type PaletteEntry, paletteText, type Phase, type Results, rowsOf, scrollTo, toItems,
} from './state.js'
import { kindOf, linkOf, rawOf } from './summary.js'
import { clip, padEnd } from './text.js'
import { Keys, LookContext, Pane, T, useGlyphs, useLook } from './ui.js'
import { LATTE, type Look, MOCHA } from './theme.js'
import type { AggregateResult } from './aggregate.js'
import { AggregateScreen } from './AggregateScreen.js'
import { canComment } from './comments.js'
import { CommentsScreen } from './CommentsScreen.js'
import { DownloadQueue } from './downloads.js'
import { DownloadsScreen } from './DownloadsScreen.js'
import { MediaScreen } from './MediaScreen.js'
import { SettingsScreen } from './SettingsScreen.js'

// 主界面（AGENTS 4.13）：状态和按键在这里，画面交给各个子组件。

/** 本次浏览账号的初值：没有任何平台换过账号。 */
const EMPTY_MAP: Readonly<Record<string, string>> = Object.freeze({})

/** platforms 默认是注册表里的全部平台；测试时可以换成假平台。 */
export function App({ look, logs, platforms = PLATFORMS }: { look: Look; logs: LogBuffer; platforms?: Platform[] }) {
  // T 键在深色 / 浅色之间切换，只在这次运行里生效
  const [light, setLight] = useState(look.palette === LATTE)
  const value = useMemo<Look>(() => ({ ...look, palette: light ? LATTE : MOCHA }), [look, light])
  return (
    <LookContext.Provider value={value}>
      <Shell logs={logs} platforms={platforms} light={light} toggleTheme={() => setLight((v) => !v)} />
    </LookContext.Provider>
  )
}

/** 选中平台时默认展开的那组命令：item 优先（各平台的主内容），否则第一组。 */
function mainGroup(p: Platform): string[] {
  const groups = groupCommands(p)
  const pick = groups.find((g) => g.resource === 'item') ?? groups[0]
  return pick ? [pick.resource] : []
}

type Mode = 'browse' | 'palette' | 'help' | 'json' | 'detail' | 'next' | 'accounts' | 'login' | 'listen' | 'downloads' | 'comments' | 'media' | 'settings' | 'aggregate'

/** 自己处理按键、自己画整屏的页面：主界面的 useInput 让路，免得同一次按键处理两遍。 */
const SCREENS: ReadonlySet<Mode> = new Set(['listen', 'downloads', 'comments', 'media', 'settings', 'aggregate'])

function Shell({ logs, platforms, light, toggleTheme }: { logs: LogBuffer; platforms: Platform[]; light: boolean; toggleTheme: () => void }) {
  const { exit } = useApp()
  const { columns, rows: screenRows } = useWindowSize()
  const g = useGlyphs()
  const look = useLook()
  const layout = layoutFor(columns, screenRows)

  const [platformList, setPlatformList] = useState<PlatformRow[]>(() => platforms.map((platform) => ({ platform, implemented: 0, open: false, account: null, loggedIn: false })))
  useEffect(() => {
    void platformRows(platforms).then(setPlatformList).catch(() => {})
  }, [platforms])

  const [pane, setPane] = useState<'platforms' | 'commands' | 'form'>('platforms')
  const [pi, setPi] = useState(0)
  const [openGroups, setOpenGroups] = useState<Set<string>>(() => new Set(mainGroup(platforms[0]!)))
  const [ri, setRi] = useState(0)
  const [top, setTop] = useState(0)
  const [fi, setFi] = useState(0)
  const [formValues, setFormValues] = useState<Record<string, FormValue>>({})
  const [editor, setEditor] = useState<TextState>(() => initial(''))
  const [phase, setPhase] = useState<Phase>({ type: 'browse' })
  const [mode, setMode] = useState<Mode>('browse')
  const [note, setNote] = useState<string | null>(null)
  const [helpTop, setHelpTop] = useState(0)
  const [log, setLog] = useState<string | null>(null)
  const [spin, setSpin] = useState(0)
  const abort = useRef<AbortController | null>(null)

  // 启动动画：窗口够大、没有关动画才出现，任意键跳过
  const [splash, setSplash] = useState(() => look.animate && !look.mono && !look.ascii)
  const endSplash = useCallback(() => setSplash(false), [])

  // 账号页
  const [acc, setAcc] = useState<AccountsState>({ rows: [], selected: 0, checked: {}, confirmLogout: null, loading: false })
  // 登录
  const [setup, setSetup] = useState<SetupState | null>(null)
  const [setupError, setSetupError] = useState<string | null>(null)
  const [loginView, setLoginView] = useState<LoginState | null>(null)
  const loginSession = useRef<LoginSession | null>(null)
  // 退出界面（q、Ctrl-C、窗口关闭）时，进行中的登录一并取消：撤销界面钩子，免得它一直占着 stdin
  const alive = useRef(true)
  useEffect(
    () => () => {
      alive.current = false
      loginSession.current?.cancel()
    },
    [],
  )
  // 这次登录从日志的哪一行开始：提问页把之后的日志显示出来（发码提示、待选账号列表等）
  const loginMark = useRef(0)
  // 结果页“接着做”
  const [steps, setSteps] = useState<Next[]>([])
  const [stepAt, setStepAt] = useState(0)
  // 监听
  const [listening, setListening] = useState<{ platform: Platform; command: Command; words: string[]; given: Record<string, unknown> } | null>(null)
  // 本次浏览用的账号（平台 id → 账号名）：相当于 -a，不改 _current（AGENTS 4.13）
  const [browseAs, setBrowseAs] = useState<Readonly<Record<string, string>>>(EMPTY_MAP)
  const browseRef = useRef(browseAs)
  browseRef.current = browseAs
  const accountFor = useCallback((p: Platform): string | undefined => browseRef.current[p.id], [])
  // 下载目录：默认是启动时的目录（与 CLI 的 --dir 默认值一致）；设置页里可以改，只在这次运行里有效
  const [downloadDir, setDownloadDir] = useState(() => process.cwd())
  const dirRef = useRef(downloadDir)
  dirRef.current = downloadDir
  const queue = useMemo(() => new DownloadQueue({ log: bufferLogger(logs), dir: () => dirRef.current, account: (p) => browseRef.current[p.id] }), [logs])
  const [downloads, setDownloads] = useState(() => queue.counts())
  useEffect(() => queue.subscribe(() => setDownloads(queue.counts())), [queue])
  // 评论页、媒体页看的是哪一条
  const [target, setTarget] = useState<{ platform: Platform; item: Record<string, unknown> } | null>(null)
  // 每个平台最近一次的结果（聚合搜索不算），浏览页按 r 回去
  const lastResults = useRef(new Map<string, Extract<Phase, { type: 'results' }>>())
  // 从“接着做”回到上一页结果
  const [back, setBack] = useState<Extract<Phase, { type: 'results' }>[]>([])

  useEffect(() => {
    if (phase.type === 'results' && !phase.results.origins) lastResults.current.set(phase.results.platform.id, phase)
  }, [phase])

  const platform: Platform = platformList[pi]!.platform
  const groups = useMemo(() => groupCommands(platform), [platform])
  const navRows = useMemo(() => rowsOf(groups, openGroups, usable), [groups, openGroups])
  const current = navRows[ri]
  const command: Command | null = current?.type === 'command' ? current.command : null
  const fieldList = useMemo(() => (command ? fields(command) : []), [command])

  // 日志：最新一行显示在状态栏
  const logTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    const off = logs.subscribe(() => {
      setLog(logs.last())
      if (logTimer.current) clearTimeout(logTimer.current)
      logTimer.current = setTimeout(() => setLog(null), 4000)
    })
    return () => {
      off()
      if (logTimer.current) clearTimeout(logTimer.current)
    }
  }, [logs])
  // 运行中的转圈
  useEffect(() => {
    if (phase.type !== 'running' && !(phase.type === 'results' && phase.loadingMore)) return
    // Windows 控制台整屏重绘，转圈放慢一些
    const t = setInterval(() => setSpin((n) => n + 1), look.animate ? 120 : 400)
    return () => clearInterval(t)
  }, [phase, look.animate])
  useEffect(() => {
    if (!note) return
    const t = setTimeout(() => setNote(null), 3500)
    return () => clearTimeout(t)
  }, [note])

  const palette = useMemo<PaletteEntry[]>(
    () =>
      platforms.flatMap((p) =>
        groupCommands(p).flatMap((gr) => gr.commands.map((c) => ({ platform: p, command: c, text: paletteText(p, c) }))),
      ).sort((a, b) => Number(usable(b.command)) - Number(usable(a.command))),
    [platforms],
  )
  const [query, setQuery] = useState<TextState>(() => initial(''))
  const [pi2, setPi2] = useState(0)
  const hits = useMemo(() => filterPalette(palette, query.value), [palette, query.value])

  const line = command ? cliLine(platform, command, formValues) : `catbus ${platform.id} --help`

  const moveTo = useCallback(
    (index: number) => {
      const next = clamp(index, 0, Math.max(0, navRows.length - 1))
      setRi(next)
      setTop((t) => scrollTo(next, t, commandVisible(navRows.length, screenRows - 6), navRows.length))
    },
    [navRows.length, screenRows],
  )

  const selectPlatform = (i: number) => {
    setPi(clamp(i, 0, platformList.length - 1))
    setRi(0)
    setTop(0)
    setOpenGroups(new Set(mainGroup(platformList[clamp(i, 0, platformList.length - 1)]!.platform)))
    setFormValues({})
    setFi(0)
  }

  const openCommand = (p: Platform, c: Command) => {
    const index = platformList.findIndex((r) => r.platform.id === p.id)
    setPi(index)
    setOpenGroups(new Set([c.resource]))
    const rowsNow = rowsOf(groupCommands(p), new Set([c.resource]), usable)
    const at = rowsNow.findIndex((r) => r.type === 'command' && r.command.key === c.key)
    setRi(Math.max(0, at))
    setTop(scrollTo(Math.max(0, at), 0, commandVisible(rowsNow.length, screenRows - 6), rowsNow.length))
    setFormValues({})
    setFi(0)
    setPane('form')
    setEditor(initial(''))
    setMode('browse')
  }

  const startEditing = (f: number, values = formValues) => {
    const list = command ? fields(command) : []
    const fd = list[f]
    setFi(f)
    const v = fd ? values[fd.label] : undefined
    setEditor(initial(typeof v === 'string' ? v : ''))
  }

  const writeField = (state: TextState, f = fi) => {
    const fd = fieldList[f]
    if (fd) setFormValues((vs) => ({ ...vs, [fd.label]: state.value }))
  }

  // ---- 运行 ----

  const run = useCallback(
    async (p: Platform, c: Command, words: string[], given: Record<string, unknown>, cursor: string | null, previous?: Results, lineOverride?: string) => {
      abort.current?.abort()
      const controller = (abort.current = new AbortController())
      if (previous) setPhase((ph) => (ph.type === 'results' ? { ...ph, loadingMore: true } : ph))
      else setPhase({ type: 'running', label: `${p.id} ${c.resource} ${c.action}` })
      try {
        // 下载命令没给 --dir 时用设置页里的下载目录
        const withDir = DOWNLOAD_ACTIONS.has(c.action) && given.dir == null ? { ...given, dir: dirRef.current } : given
        const req: RunRequest = { platform: p, command: c, words, given: withDir, cursor, log: bufferLogger(logs), signal: controller.signal }
        const as = browseRef.current[p.id]
        if (as) req.account = as
        const result = await runCommand(req)
        if (controller.signal.aborted) return
        const { items, single } = toItems(result.data)
        const merged: Results = previous
          ? { ...previous, items: [...previous.items, ...items], page: result.page, account: result.account }
          : { platform: p, command: c, line: lineOverride ?? cliLine(p, c, formValues), words, given, items, single, page: result.page, account: result.account }
        setPhase((ph) => ({
          type: 'results',
          results: merged,
          selected: previous && ph.type === 'results' ? ph.selected : 0,
          top: previous && ph.type === 'results' ? ph.top : 0,
          // 翻页只往后接，已选的下标不变；滚到底自动翻页时不能把选择清掉
          marked: previous && ph.type === 'results' ? ph.marked : undefined,
          loadingMore: false,
        }))
        setMode('browse')
      } catch (err) {
        if (controller.signal.aborted) return
        const e: CatbusError = toCatbusError(err)
        setPhase({ type: 'error', code: e.code, message: e.message, hint: e.hint, exit: e.exitCode })
      }
    },
    [formValues, logs],
  )

  const submit = () => {
    if (!command) return
    const state = availability(command)
    if (state !== 'run' && state !== 'listen') return
    const missing = fieldList.findIndex((f) => f.required && f.default == null && !(typeof formValues[f.label] === 'string' && formValues[f.label] !== ''))
    if (missing >= 0) {
      setNote(`先填 ${fieldList[missing]!.label}：${fieldList[missing]!.hint}`)
      startEditing(missing)
      return
    }
    const { words, given } = toInvocation(command, formValues)
    if (state === 'listen') return beginListen(platform, command, words, given)
    void run(platform, command, words, given, null)
  }

  // ---- 账号 ----

  const refreshRows = useCallback(() => {
    void platformRows(platforms).then(setPlatformList).catch(() => {})
  }, [platforms])

  const openAccounts = () => {
    setAcc({ rows: [], selected: 0, checked: {}, confirmLogout: null, loading: true })
    setMode('accounts')
    void accountsOf(platform)
      .then((rows) => setAcc((a) => ({ ...a, rows, loading: false, selected: Math.max(0, rows.findIndex((r) => r.active)) })))
      .catch((e) => {
        setAcc((a) => ({ ...a, loading: false }))
        setNote(`读取账号失败：${toCatbusError(e).message}`)
      })
  }

  const reloadAccounts = async (done: string) => {
    // 操作（切换、登出）已经成功，这里只是刷新列表。不向外抛：调用处是 `void xxx().then(() => reloadAccounts(...))`，
    // 再抛就成了未处理的 rejection。刷新失败时把原因接在成功提示后面，不能让成功提示把它盖掉。
    try {
      const rows = await accountsOf(platform)
      setAcc((a) => ({ ...a, rows, selected: Math.min(a.selected, Math.max(0, rows.length - 1)), confirmLogout: null }))
      setNote(done)
    } catch (e) {
      setNote(`${done}，但读取账号列表失败：${toCatbusError(e).message}`)
    }
    refreshRows()
  }

  const openSetup = () => {
    const info = loginMethods(platform)
    if (!loginCommand(platform) || info.methods.length === 0) {
      setNote(`${platform.name}不需要登录`)
      return
    }
    const method = Math.max(0, info.methods.indexOf(info.default ?? info.methods[0]!))
    setSetup({ methods: info.methods, method, account: '', scopes: info.scopes, scope: 0, values: {}, focus: 0 })
    setSetupError(null)
    setEditor(initial(''))
    setLoginView(null)
    setMode('login')
  }

  const beginLogin = () => {
    if (!setup) return
    const method = setup.methods[setup.method]!
    // 文本要非空，开关要打开，才算填了
    const filled = (v: string | boolean | undefined) => (typeof v === 'string' ? v.trim() !== '' : v === true)
    const missing = loginFields(platform, method).find((f) => f.required && !filled(setup.values[f.name]))
    if (missing) {
      setSetupError(`先填 ${missing.label}`)
      return
    }
    setSetupError(null)
    const scope = setup.scopes.length && setup.scope > 0 ? setup.scopes[setup.scope - 1] : undefined
    setLoginView({ type: 'working', text: '正在准备登录…' })
    setEditor(initial(''))
    loginMark.current = logs.count
    loginSession.current = startLogin(
      { platform, method, account: setup.account, ...(scope ? { scope } : {}), fields: setup.values, log: bufferLogger(logs) },
      (v) => {
        setLoginView(v)
        if (v.type === 'prompt') setEditor(initial(''))
        if (v.type === 'done') refreshRows()
      },
    )
  }

  const restartLogin = () => {
    const old = loginSession.current
    old?.cancel()
    void (old?.done ?? Promise.resolve()).then(() => {
      if (alive.current) beginLogin()
    })
  }

  const leaveLogin = () => {
    loginSession.current?.cancel()
    loginSession.current = null
    setLoginView(null)
    setSetup(null)
    setMode('browse')
    refreshRows()
  }

  // ---- 监听 ----

  const beginListen = (p: Platform, c: Command, words: string[], given: Record<string, unknown>) => {
    setListening({ platform: p, command: c, words, given })
    setMode('listen')
  }

  // ---- 接着做 ----

  const openNext = () => {
    if (phase.type !== 'results') return
    const item = phase.results.items[phase.selected]
    const origin = originOf(phase.results, phase.selected)
    const list = nextSteps(origin.platform, origin.command, item)
    setSteps(list)
    setStepAt(0)
    setMode('next')
  }

  const runNext = (n: Next) => {
    if (phase.type === 'results') setBack((b) => [...b, phase])
    setMode('browse')
    if (n.command.stream) beginListen(n.platform, n.command, n.words, n.given)
    else void run(n.platform, n.command, n.words, n.given, null, undefined, cliFromInvocation(n.platform, n.command, n.words, n.given))
  }

  const nextPage = () => {
    if (phase.type !== 'results' || phase.loadingMore || !phase.results.page?.has_more) return
    const r = phase.results
    void run(r.platform, r.command, r.words, r.given, r.page!.cursor, r)
  }

  // ---- 下载、评论、媒体（结果页）----

  /** 结果页选中的这一条，以及它来自哪个平台（聚合搜索里每条不一样）。 */
  const currentItem = (): { item: unknown; platform: Platform } | null => {
    if (phase.type !== 'results') return null
    return { item: phase.results.items[phase.selected], platform: originOf(phase.results, phase.selected).platform }
  }

  /** 下载：有选中的就下载选中的，否则下载当前这一条。按平台分组，各用各的 item download。 */
  const startDownload = () => {
    if (phase.type !== 'results') return
    const r = phase.results
    const picked = phase.marked?.size ? [...phase.marked].sort((a, b) => a - b) : [phase.selected]
    const groups = new Map<string, { platform: Platform; items: unknown[] }>()
    for (const i of picked) {
      const p = originOf(r, i).platform
      const grp = groups.get(p.id) ?? { platform: p, items: [] }
      grp.items.push(r.items[i])
      groups.set(p.id, grp)
    }
    let added = 0
    const cannot: string[] = []
    for (const grp of groups.values()) {
      const dl = runnableCommand(grp.platform, 'item download')
      if (dl) added += queue.add(grp.platform, dl, grp.items)
      else cannot.push(grp.platform.name)
    }
    const tail = cannot.length ? `；${cannot.join('、')}不能在界面里下载` : ''
    if (added) setPhase({ ...phase, marked: new Set() })
    setNote(added ? `已加入下载 ${added} 条，保存到 ${dirRef.current}，按 D 看进度${tail}` : tail ? tail.slice(1) : '这一项没法下载')
  }

  /** 打开评论页或媒体页：只对一条内容（Item）有意义。 */
  const openItemScreen = (next: 'comments' | 'media') => {
    const cur = currentItem()
    if (!cur || kindOf(cur.item) !== 'item') return setNote('选中的不是一条内容')
    const item = cur.item as Record<string, unknown>
    if (!refOf(item, cur.platform)) return setNote('这一条没有 ID，也没有链接')
    if (next === 'comments' && !canComment(cur.platform)) return setNote(`${cur.platform.name}不能在界面里看评论`)
    setTarget({ platform: cur.platform, item })
    setMode(next)
  }

  const toggleMark = () => {
    if (phase.type !== 'results') return
    const marked = new Set(phase.marked ?? [])
    if (marked.has(phase.selected)) marked.delete(phase.selected)
    else marked.add(phase.selected)
    const sel = clamp(phase.selected + 1, 0, total - 1)
    setPhase({ ...phase, marked, selected: sel, top: scrollTo(sel, phase.top, resultsVisible(phase.results, bodyRows), total) })
  }

  const markAll = () => {
    if (phase.type !== 'results') return
    setPhase({ ...phase, marked: phase.marked?.size === total ? new Set() : new Set(phase.results.items.map((_, i) => i)) })
  }

  // ---- 搜索入口、回到结果、聚合搜索（浏览页）----

  /** 按 s：打开本平台的搜索（没有搜索就是推荐流），焦点在关键词上。 */
  const openSearch = () => {
    const c = primaryCommand(platform)
    if (!c) return setNote(`${platform.name}没有能在界面里运行的搜索或推荐流`)
    openCommand(platform, c)
  }

  /** 按 r：回到这个平台上一次的结果（选中位置也还在）。 */
  const restoreResults = () => {
    const last = lastResults.current.get(platform.id)
    if (!last) return setNote(`${platform.name}这次还没有运行过命令`)
    setBack([])
    setPhase(last)
    setMode('browse')
  }

  /** 聚合搜索的结果：合成一份结果，每条记着来自哪个平台。 */
  const showAggregate = (keyword: string, result: AggregateResult) => {
    const fails = result.failures.map((f) => `${f.platform.name} ${f.error.code}`).join('、')
    const first = result.origins[0]
    if (!first) {
      setMode('browse')
      setNote(fails ? `没有结果；失败：${fails}` : '没有结果')
      return
    }
    const counts = Object.entries(result.counts).map(([id, n]) => `${platforms.find((p) => p.id === id)?.name ?? id} ${n}`).join('、')
    const notes = [counts, ...(fails ? [`失败：${fails}`] : [])]
    const shell = process.platform === 'win32' ? 'win' : 'posix'
    const results: Results = {
      platform: first.platform,
      command: first.command,
      line: `catbus ${first.platform.id} item search ${quote(keyword, shell)}`,
      words: [keyword],
      given: {},
      items: result.items,
      single: false,
      page: null,
      account: null,
      origins: result.origins,
      notes,
    }
    setBack([])
    setPhase({ type: 'results', results, selected: 0, top: 0, loadingMore: false })
    setMode('browse')
  }

  /** 结果页底部的等价命令：聚合搜索按选中这一条来自的平台写。 */
  const resultLine = (ph: Extract<Phase, { type: 'results' }>): string => {
    const r = ph.results
    if (!r.origins) return r.line
    const o = originOf(r, ph.selected)
    return cliFromInvocation(o.platform, o.command, r.words, r.given)
  }

  const copy = async (text: string, what: string) => {
    const method = await copyText(text)
    setNote(method ? `已复制${what}` : `没能写入剪贴板，请手动复制：${text}`)
  }

  // ---- 按键 ----

  const total = phase.type === 'results' ? phase.results.items.length : 0
  const bodyRows = screenRows - 3

  // ---- 按键：每种界面状态一个处理函数，useInput 只负责分发 ----

  function onLoginKey(input: string, key: Key): void {
    const v = loginView
    if (!v) {
      // 选方式、填字段
      if (!setup) return
      const rowsNow = setupRows(platform, setup)
      const cur = rowsNow[setup.focus]!
      const isToggle = cur.field?.kind === 'toggle'
      const isText = cur.id !== 'method' && cur.id !== 'scope' && !isToggle
      const commit = (state: TextState) => {
        if (cur.id === 'account') setSetup({ ...setup, account: state.value })
        else setSetup({ ...setup, values: { ...setup.values, [cur.id]: state.value } })
      }
      const focusTo = (n: number) => {
        const next = (n + rowsNow.length) % rowsNow.length
        const target = rowsNow[next]!
        setSetup((st) => (st ? { ...st, focus: next } : st))
        const val = target.id === 'account' ? setup.account : setup.values[target.id]
        setEditor(initial(typeof val === 'string' ? val : ''))
      }
      if (key.escape) return leaveLogin()
      if (key.return) return beginLogin()
      if (key.tab || key.downArrow) return focusTo(setup.focus + (key.shift ? -1 : 1))
      if (key.upArrow) return focusTo(setup.focus - 1)
      if (cur.id === 'method' && (key.leftArrow || key.rightArrow || input === 'h' || input === 'l')) {
        const d = key.leftArrow || input === 'h' ? -1 : 1
        const m = (setup.method + d + setup.methods.length) % setup.methods.length
        setSetup({ ...setup, method: m, values: {}, focus: 0 })
        return
      }
      if (cur.id === 'scope' && (key.leftArrow || key.rightArrow || input === 'h' || input === 'l')) {
        const n = setup.scopes.length + 1
        const d = key.leftArrow || input === 'h' ? -1 : 1
        setSetup({ ...setup, scope: (setup.scope + d + n) % n })
        return
      }
      if (isToggle && (input === ' ' || key.leftArrow || key.rightArrow)) {
        setSetup({ ...setup, values: { ...setup.values, [cur.id]: setup.values[cur.id] !== true } })
        return
      }
      if (isText) {
        const next = edit(editor, input, key)
        if (next) {
          setEditor(next)
          commit(next)
        }
      }
      return
    }
    if (v.type === 'done' || v.type === 'error') {
      if (v.type === 'error' && input === 'r') {
        setLoginView(null)
        return
      }
      if (key.escape || key.return || input === 'q') {
        const wasDone = v.type === 'done'
        leaveLogin()
        if (wasDone) {
          setNote(`已登录 ${platform.name}`)
          void accountsOf(platform)
            .then((rows) => setAcc((a) => ({ ...a, rows })))
            .catch(() => {})
        }
      }
      return
    }
    if (key.escape) {
      loginSession.current?.cancel()
      setLoginView(null)
      return
    }
    if (v.type === 'link' && input === 'o') {
      void openUrl(v.url).then((ok) => setNote(ok ? '已在浏览器打开' : '没能打开浏览器，请手动复制上面的链接'))
      return
    }
    if (v.type === 'qrcode' && input === 'r') return restartLogin()
    if (v.type === 'qrcode' && input === 'o') {
      void openFile(v.png).then((ok) => setNote(ok ? '已用系统查看器打开二维码图片' : `没能打开图片，请手动打开：${v.png}`))
      return
    }
    if (v.type === 'prompt') {
      if (key.return) {
        const text = editor.value
        setEditor(initial(''))
        setLoginView({ type: 'working', text: '提交中…' })
        loginSession.current?.answer(text)
        return
      }
      const next = edit(editor, input, key)
      if (next) setEditor(next)
    }
    return
  }

  function onAccountsKey(input: string, key: Key): void {
    if (acc.confirmLogout) {
      const target = acc.confirmLogout
      setAcc((a) => ({ ...a, confirmLogout: null }))
      if (input === 'y') {
        void logoutAccount(platform, target, bufferLogger(logs))
          .then(() => {
            // 登出的正是本次浏览用的账号：改回当前账号
            setBrowseAs((m) => {
              if (m[platform.id] !== target) return m
              const n = { ...m }
              delete n[platform.id]
              return n
            })
            return reloadAccounts(`已登出 ${target}`)
          })
          .catch((e) => setNote(`登出失败：${(e as Error).message}`))
      }
      return
    }
    if (key.escape || input === 'q' || input === 'a') return setMode('browse')
    const row = acc.rows[acc.selected]
    if (key.upArrow || input === 'k') return setAcc((a) => ({ ...a, selected: Math.max(0, a.selected - 1) }))
    if (key.downArrow || input === 'j') return setAcc((a) => ({ ...a, selected: Math.min(a.rows.length - 1, a.selected + 1) }))
    if (input === 'n') return openSetup()
    if (!row) return
    if (key.return) {
      void useAccount(platform, row.account, bufferLogger(logs))
        .then(() => reloadAccounts(`当前账号：${row.account}`))
        .catch((e) => setNote((e as Error).message))
      return
    }
    if (input === 'b') {
      const same = browseAs[platform.id] === row.account
      setBrowseAs((m) => {
        const n = { ...m }
        if (same) delete n[platform.id]
        else n[platform.id] = row.account
        return n
      })
      setNote(same ? '本次浏览改回当前账号' : `本次浏览用 ${row.account}（不改当前账号）`)
      return
    }
    if (input === 'x') return setAcc((a) => ({ ...a, confirmLogout: row.account }))
    if (input === 't') {
      setAcc((a) => ({ ...a, checked: { ...a.checked, [row.account]: 'checking' } }))
      void checkAccount(platform, row.account, bufferLogger(logs))
        .then((st) => setAcc((a) => ({ ...a, checked: { ...a.checked, [row.account]: st } })))
        .catch(() => setAcc((a) => ({ ...a, checked: { ...a.checked, [row.account]: 'failed' } })))
    }
    return
  }

  function onNextKey(input: string, key: Key): void {
    if (key.escape || input === 'q') return setMode('browse')
    if (key.upArrow || input === 'k') return setStepAt((n) => Math.max(0, n - 1))
    if (key.downArrow || input === 'j') return setStepAt((n) => Math.min(steps.length - 1, n + 1))
    const picked = steps[stepAt]
    if (!picked) return
    if (key.return) return runNext(picked)
    if (input === 'c') void copy(cliFromInvocation(picked.platform, picked.command, picked.words, picked.given), '命令')
    return
  }

  function onPaletteKey(input: string, key: Key): void {
    if (key.escape) return setMode('browse')
    if (key.return) {
      const hit = hits[pi2]
      if (hit) openCommand(hit.platform, hit.command)
      return
    }
    if (key.upArrow) return setPi2((n) => Math.max(0, n - 1))
    if (key.downArrow) return setPi2((n) => Math.min(hits.length - 1, n + 1))
    const next = edit(query, input, key)
    if (next) {
      setQuery(next)
      setPi2(0)
    }
    return
  }

  function onResultsKey(input: string, key: Key): void {
    // 分发处已经保证是结果态；这里重新收窄，让后面能用 phase.results / phase.selected
    if (phase.type !== 'results') return
    const move = (n: number) => {
      const sel = clamp(n, 0, total - 1)
      setPhase({ ...phase, selected: sel, top: scrollTo(sel, phase.top, resultsVisible(phase.results, bodyRows), total) })
      if (sel >= total - 3) nextPage()
    }
    if (mode === 'detail') {
      if (key.escape || input === 'h' || key.leftArrow || key.return) setMode('browse')
      else if (input === 'j' || key.downArrow) move(phase.selected + 1)
      else if (input === 'k' || key.upArrow) move(phase.selected - 1)
      else if (input === 'J') setMode('json')
      return
    }
    if (key.escape || input === 'q') {
      const prev = back.at(-1)
      if (prev) {
        setBack((b) => b.slice(0, -1))
        setPhase(prev)
      } else setPhase({ type: 'browse' })
      return
    }
    if (input === 'j' || key.downArrow) move(phase.selected + 1)
    else if (input === 'k' || key.upArrow) move(phase.selected - 1)
    else if (key.pageDown) move(phase.selected + resultsVisible(phase.results, bodyRows))
    else if (key.pageUp) move(phase.selected - resultsVisible(phase.results, bodyRows))
    else if (input === 'g' || key.home) move(0)
    else if (input === 'G' || key.end) move(total - 1)
    else if (key.return) openNext()
    else if (input === 'l' || key.rightArrow) setMode(columns >= 100 ? 'json' : 'detail')
    else if (input === 'n') nextPage()
    else if (input === 'J') setMode('json')
    else if (input === 'y') {
      const link = linkOf(phase.results.items[phase.selected])
      if (link) void copy(link, '链接')
    } else if (input === 'o') {
      const link = linkOf(phase.results.items[phase.selected])
      if (link && /^https?:/i.test(link)) void openUrl(link).then((ok) => setNote(ok ? '已在浏览器打开' : '没能打开浏览器'))
      else setNote('这一项没有可打开的链接')
    } else if (input === 'c') void copy(resultLine(phase), '命令')
    else if (input === '/') {
      setQuery(initial(''))
      setPi2(0)
      setMode('palette')
    } else if (input === 'a') openAccounts()
    else if (input === ' ') toggleMark()
    else if (input === 'v') markAll()
    else if (input === 'd') startDownload()
    else if (input === 'D') setMode('downloads')
    else if (input === 'm') openItemScreen('comments')
    else if (input === 'i') openItemScreen('media')
    return
  }

  function onBrowseKey(input: string, key: Key): void {
  if (input === '/' && !(pane === 'form' && fieldList[fi] && ['arg', 'string', 'number', 'array'].includes(fieldList[fi]!.kind))) {
    setQuery(initial(''))
    setPi2(0)
    setMode('palette')
    return
  }

  if (pane === 'form' && command) {
    const fd = fieldList[fi]
    if (key.escape) return setPane('commands')
    if (key.return) {
      if (fd && (fd.kind === 'boolean')) return setFormValues((v) => ({ ...v, [fd.label]: !v[fd.label] }))
      return submit()
    }
    if (key.tab || key.downArrow) {
      const n = key.shift ? fi - 1 : fi + 1
      if (fieldList.length) startEditing((n + fieldList.length) % fieldList.length)
      return
    }
    if (key.upArrow) {
      if (fieldList.length) startEditing((fi - 1 + fieldList.length) % fieldList.length)
      return
    }
    if (fd?.kind === 'enum' && fd.values) {
      if (key.leftArrow || key.rightArrow || input === 'h' || input === 'l') {
        const values = fd.values
        const now = (formValues[fd.label] ?? fd.default ?? values[0]) as string
        const at = Math.max(0, values.indexOf(now))
        const next = values[(at + (key.leftArrow || input === 'h' ? -1 : 1) + values.length) % values.length]!
        setFormValues((v) => ({ ...v, [fd.label]: next }))
      } else if (input === ' ') setFormValues((v) => ({ ...v, [fd.label]: undefined }))
      else if (input === 'c') void copy(line, '命令')
      return
    }
    if (fd?.kind === 'boolean') {
      if (input === ' ' || key.leftArrow || key.rightArrow) setFormValues((v) => ({ ...v, [fd.label]: !v[fd.label] }))
      else if (input === 'c') void copy(line, '命令')
      return
    }
    if (fd) {
      const next = edit(editor, input, key)
      if (next) {
        setEditor(next)
        writeField(next)
      } else if (key.ctrl && input === 'y') void copy(line, '命令')
    } else if (input === 'c') void copy(line, '命令')
    return
  }

  if (key.escape) {
    if (pane === 'commands') setPane('platforms')
    return
  }
  if (input === 'q') return exit()
  if (input === '?') return setMode('help')
  if (input === 'a') return openAccounts()
  if (input === 'T') return toggleTheme()
  if (input === 's') return openSearch()
  if (input === 'r') return restoreResults()
  if (input === 'A') return setMode('aggregate')
  if (input === 'S') return setMode('settings')
  if (input === 'D') return setMode('downloads')
  if (input === 'c') return void copy(line, '命令')
  if (key.tab) {
    setPane(pane === 'platforms' ? 'commands' : 'platforms')
    return
  }

  if (pane === 'platforms') {
    if (input === 'j' || key.downArrow) selectPlatform(pi + 1)
    else if (input === 'k' || key.upArrow) selectPlatform(pi - 1)
    else if (key.return || key.rightArrow || input === 'l') setPane('commands')
    return
  }

  // commands
  if (input === 'j' || key.downArrow) moveTo(ri + 1)
  else if (input === 'k' || key.upArrow) moveTo(ri - 1)
  else if (key.pageDown) moveTo(ri + 8)
  else if (key.pageUp) moveTo(ri - 8)
  else if (input === 'g' || key.home) moveTo(0)
  else if (input === 'G' || key.end) moveTo(navRows.length - 1)
  else if (key.leftArrow || input === 'h') {
    if (current?.type === 'group' && current.open) setOpenGroups((s) => new Set([...s].filter((x) => x !== current.resource)))
    else if (current?.type === 'command') {
      const gi = navRows.findIndex((r) => r.type === 'group' && r.resource === current.command.resource)
      if (gi >= 0) moveTo(gi)
    } else setPane('platforms')
  } else if (key.rightArrow || key.return || input === 'l') {
    if (current?.type === 'group') {
      setOpenGroups((s) => {
        const n = new Set(s)
        n.has(current.resource) ? n.delete(current.resource) : n.add(current.resource)
        return n
      })
    } else if (current?.type === 'command') {
      setPane('form')
      startEditing(0, {})
      setFormValues({})
    }
  }
  }

  useInput(
    (input, key) => {
    if (splash) {
      setSplash(false)
      return
    }
    if (layout === 'tiny') {
      if (input === 'q' || (key.ctrl && input === 'c')) exit()
      return
    }
    if (key.ctrl && input === 'c') {
      exit()
      return
    }

    if (mode === 'help') {
      // 帮助放不下一屏时可以滚动；其他键返回
      if (key.downArrow || input === 'j') return setHelpTop((n) => Math.min(Math.max(0, HELP_LINES - helpVisible(bodyRows)), n + 1))
      if (key.upArrow || input === 'k') return setHelpTop((n) => Math.max(0, n - 1))
      setHelpTop(0)
      setMode('browse')
      return
    }

    if (mode === 'login') return onLoginKey(input, key)
    if (mode === 'accounts') return onAccountsKey(input, key)
    if (mode === 'next') return onNextKey(input, key)
    if (mode === 'palette') return onPaletteKey(input, key)

    if (mode === 'json') {
      if (key.escape || input === 'q' || input === 'J') setMode('browse')
      return
    }

    if (phase.type === 'running') {
      if (key.escape) {
        abort.current?.abort()
        setPhase({ type: 'browse' })
      }
      return
    }

    if (phase.type === 'error') {
      const needLogin = (phase.code === 'AUTH_REQUIRED' || phase.code === 'AUTH_EXPIRED') && loginCommand(platform) != null
      if (needLogin && (key.return || input === 'l')) {
        // 直接去登录：登录成功后回到这里按 r 重试
        setPhase({ type: 'browse' })
        openSetup()
      } else if (key.escape || key.return || input === 'q') setPhase({ type: 'browse' })
      else if (input === 'r') submit()
      return
    }

    if (phase.type === 'results') return onResultsKey(input, key)
    onBrowseKey(input, key)
    },
    // 监听、下载、评论、媒体、设置、聚合搜索这几页有自己的 useInput；这里让路，免得同一次按键处理两遍
    { isActive: !SCREENS.has(mode) },
  )

  // 粘贴：只在表单的文本字段里生效
  usePaste(
    (text) => {
      if (mode === 'palette') {
        const next = edit(query, text, {})
        if (next) setQuery(next)
        return
      }
      if (mode === 'login') {
        const v = loginView
        if (!v && setup) {
          const cur = setupRows(platform, setup)[setup.focus]!
          if (cur.id === 'method' || cur.id === 'scope' || cur.field?.kind === 'toggle') return
          const next = edit(editor, text, {})
          if (next) {
            setEditor(next)
            if (cur.id === 'account') setSetup({ ...setup, account: next.value })
            else setSetup({ ...setup, values: { ...setup.values, [cur.id]: next.value } })
          }
        } else if (v?.type === 'prompt') {
          const next = edit(editor, text, {})
          if (next) setEditor(next)
        }
        return
      }
      if (pane !== 'form' || phase.type !== 'browse') return
      const fd = fieldList[fi]
      if (!fd || !['arg', 'string', 'number', 'array'].includes(fd.kind)) return
      const next = edit(editor, text, {})
      if (next) {
        setEditor(next)
        writeField(next)
      }
    },
    { isActive: layout !== 'tiny' },
  )

  // ---- 画面 ----

  if (layout === 'tiny') {
    return (
      <Box flexDirection="column" padding={1}>
        <T c="yellow" bold>
          终端太小了
        </T>
        <T>{`catbus tui 需要至少 80 × 24，现在是 ${columns} × ${screenRows}。`}</T>
        <T c="dim">放大窗口后会自动恢复，按 q 退出。</T>
      </Box>
    )
  }

  if (splash) return <Splash cols={columns} rows={screenRows} onDone={endSplash} />

  const accountInfo = platformList[pi]!
  const header = (
    <Box width={columns} height={1} overflow="hidden">
      <T c="accent" bold>
        {look.ascii ? ' ( >w_ )' : ' ( >ω_ )'}
      </T>
      <T bold>{'  catbus'}</T>
      <T c="dim">{'  ' + (phase.type === 'results' ? (phase.results.origins ? `聚合搜索 ${g.sep} ` : `${phase.results.platform.name} ${g.sep} ${phase.results.command.resource} ${g.sep} `) : '')}</T>
      {phase.type === 'results' ? <T c="accent">{phase.results.command.action}</T> : <T c="dim">上车，开往任何平台</T>}
      <Box flexGrow={1} />
      <T c="sub">{'账号 '}</T>
      {downloads.waiting + downloads.running ? <T c="accent">{`下载 ${downloads.done}/${downloads.done + downloads.failed + downloads.waiting + downloads.running + downloads.paused}  `}</T> : null}
      {browseAs[platform.id] ? (
        <T c="yellow">{`${browseAs[platform.id]}（本次）`}</T>
      ) : (
        <T c={accountInfo.loggedIn ? 'green' : 'dim'}>{accountInfo.account ?? (accountInfo.open ? '免登录' : '游客')}</T>
      )}
      <T c="dim">{`  端 ${endpointOf(platform)}  `}</T>
    </Box>
  )

  // 监听屏自己画整屏（含等价命令与按键行），并自己处理按键
  if (mode === 'listen' && listening) {
    return (
      <Box flexDirection="column" width={columns} height={screenRows}>
        {header}
        <ListenScreen
          platform={listening.platform}
          command={listening.command}
          words={listening.words}
          given={listening.given}
          account={browseRef.current[listening.platform.id]}
          logs={logs}
          cols={columns}
          rows={screenRows - 1}
          onExit={() => {
            setListening(null)
            setMode('browse')
          }}
          onError={(e) => {
            setListening(null)
            setMode('browse')
            setPhase({ type: 'error', code: e.code, message: e.message, hint: e.hint, exit: e.exitCode })
          }}
        />
      </Box>
    )
  }

  // 下载、评论、媒体、设置、聚合搜索：各自画整屏、处理按键，Esc 回到原来的页面
  const belowHeader = screenRows - 1
  const leaveScreen = () => setMode('browse')
  let screen: React.ReactNode = null
  if (mode === 'downloads') screen = <DownloadsScreen queue={queue} dir={downloadDir} cols={columns} rows={belowHeader} onExit={leaveScreen} />
  else if (mode === 'settings') screen = <SettingsScreen cols={columns} rows={belowHeader} downloadDir={downloadDir} onDownloadDir={setDownloadDir} light={light} onToggleTheme={toggleTheme} onExit={leaveScreen} />
  else if (mode === 'aggregate') screen = <AggregateScreen rowsOfPlatforms={platformList} logs={logs} accountOf={accountFor} cols={columns} rows={belowHeader} onResults={showAggregate} onExit={leaveScreen} />
  else if (target && (mode === 'comments' || mode === 'media')) {
    const title = String(target.item.title ?? target.item.text ?? target.item.id ?? '').replace(/\s+/g, ' ')
    const as = browseAs[target.platform.id]
    if (mode === 'media') screen = <MediaScreen platform={target.platform} item={target.item} title={title} account={as} logs={logs} cols={columns} rows={belowHeader} onExit={leaveScreen} />
    else {
      const url = typeof target.item.url === 'string' ? target.item.url : null
      screen = <CommentsScreen platform={target.platform} itemRef={refOf(target.item, target.platform) ?? ''} itemUrl={url} title={title} account={as} logs={logs} cols={columns} rows={belowHeader} onExit={leaveScreen} />
    }
  }
  if (screen) {
    return (
      <Box flexDirection="column" width={columns} height={screenRows}>
        {header}
        {screen}
      </Box>
    )
  }

  let body: React.ReactNode
  let keys: React.ReactNode
  const wide = layout === 'wide'
  const canLogin = loginCommand(platform) != null

  if (mode === 'login' && setup) {
    if (!loginView) {
      body = <SetupView platform={platform} state={setup} editor={editor} cols={columns} rows={bodyRows} error={setupError} />
      keys = <SetupKeys cols={columns - 2} />
    } else if (loginView.type === 'done' || loginView.type === 'error') {
      body = <ResultView platform={platform} view={loginView} cols={columns} rows={bodyRows} />
      keys = <Keys cols={columns - 2} items={loginView.type === 'error' ? [['r', '重试'], ['Esc', '返回']] : [['Enter', '完成']]} />
    } else {
      body = <ProgressView platform={platform} view={loginView} editor={editor} cols={columns} rows={bodyRows} spin={g.spin[spin % g.spin.length]!} recent={logs.since(loginMark.current)} />
      keys = <ProgressKeys cols={columns - 2} view={loginView} />
    }
  } else if (mode === 'accounts') {
    body = <AccountsView platform={platform} state={acc} cols={columns} rows={bodyRows} canLogin={canLogin} note={note} browsing={browseAs[platform.id] ?? null} />
    keys = accountKeys(columns - 2, canLogin)
  } else if (mode === 'next' && phase.type === 'results') {
    const item = phase.results.items[phase.selected] as Record<string, unknown> | undefined
    body = <NextView steps={steps} selected={stepAt} title={String(item?.title ?? item?.name ?? item?.id ?? '')} cols={columns} rows={bodyRows} />
    keys = <NextKeys cols={columns - 2} />
  } else if (mode === 'help') {
    body = <HelpView cols={columns} rows={bodyRows} top={helpTop} />
    keys = <Keys cols={columns - 2} items={[['任意键', '返回']]} />
  } else if (mode === 'palette') {
    body = <PaletteView query={query} entries={hits} selected={pi2} cols={columns} rows={bodyRows} loggedIn={new Set(platformList.filter((r) => r.loggedIn).map((r) => r.platform.id))} />
    keys = null
  } else if (phase.type === 'running') {
    body = (
      <Pane title={phase.label} cols={columns} rows={bodyRows} focused>
        <Box paddingLeft={2} paddingTop={1}>
          <T c="accent">{g.spin[spin % g.spin.length]}</T>
          <T>{'  正在运行…'}</T>
        </Box>
        <Box paddingLeft={2}>
          <T c="dim">按 Esc 取消</T>
        </Box>
      </Pane>
    )
    keys = <Keys cols={columns - 2} items={[['Esc', '取消']]} />
  } else if (phase.type === 'error') {
    body = <ErrorView phase={phase} cols={columns} rows={bodyRows} platform={platform} />
    const needLogin = (phase.code === 'AUTH_REQUIRED' || phase.code === 'AUTH_EXPIRED') && canLogin
    keys = <Keys cols={columns - 2} items={needLogin ? [['Enter', '去登录'], ['r', '重试'], ['Esc', '返回']] : [['r', '重试'], ['Esc', '返回']]} />
  } else if (phase.type === 'results' && mode === 'json') {
    const text = JSON.stringify(rawOf(phase.results.items[phase.selected]), null, 2) ?? ''
    body = <JsonView text={text} cols={columns} rows={bodyRows} />
    keys = <Keys cols={columns - 2} items={[['Esc', '返回']]} />
  } else if (phase.type === 'results') {
    const r = phase.results
    body = <ResultsView data={r} selected={phase.selected} top={phase.top} cols={columns} rows={bodyRows} detail={mode === 'detail'} loadingMore={phase.loadingMore} marked={phase.marked} />
    const here = originOf(r, phase.selected).platform
    keys = <ResultKeys cols={columns - 2} canMore={!!r.page?.has_more} split={columns >= 100} canDownload={runnableCommand(here, 'item download') != null} canComments={canComment(here)} />
  } else {
    const h = bodyRows
    const platformCols = wide ? 24 : 22
    const rest = columns - platformCols
    const commandCols = wide ? Math.floor(rest * 0.46) : pane === 'form' ? 0 : rest
    const formCols = wide ? rest - commandCols : pane === 'form' ? rest : 0
    body = (
      <Box width={columns}>
        <PlatformPane rows={platformList} selected={pi} cols={platformCols} height={h} focused={pane === 'platforms'} />
        {commandCols > 0 ? <CommandPane platform={platform} rows={navRows} selected={ri} top={top} cols={commandCols} height={h} focused={pane === 'commands'} /> : null}
        {formCols > 0 ? (
          <Box flexDirection="column" width={formCols}>
            <FormPane command={command} values={formValues} active={fi} editor={editor} cols={formCols} height={h - (wide ? MASCOT_ROWS + 1 : 0)} focused={pane === 'form'} note={note} />
            {wide ? (
              <Box height={MASCOT_ROWS + 1} width={formCols} justifyContent="flex-end" alignItems="flex-end" paddingRight={1}>
                <Mascot animate={phase.type === 'browse' && mode === 'browse'} />
              </Box>
            ) : null}
          </Box>
        ) : null}
      </Box>
    )
    keys = <BrowseKeys cols={columns - 2} pane={pane} canRun={!!command && usable(command)} />
  }

  const lineText = phase.type === 'results' ? resultLine(phase) : line
  const status = note ?? log
  return (
    <Box flexDirection="column" width={columns} height={screenRows}>
      {header}
      {body}
      {mode === 'palette' ? null : (
        <Box width={columns} height={1} overflow="hidden" paddingLeft={1}>
          <T c="dim">{'等价命令  '}</T>
          <T c="accent">{clip(lineText, columns - 24, g.more)}</T>
        </Box>
      )}
      <Box width={columns} height={1} overflow="hidden" paddingLeft={1}>
        {status && mode !== 'palette' ? <T c={note ? 'green' : 'dim'}>{clip(status, columns - 4, g.more)}</T> : keys}
      </Box>
    </Box>
  )
}

/** 帮助页的内容：按键说明、标记图例、两句提示。空行是分组之间的间隔。 */
const HELP: ([string, string] | null)[] = [
  ['↑ ↓  j k', '上下移动'],
  ['← →  h l', '收起 / 展开，进入 / 返回'],
  ['Tab', '换栏；在表单里换字段'],
  ['Enter', '展开命令、运行命令'],
  ['/', '命令面板：搜遍全部平台的命令'],
  ['s', '搜索当前平台（没有搜索的平台是推荐流）'],
  ['A', '聚合搜索：一个关键词同时搜几个平台'],
  ['r', '回到这个平台上一次的结果'],
  ['c', '复制当前的等价命令'],
  ['a', '账号页：切换、检查、登出、登录新账号'],
  ['b', '账号页：只在这次浏览里用这个账号，不改当前账号'],
  ['D  S', '下载进度 / 设置（代理、超时、下载目录）'],
  ['T', '切换浅色 / 深色'],
  null,
  ['Enter', '结果页：接着做什么（评论、作者、监听……，参数已填好）'],
  ['空格  v  d', '结果页：选择 / 全选 / 下载选中的（没选就下载当前这条）'],
  ['m  i', '结果页：看评论和楼中楼 / 图片视频地址'],
  ['y  o', '结果页：复制链接 / 在浏览器里打开'],
  ['n', '结果页：下一页（滚到底部也会自动取）'],
  ['J', '结果页：看原始 JSON（--raw 的内容）'],
  ['Esc', '返回上一级'],
  ['q  Ctrl-C', '退出'],
  null,
  ['● 命令', '在界面里运行'],
  ['~ 命令', '持续监听（弹幕、私信）'],
  ['○ 命令', '读取之外的命令，复制到终端运行'],
  ['- 命令', '规划中，还没实现'],
  ['● 平台', '已登录；青色是免登录可用'],
  null,
  ['', '界面里运行读取类命令、下载、监听和登录；写入、删除、发布请复制命令到终端执行。'],
  ['', '终端把 ● ○ │ 显示成两列宽时，设置环境变量 CATBUS_TUI_ASCII=1。'],
]

/** 帮助页能显示几行：放不下时可以用 ↑↓ 滚动（窗口最小是 80 × 24，放不下全部）。 */
export const helpVisible = (rows: number): number => Math.max(1, rows - 3)
export const HELP_LINES = HELP.length

function HelpView({ cols, rows, top }: { cols: number; rows: number; top: number }) {
  const g = useGlyphs()
  const visible = helpVisible(rows)
  const start = Math.max(0, Math.min(top, HELP.length - visible))
  return (
    <Pane title="按键" cols={cols} rows={rows} focused>
      {HELP.slice(start, start + visible).map((line, i) =>
        line == null ? (
          <Box key={start + i} height={1} />
        ) : (
          <Box key={start + i} paddingLeft={2}>
            <T c={line[0] ? 'accent' : 'dim'}>{line[0] ? padEnd(line[0], 14) : ''}</T>
            <T c={line[0] ? undefined : 'dim'}>{clip(line[1], cols - 20, g.more)}</T>
          </Box>
        ),
      )}
      {HELP.length > visible ? (
        <Box paddingLeft={2}>
          <T c="dim">{`${start + 1}-${Math.min(HELP.length, start + visible)} / ${HELP.length}  ↑↓ 滚动，其他键返回`}</T>
        </Box>
      ) : null}
    </Pane>
  )
}

function ErrorView({ phase, cols, rows, platform }: { phase: Extract<Phase, { type: 'error' }>; cols: number; rows: number; platform: Platform }) {
  const g = useGlyphs()
  const need = phase.code === 'AUTH_REQUIRED' || phase.code === 'AUTH_EXPIRED'
  const title = need ? '需要登录' : phase.code === 'RISK_CONTROL' ? '触发风控' : phase.code === 'NOT_IMPLEMENTED' ? '还没做' : phase.code === 'NETWORK' ? '网络错误' : '出错了'
  const color = need ? 'yellow' : phase.code === 'NOT_IMPLEMENTED' ? 'mauve' : 'red'
  return (
    <Pane title={`${title} ${g.sep} ${phase.code} · 退出码 ${phase.exit}`} cols={cols} rows={rows} focused>
      <Box paddingLeft={2} paddingTop={1}>
        <T c={color} bold>
          {title}
        </T>
      </Box>
      <Box paddingLeft={2}>
        <T>{clip(phase.message, cols - 6, g.more)}</T>
      </Box>
      {phase.hint ? (
        <Box paddingLeft={2} paddingTop={1}>
          <T c="dim">{'在终端运行：'}</T>
          <T c="accent">{clip(phase.hint, cols - 20, g.more)}</T>
        </Box>
      ) : null}
      {need ? (
        <Box paddingLeft={2} paddingTop={1}>
          {loginCommand(platform) ? (
            <>
              <T c="dim">{'按 '}</T>
              <T c="accent">Enter</T>
              <T c="dim">{' 直接登录' + platform.name + '，登录后回来按 r 重试'}</T>
            </>
          ) : (
            <T c="dim">{platform.name}没有登录命令</T>
          )}
        </Box>
      ) : null}
    </Pane>
  )
}

function JsonView({ text, cols, rows }: { text: string; cols: number; rows: number }) {
  const g = useGlyphs()
  const lines = text.split('\n')
  const room = rows - 3
  return (
    <Pane title="原始对象 (--raw)" cols={cols} rows={rows} focused>
      {lines.slice(0, room).map((l, i) => (
        <Box key={i} paddingLeft={1}>
          <Text>{clip(l.replace(/\t/g, '  '), cols - 4, g.more)}</Text>
        </Box>
      ))}
      {lines.length > room ? (
        <Box paddingLeft={1}>
          <T c="dim">{`${g.more} 还有 ${lines.length - room} 行，完整内容请在终端用 --raw`}</T>
        </Box>
      ) : null}
    </Pane>
  )
}
