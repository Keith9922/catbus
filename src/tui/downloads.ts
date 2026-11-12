import { type CatbusError, toCatbusError } from '../core/errors.js'
import type { Logger } from '../core/log.js'
import * as rand from '../core/rand.js'
import type { Command, Platform } from '../core/registry.js'
import { refOf } from './follow.js'
import { type RunRequest, runCommand } from './run.js'

// 批量下载（AGENTS 4.13）：结果页里选几条按 d，一条一条地跑 item download，和 CLI 一样把文件写到 --dir。
// 同一时间只跑一条，条与条之间隔开平台的翻页间隔。遇到风控或登录问题，同一平台剩下的先停（标成“暂停”），按 r 重试。
// 不含 React：界面订阅变化；退出下载页时队列照常在后台跑。

export type JobState = 'waiting' | 'running' | 'done' | 'failed' | 'paused'

export interface DownloadedFile {
  path: string
  size: number | null
}

export interface Job {
  id: number
  platform: Platform
  command: Command
  /** 传给 item download 的参数：xhs 用 URL（带 xsec_token），其余用 ID（AGENTS 4.8）。 */
  ref: string
  title: string
  state: JobState
  files: DownloadedFile[]
  error: CatbusError | null
}

export interface QueueOptions {
  log: Logger
  /** 下载目录：每条开始时取，设置页里改了之后的条目用新目录。 */
  dir: () => string
  /** 这个平台本次浏览用的账号（-a）；不给时用当前账号。 */
  account: (platform: Platform) => string | undefined
  /** 条与条之间等多久（毫秒）；默认取平台的翻页间隔。 */
  gap?: (platform: Platform) => number
}

export type Counts = Record<JobState, number>

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => v != null && typeof v === 'object' && !Array.isArray(v)

/** 一条内容在下载列表里显示的标题。 */
export function titleOf(item: unknown): string {
  if (!isObj(item)) return ''
  for (const k of ['title', 'text', 'name', 'id']) {
    const v = item[k]
    if (v != null && v !== '') return String(v).replace(/\s+/g, ' ')
  }
  return ''
}

function filesOf(data: unknown): DownloadedFile[] {
  if (!Array.isArray(data)) return []
  return data.filter(isObj).map((f) => ({ path: String(f.path ?? ''), size: typeof f.size === 'number' ? f.size : null }))
}

/** 停下同一平台剩下的条目：风控时接着请求只会更糟，登录问题重试也不会好。 */
const STOP_PLATFORM = new Set(['RISK_CONTROL', 'AUTH_REQUIRED', 'AUTH_EXPIRED'])

export class DownloadQueue {
  readonly jobs: Job[] = []
  private seq = 0
  private running = false
  private stopped = false
  private subs = new Set<() => void>()

  private readonly opts: QueueOptions

  constructor(opts: QueueOptions) {
    this.opts = opts
  }

  subscribe(fn: () => void): () => void {
    this.subs.add(fn)
    return () => {
      this.subs.delete(fn)
    }
  }

  private emit(): void {
    for (const fn of this.subs) fn()
  }

  /** 加入一批，返回加入的条数。没有 id 也没有 url 的条目没法下载，跳过。 */
  add(platform: Platform, command: Command, items: unknown[]): number {
    let added = 0
    for (const item of items) {
      if (!isObj(item)) continue
      const ref = refOf(item, platform)
      if (!ref) continue
      this.jobs.push({ id: ++this.seq, platform, command, ref, title: titleOf(item), state: 'waiting', files: [], error: null })
      added++
    }
    if (added) {
      // 停止只管当时排着的；之后再加的是用户新要下载的，要接着跑（包括正在下载的那条下完之后）
      this.stopped = false
      this.emit()
      void this.pump()
    }
    return added
  }

  /** 失败和暂停的重新排队，返回条数。 */
  retry(): number {
    let n = 0
    for (const j of this.jobs) {
      if (j.state !== 'failed' && j.state !== 'paused') continue
      j.state = 'waiting'
      j.error = null
      n++
    }
    if (n) {
      this.stopped = false
      this.emit()
      void this.pump()
    }
    return n
  }

  /** 停止：排队中的标成暂停，正在下载的那条下完为止（下载命令不一定能中途打断）。 */
  stop(): void {
    let changed = false
    for (const j of this.jobs) {
      if (j.state !== 'waiting') continue
      j.state = 'paused'
      changed = true
    }
    this.stopped = true
    if (changed) this.emit()
  }

  /** 去掉已完成的记录（文件不动）。 */
  clearDone(): void {
    const keep = this.jobs.filter((j) => j.state !== 'done')
    if (keep.length === this.jobs.length) return
    this.jobs.splice(0, this.jobs.length, ...keep)
    this.emit()
  }

  counts(): Counts {
    const c: Counts = { waiting: 0, running: 0, done: 0, failed: 0, paused: 0 }
    for (const j of this.jobs) c[j.state]++
    return c
  }

  /** 是否还有没结束的：排队中或正在下载。 */
  busy(): boolean {
    return this.jobs.some((j) => j.state === 'waiting' || j.state === 'running')
  }

  private async pump(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      for (;;) {
        const job = this.jobs.find((j) => j.state === 'waiting')
        if (!job || this.stopped) break
        await this.runOne(job)
        if (!this.jobs.some((j) => j.state === 'waiting')) break
        await rand.sleep(this.opts.gap?.(job.platform) ?? job.platform.pageInterval)
      }
    } finally {
      this.running = false
    }
  }

  private async runOne(job: Job): Promise<void> {
    job.state = 'running'
    this.emit()
    try {
      const req: RunRequest = { platform: job.platform, command: job.command, words: [job.ref], given: { dir: this.opts.dir() }, log: this.opts.log }
      const account = this.opts.account(job.platform)
      if (account) req.account = account
      const r = await runCommand(req)
      job.files = filesOf(r.data)
      job.state = 'done'
    } catch (err) {
      const e = toCatbusError(err)
      job.state = 'failed'
      job.error = e
      if (STOP_PLATFORM.has(e.code)) {
        for (const j of this.jobs) if (j.state === 'waiting' && j.platform.id === job.platform.id) j.state = 'paused'
      }
    } finally {
      this.emit()
    }
  }
}
