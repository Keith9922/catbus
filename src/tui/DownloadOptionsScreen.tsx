import { Box, useInput } from 'ink'
import { useState } from 'react'
import { edit, initial, splitAtCursor, type TextState } from './input.js'
import { Frame } from './screen.js'
import { padEnd } from './text.js'
import { Row, T, useGlyphs } from './ui.js'

// 批量下载的选项面板（AGENTS 4.13）：对应 item download 的 --meta、--comments、--replies、--no-media。
// 在下载前出现一次，选好按 d 开始；选项只用于这一批，不记住到下一次。

export interface DownloadOptions {
  meta: boolean
  comments: string
  replies: string
  noMedia: boolean
}

export const DEFAULT_DOWNLOAD_OPTIONS: DownloadOptions = { meta: false, comments: '', replies: '', noMedia: false }

const COUNT_RE = /^(\d+|all)$/

type Id = 'meta' | 'comments' | 'replies' | 'noMedia'
const ROWS: { id: Id; label: string; hint: string; kind: 'toggle' | 'text' }[] = [
  { id: 'noMedia', label: '只要信息', hint: '不下载媒体，只写帖子信息（隐含写信息）', kind: 'toggle' },
  { id: 'meta', label: '写信息', hint: '同时把帖子信息写成 <platform>_<id>.json', kind: 'toggle' },
  { id: 'comments', label: '导出评论', hint: '一级评论的条数，或 all；留空表示不取（隐含写信息）', kind: 'text' },
  { id: 'replies', label: '评论的回复', hint: '每条一级评论再取的回复数，或 all；留空表示不取', kind: 'text' },
]

/** 校验并整理成 DownloadQueue.add 的 options：comments/replies 留空就不传；noMedia、comments 隐含 meta。 */
export function resolveDownloadOptions(o: DownloadOptions): { options: Record<string, unknown>; error: string | null } {
  for (const [id, label] of [['comments', '导出评论'], ['replies', '评论的回复']] as const) {
    const v = o[id].trim()
    if (v && !COUNT_RE.test(v)) return { options: {}, error: `${label}：只能是正整数或 all` }
  }
  const out: Record<string, unknown> = {}
  if (o.noMedia) out.noMedia = true
  if (o.meta || o.noMedia || o.comments.trim()) out.meta = true
  if (o.comments.trim()) out.comments = o.comments.trim()
  if (o.replies.trim()) out.replies = o.replies.trim()
  return { options: out, error: null }
}

export function DownloadOptionsScreen({
  count,
  cols,
  rows,
  onStart,
  onExit,
}: {
  /** 这一批要下载的条数，只用于显示。 */
  count: number
  cols: number
  rows: number
  onStart: (options: Record<string, unknown>) => void
  onExit: () => void
}) {
  const g = useGlyphs()
  const [values, setValues] = useState<DownloadOptions>(DEFAULT_DOWNLOAD_OPTIONS)
  const [sel, setSel] = useState(0)
  const [editing, setEditing] = useState<TextState | null>(null)
  const [error, setError] = useState<string | null>(null)

  const row = ROWS[sel]!

  useInput((input, key) => {
    if (editing != null) {
      if (key.return) {
        setValues((v) => ({ ...v, [row.id]: editing.value }))
        setEditing(null)
        return
      }
      if (key.escape) {
        setEditing(null)
        return
      }
      const next = edit(editing, input, key)
      if (next) setEditing(next)
      return
    }
    if (key.escape) return onExit()
    if (key.upArrow || key.tab) return setSel((n) => (n - 1 + ROWS.length) % ROWS.length)
    if (key.downArrow) return setSel((n) => (n + 1) % ROWS.length)
    if (input === 'd') {
      const { options, error: err } = resolveDownloadOptions(values)
      if (err) return setError(err)
      return onStart(options)
    }
    if (row.kind === 'toggle' && (input === ' ' || key.return)) {
      setValues((v) => ({ ...v, [row.id]: !v[row.id] }))
      return
    }
    if (row.kind === 'text' && key.return) {
      setError(null)
      setEditing(initial(String(values[row.id])))
    }
  })

  const inner = cols - 2
  const labelW = 10
  return (
    <Frame
      cols={cols}
      rows={rows}
      title={`下载选项 ${g.sep} ${count} 条，不选就只下媒体`}
      info={row.hint}
      note={error}
      keys={editing ? [['Enter', '保存'], ['Esc', '取消']] : [['↑↓', '选择'], ['空格/Enter', '切换 / 修改'], ['d', '开始下载'], ['Esc', '返回']]}
    >
      <Box height={1} />
      {ROWS.map((r, i) => {
        const on = i === sel
        const v = values[r.id]
        let value: React.ReactNode
        if (on && editing && r.kind === 'text') {
          const [a, c, b] = splitAtCursor(editing)
          value = (
            <>
              <T c="accent">{a}</T>
              <T bg="accent">{c === '' ? ' ' : c}</T>
              <T c="accent">{b}</T>
            </>
          )
        } else if (r.kind === 'toggle') {
          value = <T c={v ? 'green' : 'dim'}>{v ? '[x]' : '[ ]'}</T>
        } else {
          value = v ? <T c="accent">{String(v)}</T> : <T c="dim">未设置</T>
        }
        return <Row key={r.id} cols={inner} selected={on} left={<>{padEnd(' ' + r.label, labelW)}{value}</>} />
      })}
      <Box paddingLeft={2} paddingTop={1}>
        <T bg="green" bold>
          {' d 开始下载 '}
        </T>
      </Box>
    </Frame>
  )
}
