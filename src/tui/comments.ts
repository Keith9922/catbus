import type { CatbusError } from '../core/errors.js'
import type { Logger } from '../core/log.js'
import type { Platform } from '../core/registry.js'
import { runnableCommand } from './model.js'
import { type RunRequest, runCommand } from './run.js'

// 详情里的评论（AGENTS 4.13）：一条内容的评论和楼中楼。都是按需取（翻到底取下一页，Enter 展开回复），
// 不自动预取，少发请求，也就少碰风控。不含 React：取数据的函数只返回这一页，合并交给 append*，
// 界面用函数式的状态更新去合并，几个请求先后回来也不会互相覆盖。

type Obj = Record<string, any>
const isObj = (v: unknown): v is Obj => v != null && typeof v === 'object' && !Array.isArray(v)

export interface Thread {
  comment: Obj
  /** null：还没展开过。 */
  replies: Obj[] | null
  open: boolean
  cursor: string | null
  hasMore: boolean
  loading: boolean
  error: CatbusError | null
}

export interface CommentsState {
  threads: Thread[]
  cursor: string | null
  hasMore: boolean
  loading: boolean
  error: CatbusError | null
}

export type CommentRow =
| { type: 'comment'; thread: number }
| { type: 'reply'; thread: number; index: number }
/** 楼中楼还有更多、出错或正在取。 */
| { type: 'replies'; thread: number }
/** 评论还有下一页、出错或正在取。 */
| { type: 'more' }

export interface Paged<T> {
  items: T[]
  cursor: string | null
  hasMore: boolean
}

export const EMPTY: CommentsState = { threads: [], cursor: null, hasMore: true, loading: false, error: null }

/** 这个平台能不能在界面里看评论、看楼中楼。 */
export function canComment(platform: Platform): boolean {
  return runnableCommand(platform, 'comment list') != null
}
export function canReply(platform: Platform): boolean {
  return runnableCommand(platform, 'comment replies') != null
}

/** 一条评论有几条回复：平台给了回复数就用它；没给时看已经取到的。 */
export function replyCount(t: Thread): number {
  const n = t.comment.stats?.replies
  if (typeof n === 'number') return n
  return t.replies?.length ?? 0
}

/** 列表里依次有哪些行：评论，展开的回复，回复的“更多”，最后是评论的“更多”。order 不给时按加载顺序；
 * 给了就按它给的顺序和子集显示顶层评论（评论区筛选，AGENTS 4.13）。楼中楼不参与筛选，跟着它所属的评论走。 */
export function rows(s: CommentsState, order?: readonly number[]): CommentRow[] {
  const out: CommentRow[] = []
  const indices = order ?? s.threads.map((_, i) => i)
  for (const i of indices) {
    const t = s.threads[i]
    if (!t) continue
    out.push({ type: 'comment', thread: i })
    if (!t.open) continue
    t.replies?.forEach((_, j) => out.push({ type: 'reply', thread: i, index: j }))
    if (t.loading || t.error || t.hasMore) out.push({ type: 'replies', thread: i })
  }
  if (!order && (s.loading || s.error || s.hasMore)) out.push({ type: 'more' })
  return out
}

export type CommentSort = 'default' | 'hot' | 'new'
/** 评论区筛选起作用的门槛（AGENTS 4.13）：已加载的评论少于这个数就不显示搜索和排序。 */
export const COMMENT_FILTER_MIN = 5

/**
 * 评论区筛选（AGENTS 4.13）：只作用于已加载的顶层评论，不发请求、不改翻页。搜索在正文和作者昵称里做
 * 子串匹配（不分大小写）；最热按点赞数降序，最新按发布时间降序，取不到的排在最后；没有排序时保持加载顺序。
 * 返回匹配到的 thread 下标，交给 rows() 当 order。
 */
export function filterThreads(s: CommentsState, query: string, sort: CommentSort): number[] {
  const q = query.trim().toLowerCase()
  let indices = s.threads.map((_, i) => i)
  if (q) {
    indices = indices.filter((i) => {
      const c = s.threads[i]!.comment
      return String(c.text ?? '').toLowerCase().includes(q) || String(c.author?.name ?? '').toLowerCase().includes(q)
    })
  }
  if (sort === 'hot') {
    indices = [...indices].sort((a, b) => likesOf(s.threads[b]!.comment) - likesOf(s.threads[a]!.comment))
  } else if (sort === 'new') {
    indices = [...indices].sort((a, b) => timeOf(s.threads[b]!.comment) - timeOf(s.threads[a]!.comment))
  }
  return indices
}

function likesOf(c: Obj): number {
  const n = c.stats?.likes
  return typeof n === 'number' ? n : -1
}

function timeOf(c: Obj): number {
  const t = typeof c.created_at === 'string' ? Date.parse(c.created_at) : NaN
  return Number.isFinite(t) ? t : -Infinity
}

export interface Source {
  platform: Platform
  /** comment list 的参数：内容的 ID 或 URL（与 follow.refOf 一致）。 */
  item: string
  log: Logger
  account?: string
  signal?: AbortSignal
}

async function page(source: Source, key: 'comment list' | 'comment replies', words: string[], cursor: string | null): Promise<Paged<Obj>> {
  const command = runnableCommand(source.platform, key)
  if (!command) throw new Error(`${source.platform.name}不能在界面里运行 ${key}`)
  const req: RunRequest = { platform: source.platform, command, words, given: {}, cursor, log: source.log }
  if (source.signal) req.signal = source.signal
  if (source.account) req.account = source.account
  const r = await runCommand(req)
  return { items: (Array.isArray(r.data) ? r.data : []).filter(isObj), cursor: r.page?.cursor ?? null, hasMore: Boolean(r.page?.has_more) }
}

/** 取一页评论（cursor 为 null 时是第一页）。 */
export function fetchComments(source: Source, cursor: string | null): Promise<Paged<Obj>> {
  return page(source, 'comment list', [source.item], cursor)
}

/** 取一条评论的一页回复。 */
export function fetchReplies(source: Source, comment: Obj, cursor: string | null): Promise<Paged<Obj>> {
  return page(source, 'comment replies', [source.item, String(comment.id)], cursor)
}

/** 把一页评论接到后面。 */
export function appendComments(s: CommentsState, p: Paged<Obj>): CommentsState {
  const threads = p.items.map((comment): Thread => ({ comment, replies: null, open: false, cursor: null, hasMore: true, loading: false, error: null }))
  return { threads: [...s.threads, ...threads], cursor: p.cursor, hasMore: p.hasMore, loading: false, error: null }
}

/** 改第 i 条评论（其余不动）。 */
export function updateThread(s: CommentsState, i: number, change: (t: Thread) => Thread): CommentsState {
  const t = s.threads[i]
  if (!t) return s
  const threads = s.threads.slice()
  threads[i] = change(t)
  return { ...s, threads }
}

/** 把一页回复接到第 i 条评论后面，并展开它。 */
export function appendReplies(s: CommentsState, i: number, p: Paged<Obj>): CommentsState {
  return updateThread(s, i, (t) => ({ ...t, replies: [...(t.replies ?? []), ...p.items], cursor: p.cursor, hasMore: p.hasMore, loading: false, error: null, open: true }))
}
