import { Box, useInput } from 'ink'
import { useEffect, useMemo, useRef, useState } from 'react'
import { toCatbusError } from '../core/errors.js'
import type { Platform } from '../core/registry.js'
import { copyText, openUrl } from './clipboard.js'
import { appendComments, appendReplies, canReply, type CommentRow, type CommentsState, EMPTY, fetchComments, fetchReplies, replyCount, rows as rowsOf, type Source, updateThread } from './comments.js'
import { type LogBuffer, bufferLogger } from './logs.js'
import { quote } from './model.js'
import { Frame } from './screen.js'
import { scrollTo } from './state.js'
import { wrap } from './summary.js'
import { clip, count, when, width } from './text.js'
import { Row, T, useGlyphs } from './ui.js'

// 评论页（AGENTS 4.13）：一条内容的评论，Enter 展开楼中楼。翻到底自动取下一页；回复只在 Enter 时取。

type Obj = Record<string, any>
const author = (c: Obj): string => String(c.author?.name ?? c.author?.id ?? '')
const oneLine = (s: unknown): string => String(s ?? '').replace(/\s+/g, ' ')

export function CommentsScreen({
  platform,
  itemRef,
  itemUrl,
  title,
  account,
  logs,
  cols,
  rows,
  onExit,
}: {
  platform: Platform
  /** comment list 的参数（follow.refOf）。 */
  itemRef: string
  itemUrl: string | null
  title: string
  account?: string
  logs: LogBuffer
  cols: number
  rows: number
  onExit: () => void
}) {
  const g = useGlyphs()
  const [state, setState] = useState<CommentsState>(EMPTY)
  const [sel, setSel] = useState(0)
  const [top, setTop] = useState(0)
  const [note, setNote] = useState<string | null>(null)
  const alive = useRef(true)
  const controller = useRef(new AbortController())
  const source = useMemo<Source>(() => {
    const s: Source = { platform, item: itemRef, log: bufferLogger(logs), signal: controller.current.signal }
    if (account) s.account = account
    return s
  }, [platform, itemRef, logs, account])
  useEffect(
    () => () => {
      alive.current = false
      controller.current.abort()
    },
    [],
  )
  useEffect(() => {
    if (!note) return
    const t = setTimeout(() => setNote(null), 3000)
    return () => clearTimeout(t)
  }, [note])

  // 同一时间只取一页评论：第一页和“翻到底”的触发可能在同一次渲染里先后到来
  const fetching = useRef(false)
  const more = (s: CommentsState) => {
    if (s.loading || !s.hasMore || fetching.current) return
    fetching.current = true
    setState((x) => ({ ...x, loading: true, error: null }))
    fetchComments(source, s.cursor)
      .then(
        (p) => alive.current && setState((x) => appendComments(x, p)),
        (err) => alive.current && setState((x) => ({ ...x, loading: false, error: toCatbusError(err) })),
      )
      .finally(() => {
        fetching.current = false
      })
  }
  const replies = (i: number) => {
    const t = state.threads[i]
    if (!t || t.loading) return
    setState((x) => updateThread(x, i, (y) => ({ ...y, loading: true, error: null, open: true })))
    fetchReplies(source, t.comment, t.cursor).then(
      (p) => alive.current && setState((x) => appendReplies(x, i, p)),
      (err) => alive.current && setState((x) => updateThread(x, i, (y) => ({ ...y, loading: false, error: toCatbusError(err) }))),
    )
  }
  const list = rowsOf(state)
  // Pane 占 rows - 2 行，去掉标题线和底边；再留 6 行给选中这条的全文（空一行 + 作者 + 最多 4 行）
  const visible = Math.max(3, rows - 2 - 2 - 6)
  const at = Math.min(sel, Math.max(0, list.length - 1))
  const picked: CommentRow | undefined = list[at]
  const pickedComment = picked?.type === 'comment' ? state.threads[picked.thread]?.comment : picked?.type === 'reply' ? state.threads[picked.thread]?.replies?.[picked.index] : undefined
  // 翻到底（打开时列表只有“更多”一行，也算到底）：还有下一页就取
  useEffect(() => {
    if (list.length && at >= list.length - 3) more(state)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [at, list.length])

  const move = (n: number) => {
    const next = Math.max(0, Math.min(list.length - 1, n))
    setSel(next)
    setTop((t) => scrollTo(next, t, visible, list.length))
  }
  const enter = () => {
    if (!picked) return
    if (picked.type === 'more') return more({ ...state, error: null })
    if (picked.type === 'replies') return replies(picked.thread)
    if (picked.type !== 'comment') return
    const t = state.threads[picked.thread]!
    if (t.open) return setState((x) => updateThread(x, picked.thread, (y) => ({ ...y, open: false })))
    if (t.replies) return setState((x) => updateThread(x, picked.thread, (y) => ({ ...y, open: true })))
    if (replyCount(t) === 0) return setNote('这条评论没有回复')
    if (!canReply(platform)) return setNote(`${platform.name}不能单独取回复，只显示回复数`)
    replies(picked.thread)
  }

  useInput((input, key) => {
    if (key.escape || input === 'q') return onExit()
    if (key.upArrow || input === 'k') return move(at - 1)
    if (key.downArrow || input === 'j') return move(at + 1)
    if (key.pageDown) return move(at + visible)
    if (key.pageUp) return move(at - visible)
    if (key.return) return enter()
    if (input === 'y' && pickedComment) {
      const text = oneLine(pickedComment.text)
      void copyText(text).then((m) => setNote(m ? '已复制评论' : '没能写入剪贴板'))
      return
    }
    if (input === 'o') {
      if (itemUrl) void openUrl(itemUrl).then((ok) => setNote(ok ? '已在浏览器打开' : '没能打开浏览器'))
      else setNote('这一条没有链接')
    }
  })

  const inner = cols - 2
  const label = (r: CommentRow): { left: string; right: string; tone: 'red' | 'dim' | 'accent' | undefined; indent: string } => {
    if (r.type === 'more') {
      if (state.loading) return { left: `${g.spin[0]} 正在载入评论…`, right: '', tone: 'dim', indent: '' }
      if (state.error) return { left: `取评论失败：${state.error.code} ${state.error.message}，Enter 重试`, right: '', tone: 'red', indent: '' }
      return { left: '载入更多评论', right: '', tone: 'accent', indent: '' }
    }
    const t = state.threads[r.thread]!
    if (r.type === 'replies') {
      if (t.loading) return { left: `${g.spin[0]} 正在取回复…`, right: '', tone: 'dim', indent: '    ' }
      if (t.error) return { left: `取回复失败：${t.error.code}，Enter 重试`, right: '', tone: 'red', indent: '    ' }
      return { left: '展开更多回复', right: '', tone: 'accent', indent: '    ' }
    }
    const c = r.type === 'comment' ? t.comment : t.replies![r.index]!
    const likes = count(c.stats?.likes)
    const n = r.type === 'comment' ? replyCount(t) : 0
    const right = `${g.dotOn} ${likes}${n ? ` · 回复 ${count(n)}${t.open ? ' ▾' : ' ▸'}` : ''}`
    return { left: `${author(c)}：${oneLine(c.text)}`, right, tone: undefined, indent: r.type === 'reply' ? '  ↳ ' : '' }
  }

  const full = pickedComment ? wrap(oneLine(pickedComment.text), inner - 4, width).slice(0, 4) : []
  const head = `评论 ${g.sep} ${platform.name} ${g.sep} ${clip(title, Math.max(8, cols - 40), g.more)} · ${state.threads.length}${state.hasMore ? '+' : ''}`
  return (
    <Frame
      cols={cols}
      rows={rows}
      title={head}
      info={`等价命令  catbus ${platform.id} comment list ${quote(itemRef, process.platform === 'win32' ? 'win' : 'posix')}`}
      note={note}
      keys={[['↑↓', '选择'], ['Enter', '展开回复'], ['y', '复制评论'], ['o', '打开内容'], ['Esc', '返回']]}
    >
      {list.length === 0 ? (
        <Box paddingLeft={2} paddingTop={1}>
          <T c="dim">还没有评论。</T>
        </Box>
      ) : null}
      {list.slice(top, top + visible).map((r, i) => {
        const l = label(r)
        return (
          <Row
            key={`${r.type}-${'thread' in r ? r.thread : 'end'}-${r.type === 'reply' ? r.index : ''}`}
            cols={inner}
            selected={top + i === at}
            right={l.right || undefined}
            left={<T c={l.tone ?? (r.type === 'reply' ? 'sub' : undefined)}>{l.indent + clip(l.left, Math.max(8, inner - width(l.right) - 6), g.more)}</T>}
          />
        )
      })}
      {full.length ? (
        <Box flexDirection="column" paddingLeft={2} paddingTop={1}>
          <T c="dim">{`${author(pickedComment!)}${pickedComment!.created_at ? ' · ' + when(pickedComment!.created_at) : ''}`}</T>
          {full.map((line, i) => (
            <T key={i}>{line}</T>
          ))}
        </Box>
      ) : null}
    </Frame>
  )
}
