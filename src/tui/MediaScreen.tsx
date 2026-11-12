import { Box, useInput } from 'ink'
import { useEffect, useRef, useState } from 'react'
import { toCatbusError } from '../core/errors.js'
import type { Platform } from '../core/registry.js'
import { copyText, openUrl } from './clipboard.js'
import { type LogBuffer, bufferLogger } from './logs.js'
import { canFetchMedia, fetchMedia, type MediaEntry, mediaOf } from './media.js'
import { Frame } from './screen.js'
import { scrollTo } from './state.js'
import { clip, width } from './text.js'
import { Row, T, useGlyphs } from './ui.js'

// 媒体页（AGENTS 4.13）：一条内容的图片、视频地址，Enter 用系统的浏览器打开。

export function MediaScreen({
  platform,
  item,
  title,
  account,
  logs,
  cols,
  rows,
  onExit,
}: {
  platform: Platform
  item: unknown
  title: string
  account?: string
  logs: LogBuffer
  cols: number
  rows: number
  onExit: () => void
}) {
  const g = useGlyphs()
  const [list, setList] = useState<MediaEntry[]>(() => mediaOf(item))
  const [loading, setLoading] = useState(() => canFetchMedia(platform))
  const [error, setError] = useState<string | null>(null)
  const [sel, setSel] = useState(0)
  const [top, setTop] = useState(0)
  const [note, setNote] = useState<string | null>(null)
  const alive = useRef(true)
  useEffect(() => {
    const controller = new AbortController()
    if (canFetchMedia(platform)) {
      const req: Parameters<typeof fetchMedia>[0] = { platform, item, log: bufferLogger(logs), signal: controller.signal }
      if (account) req.account = account
      fetchMedia(req).then(
        (l) => alive.current && setList(l),
        (err) => {
          if (!alive.current) return
          const e = toCatbusError(err)
          setError(`取媒体地址失败：${e.code} ${e.message}（下面是列表里已有的）`)
        },
      ).finally(() => alive.current && setLoading(false))
    }
    return () => {
      alive.current = false
      controller.abort()
    }
  }, [platform, item, logs, account])
  useEffect(() => {
    if (!note) return
    const t = setTimeout(() => setNote(null), 3000)
    return () => clearTimeout(t)
  }, [note])

  const visible = Math.max(3, rows - 2 - 4)
  const at = Math.min(sel, Math.max(0, list.length - 1))
  const picked = list[at]
  const move = (n: number) => {
    const next = Math.max(0, Math.min(list.length - 1, n))
    setSel(next)
    setTop((t) => scrollTo(next, t, visible, list.length))
  }

  useInput((input, key) => {
    if (key.escape || input === 'q') return onExit()
    if (key.upArrow || input === 'k') return move(at - 1)
    if (key.downArrow || input === 'j') return move(at + 1)
    if (!picked) return
    if (key.return || input === 'o') {
      void openUrl(picked.url).then((ok) => setNote(ok ? '已在浏览器打开' : `没能打开浏览器，请手动复制：${picked.url}`))
      return
    }
    if (input === 'y') void copyText(picked.url).then((m) => setNote(m ? '已复制地址' : `没能写入剪贴板：${picked.url}`))
  })

  const inner = cols - 2
  return (
    <Frame
      cols={cols}
      rows={rows}
      title={`媒体 ${g.sep} ${platform.name} ${g.sep} ${clip(title, Math.max(8, cols - 30), g.more)} · ${list.length}`}
      info={picked ? picked.url : '终端里不显示图片和视频：用浏览器打开'}
      note={note}
      keys={[['↑↓', '选择'], ['Enter', '浏览器打开'], ['y', '复制地址'], ['Esc', '返回']]}
    >
      {loading ? (
        <Box paddingLeft={2}>
          <T c="dim">{`${g.spin[0]} 正在取媒体地址…`}</T>
        </Box>
      ) : null}
      {error ? (
        <Box paddingLeft={2}>
          <T c="red">{clip(error, inner - 4, g.more)}</T>
        </Box>
      ) : null}
      {!loading && list.length === 0 ? (
        <Box paddingLeft={2} paddingTop={1}>
          <T c="dim">这一条没有可打开的媒体地址。</T>
        </Box>
      ) : null}
      {list.slice(top, top + visible).map((m, i) => (
        <Row
          key={m.url}
          cols={inner}
          selected={top + i === at}
          right={m.label}
          left={<T c="sky">{clip(m.url, Math.max(8, inner - width(m.label) - 4), g.more)}</T>}
        />
      ))}
    </Frame>
  )
}
