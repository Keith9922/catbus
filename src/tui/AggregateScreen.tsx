import { Box, useInput } from 'ink'
import { useEffect, useRef, useState } from 'react'
import type { Platform } from '../core/registry.js'
import { type AggregateResult, searchAll, searchable } from './aggregate.js'
import { edit, initial, splitAtCursor, type TextState } from './input.js'
import { type LogBuffer, bufferLogger } from './logs.js'
import type { PlatformRow } from './model.js'
import { Frame } from './screen.js'
import { clip } from './text.js'
import { Row, T, useGlyphs } from './ui.js'

// 聚合搜索（AGENTS 4.13）：输入关键词、勾选平台，同时搜；结果合成一个列表，交给结果页显示。

export function AggregateScreen({
  rowsOfPlatforms,
  logs,
  accountOf,
  cols,
  rows,
  onResults,
  onExit,
}: {
  rowsOfPlatforms: PlatformRow[]
  logs: LogBuffer
  /** 这个平台本次浏览用的账号；不给时用当前账号。 */
  accountOf: (platform: Platform) => string | undefined
  cols: number
  rows: number
  onResults: (keyword: string, result: AggregateResult) => void
  onExit: () => void
}) {
  const g = useGlyphs()
  const candidates = searchable(rowsOfPlatforms.map((r) => r.platform))
  // 默认勾选：已登录的，或者免登录就能用的
  const [picked, setPicked] = useState<Set<string>>(() => new Set(rowsOfPlatforms.filter((r) => r.loggedIn || r.open).map((r) => r.platform.id).filter((id) => candidates.some((p) => p.id === id))))
  const [keyword, setKeyword] = useState<TextState>(() => initial(''))
  // 焦点：0 是关键词，之后是平台
  const [focus, setFocus] = useState(0)
  const [running, setRunning] = useState<{ done: number; total: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const controller = useRef<AbortController | null>(null)
  useEffect(() => () => controller.current?.abort(), [])

  const start = () => {
    const kw = keyword.value.trim()
    const targets = candidates.filter((p) => picked.has(p.id))
    if (!kw) return setError('先输入关键词')
    if (!targets.length) return setError('至少勾选一个平台')
    setError(null)
    const c = (controller.current = new AbortController())
    setRunning({ done: 0, total: targets.length })
    searchAll({
      platforms: targets,
      keyword: kw,
      log: bufferLogger(logs),
      account: accountOf,
      signal: c.signal,
      onSettled: () => setRunning((r) => (r ? { ...r, done: r.done + 1 } : r)),
    }).then(
      (result) => !c.signal.aborted && onResults(kw, result),
      (err) => !c.signal.aborted && (setRunning(null), setError(String((err as Error).message ?? err))),
    )
  }

  useInput((input, key) => {
    if (running) {
      if (key.escape) {
        controller.current?.abort()
        setRunning(null)
      }
      return
    }
    if (key.escape) return onExit()
    if (key.return) return start()
    if (key.tab || key.downArrow) return setFocus((f) => (f + (key.shift ? -1 : 1) + candidates.length + 1) % (candidates.length + 1))
    if (key.upArrow) return setFocus((f) => (f - 1 + candidates.length + 1) % (candidates.length + 1))
    if (focus === 0) {
      const next = edit(keyword, input, key)
      if (next) setKeyword(next)
      return
    }
    const p = candidates[focus - 1]!
    if (input === ' ') {
      setPicked((s) => {
        const n = new Set(s)
        n.has(p.id) ? n.delete(p.id) : n.add(p.id)
        return n
      })
    } else if (input === 'a') {
      setPicked((s) => (s.size === candidates.length ? new Set() : new Set(candidates.map((x) => x.id))))
    }
  })

  const inner = cols - 2
  const [a, c, b] = splitAtCursor(keyword)
  const room = Math.max(1, rows - 2 - 7)
  const start0 = Math.max(0, Math.min(focus - 1 - Math.floor(room / 2), candidates.length - room))
  return (
    <Frame
      cols={cols}
      rows={rows}
      title={`聚合搜索 ${g.sep} 一个关键词同时搜几个平台 · 已选 ${picked.size} / ${candidates.length}`}
      info="每个平台搜一页，最多同时搜 3 个；结果轮流排在一个列表里，每条标出平台"
      note={null}
      keys={running ? [['Esc', '取消']] : [['Tab ↑↓', '换项'], ['空格', '勾选平台'], ['a', '全选'], ['Enter', '搜索'], ['Esc', '返回']]}
    >
      <Box paddingLeft={1} paddingTop={1}>
        <T c={focus === 0 ? 'accent' : 'dim'}>{focus === 0 ? g.caret : ' '}</T>
        <T c={focus === 0 ? 'fg' : 'dim'}>{' 关键词   '}</T>
        {focus === 0 ? (
          <>
            <T c="accent">{a}</T>
            <T bg="accent">{c === '' ? ' ' : c}</T>
            <T c="accent">{b}</T>
          </>
        ) : (
          <T c={keyword.value ? 'accent' : 'dim'}>{keyword.value || '必填'}</T>
        )}
      </Box>
      <Box height={1} />
      {candidates.slice(start0, start0 + room).map((p, i) => {
        const on = focus === start0 + i + 1
        const row = rowsOfPlatforms.find((r) => r.platform.id === p.id)
        const state = row?.loggedIn ? `账号 ${row.account}` : row?.open ? '免登录' : '未登录'
        return (
          <Row
            key={p.id}
            cols={inner}
            selected={on}
            right={state}
            rightColor={row?.loggedIn ? 'green' : row?.open ? 'teal' : 'dim'}
            left={<T c={picked.has(p.id) ? 'accent' : 'dim'}>{`${picked.has(p.id) ? '[x]' : '[ ]'} ${p.name}`}</T>}
          />
        )
      })}
      {running ? (
        <Box paddingLeft={2} paddingTop={1}>
          <T c="accent">{g.spin[running.done % g.spin.length]}</T>
          <T>{`  正在搜索… 已完成 ${running.done} / ${running.total} 个平台，Esc 取消`}</T>
        </Box>
      ) : null}
      {error ? (
        <Box paddingLeft={2} paddingTop={1}>
          <T c="red">{clip(error, inner - 4, g.more)}</T>
        </Box>
      ) : null}
    </Frame>
  )
}
