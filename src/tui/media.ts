import type { Logger } from '../core/log.js'
import type { Platform } from '../core/registry.js'
import { refOf } from './follow.js'
import { runnableCommand } from './model.js'
import { type RunRequest, runCommand } from './run.js'

// 一条内容的媒体（AGENTS 4.13）：图片、视频、音频的地址，用系统的浏览器或查看器打开。
// 终端里不画图：各终端的图片协议不通用（Windows 控制台都不支持），统一交给系统去打开。

export interface MediaEntry {
  type: string
  url: string
  /** 列表里的说明：类型、尺寸、时长。 */
  label: string
}

type Obj = Record<string, any>
const isObj = (v: unknown): v is Obj => v != null && typeof v === 'object' && !Array.isArray(v)
const TYPE: Record<string, string> = { image: '图片', video: '视频', audio: '音频' }

function entry(m: Obj, fallback: string): MediaEntry | null {
  if (typeof m.url !== 'string' || !/^https?:\/\//i.test(m.url)) return null
  const type = typeof m.type === 'string' ? m.type : fallback
  const parts = [TYPE[type] ?? type]
  if (typeof m.width === 'number' && typeof m.height === 'number') parts.push(`${m.width}×${m.height}`)
  if (typeof m.duration === 'number' && m.duration > 0) parts.push(`${Math.round(m.duration)} 秒`)
  return { type, url: m.url, label: parts.join(' · ') }
}

/** 对象里已有的媒体：media 数组，再加封面。地址不是 http(s) 的跳过（刚上传还没有地址的视频是 null）。 */
export function mediaOf(item: unknown): MediaEntry[] {
  if (!isObj(item)) return []
  const out: MediaEntry[] = []
  for (const m of Array.isArray(item.media) ? item.media : []) {
    const e = isObj(m) ? entry(m, 'image') : null
    if (e) out.push(e)
  }
  if (typeof item.cover === 'string' && /^https?:\/\//i.test(item.cover) && !out.some((e) => e.url === item.cover)) {
    out.push({ type: 'image', url: item.cover, label: '封面' })
  }
  return out
}

/** 平台的 item media 能在界面里运行：用它取可播放 / 可下载的地址（列表里的对象常常只有封面）。 */
export function canFetchMedia(platform: Platform): boolean {
  return runnableCommand(platform, 'item media') != null
}

export async function fetchMedia(req: { platform: Platform; item: unknown; log: Logger; account?: string; signal?: AbortSignal }): Promise<MediaEntry[]> {
  const command = runnableCommand(req.platform, 'item media')
  const ref = isObj(req.item) ? refOf(req.item, req.platform) : null
  if (!command || !ref) return mediaOf(req.item)
  const run: RunRequest = { platform: req.platform, command, words: [ref], given: {}, log: req.log }
  if (req.signal) run.signal = req.signal
  if (req.account) run.account = req.account
  const r = await runCommand(run)
  const list = (Array.isArray(r.data) ? r.data : []).filter(isObj).map((m) => entry(m, 'video')).filter((e): e is MediaEntry => e != null)
  // item media 没给的（例如封面）从对象里补上
  for (const e of mediaOf(req.item)) if (!list.some((x) => x.url === e.url)) list.push(e)
  return list
}
