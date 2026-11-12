import { type CatbusError, toCatbusError } from '../core/errors.js'
import type { Logger } from '../core/log.js'
import type { Platform } from '../core/registry.js'
import { runnableCommand } from './model.js'
import { type RunRequest, runCommand } from './run.js'
import type { Origin } from './state.js'

// 聚合搜索（AGENTS 4.13）：一个关键词同时搜几个平台的 item search，结果合成一个列表，每条记着来自哪个平台。
// 同时最多跑 3 个平台；每个平台只取一页。某个平台失败不影响其他平台，失败的写进 failures。

export interface AggregateResult {
  items: unknown[]
  origins: Origin[]
  /** 每个平台取到几条（失败的不在里面）。 */
  counts: Record<string, number>
  failures: { platform: Platform; error: CatbusError }[]
}

/** 能参加聚合搜索的平台：web 端有能在界面里运行的 item search。 */
export function searchable(platforms: readonly Platform[]): Platform[] {
  return platforms.filter((p) => runnableCommand(p, 'item search') != null)
}

/** 轮流从每个平台取一条，排成一个列表：前面几屏就能看到各个平台的结果，而不是先看完一个平台。 */
export function interleave<T>(lists: T[][]): T[] {
  const out: T[] = []
  const longest = Math.max(0, ...lists.map((l) => l.length))
  for (let i = 0; i < longest; i++) for (const l of lists) if (i < l.length) out.push(l[i]!)
  return out
}

export async function searchAll(req: {
  platforms: readonly Platform[]
  keyword: string
  log: Logger
  /** 这个平台本次浏览用的账号（-a）；不给时用当前账号。 */
  account: (platform: Platform) => string | undefined
  signal?: AbortSignal
  concurrency?: number
  /** 每个平台结束（成功或失败）时调用，用来显示进度。 */
  onSettled?: (platform: Platform) => void
}): Promise<AggregateResult> {
  const targets = searchable(req.platforms)
  const lists: { item: unknown; origin: Origin }[][] = targets.map(() => [])
  const counts: Record<string, number> = {}
  const failures: AggregateResult['failures'] = []
  let next = 0
  const worker = async () => {
    for (;;) {
      const i = next++
      if (i >= targets.length || req.signal?.aborted) return
      const platform = targets[i]!
      const command = runnableCommand(platform, 'item search')!
      try {
        const run: RunRequest = { platform, command, words: [req.keyword], given: {}, log: req.log }
        if (req.signal) run.signal = req.signal
        const account = req.account(platform)
        if (account) run.account = account
        const r = await runCommand(run)
        const items = Array.isArray(r.data) ? r.data : r.data == null ? [] : [r.data]
        lists[i] = items.map((item) => ({ item, origin: { platform, command } }))
        counts[platform.id] = items.length
      } catch (err) {
        failures.push({ platform, error: toCatbusError(err) })
      } finally {
        req.onSettled?.(platform)
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(req.concurrency ?? 3, targets.length) }, worker))
  const merged = interleave(lists)
  // 失败的按平台在列表里的顺序排，提示里看起来稳定
  failures.sort((a, b) => targets.indexOf(a.platform) - targets.indexOf(b.platform))
  return { items: merged.map((x) => x.item), origins: merged.map((x) => x.origin), counts, failures }
}
