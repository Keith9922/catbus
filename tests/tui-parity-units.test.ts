import { describe, expect, it } from 'vitest'
import { CatbusError } from '../src/core/errors.js'
import { definePlatform, type HandlerContext } from '../src/core/registry.js'
import { interleave, searchAll, searchable } from '../src/tui/aggregate.js'
import { appendComments, appendReplies, EMPTY, rows, updateThread } from '../src/tui/comments.js'
import { DownloadQueue, titleOf } from '../src/tui/downloads.js'
import { mediaOf } from '../src/tui/media.js'
import { primaryCommand, runnableCommand } from '../src/tui/model.js'
import { expandDir } from '../src/tui/SettingsScreen.js'
import { bytes, columnsFor, flatten, kindOf } from '../src/tui/summary.js'
import { homedir } from 'node:os'

// 和网页界面对齐的几项里，不含 React 的部分：下载队列、聚合搜索、评论的行、媒体列表、摘要。

const log = { debug: () => undefined, info: () => undefined, warn: () => undefined }

/** 假平台的 item search：每次返回两条。 */
function searchCommand(id: string) {
  return {
    'item search': {
      upstream: 'full' as const,
      auth: 'optional' as const,
      handler: async () => async () => ({ data: [{ id: id + '1' }, { id: id + '2' }], page: { cursor: null, has_more: false } }),
    },
  }
}

/** 假平台：item download 按 behaviour 返回或抛错，记下每次下载的参数。 */
function platform(id: string, behaviour: (ref: string) => unknown, extra: { search?: boolean } = {}) {
  const calls: string[] = []
  const p = definePlatform({
    id,
    name: id,
    aliases: [],
    item: '帖子',
    endpoints: {
      web: {
        login: { methods: [] },
        guest: true,
        commands: {
          'item download': {
            upstream: 'full',
            auth: 'optional',
            handler: async () => async (ctx: HandlerContext) => {
              calls.push(String(ctx.args.item))
              return behaviour(String(ctx.args.item))
            },
          },
          ...(extra.search ? searchCommand(id) : undefined),
        },
      },
      app: 'planned',
      pc: 'planned',
    },
  })
  return { p, calls }
}

const settle = async (q: DownloadQueue) => {
  for (let i = 0; i < 100 && q.busy(); i++) await new Promise((r) => setTimeout(r, 5))
}

describe('下载队列', () => {
  const opts = (dir = '/tmp/x') => ({ log, dir: () => dir, account: () => undefined, gap: () => 0 })

  it('一条一条地下，结果记下文件；没有 id 也没有 url 的跳过', async () => {
    const { p, calls } = platform('dl', (ref) => [{ path: `/tmp/x/${ref}.mp4`, type: 'video', url: null, size: 2048 }])
    const q = new DownloadQueue(opts())
    expect(q.add(p, runnableCommand(p, 'item download')!, [{ id: 'a', title: '第一条' }, { id: 'b' }, { title: '没有 id' }, 'x'])).toBe(2)
    await settle(q)
    expect(calls).toEqual(['a', 'b'])
    expect(q.counts()).toMatchObject({ done: 2, failed: 0 })
    expect(q.jobs[0]).toMatchObject({ title: '第一条', files: [{ path: '/tmp/x/a.mp4', size: 2048 }] })
  })

  it('风控：同一平台剩下的暂停，别的平台照常；r 重试后接着下', async () => {
    let blocked = true
    const a = platform('pa', (ref) => {
      if (blocked && ref === 'a1') throw new CatbusError('RISK_CONTROL', '要人机验证', { detail: { kind: 'captcha' } })
      return []
    })
    const b = platform('pb', () => [])
    const q = new DownloadQueue(opts())
    q.add(a.p, runnableCommand(a.p, 'item download')!, [{ id: 'a1' }, { id: 'a2' }])
    q.add(b.p, runnableCommand(b.p, 'item download')!, [{ id: 'b1' }])
    await settle(q)
    expect(q.jobs.map((j) => j.state)).toEqual(['failed', 'paused', 'done'])
    expect(q.jobs[0]!.error?.code).toBe('RISK_CONTROL')
    expect(a.calls).toEqual(['a1'])
    blocked = false
    expect(q.retry()).toBe(2)
    await settle(q)
    expect(q.jobs.map((j) => j.state)).toEqual(['done', 'done', 'done'])
    expect(a.calls).toEqual(['a1', 'a1', 'a2'])
  })

  it('停止：排队中的标成暂停；清除已完成的记录', async () => {
    const { p } = platform('st', () => [])
    const q = new DownloadQueue(opts())
    q.add(p, runnableCommand(p, 'item download')!, [{ id: '1' }, { id: '2' }, { id: '3' }])
    q.stop()
    await settle(q)
    const c = q.counts()
    expect(c.paused + c.done).toBe(3)
    expect(c.paused).toBeGreaterThan(0)
    q.clearDone()
    expect(q.jobs.every((j) => j.state !== 'done')).toBe(true)
  })

  it('停止后再加的照常下载：正在下载的那条下完，接着下新加的', async () => {
    let release: () => void = () => undefined
    const gate = new Promise<void>((r) => (release = r))
    const { p, calls } = platform('sa', async (ref) => {
      if (ref === 'a') await gate
      return []
    })
    const q = new DownloadQueue(opts())
    const dl = runnableCommand(p, 'item download')!
    q.add(p, dl, [{ id: 'a' }])
    await new Promise((r) => setTimeout(r, 10))
    expect(q.jobs[0]!.state).toBe('running')
    q.stop()
    q.add(p, dl, [{ id: 'b' }])
    release()
    await settle(q)
    expect(calls).toEqual(['a', 'b'])
    expect(q.jobs.map((j) => j.state)).toEqual(['done', 'done'])
  })

  it('标题：title > text > name > id，空白压成一格', () => {
    expect(titleOf({ id: '1', text: '第一行\n第二行' })).toBe('第一行 第二行')
    expect(titleOf({ id: '1' })).toBe('1')
    expect(titleOf(null)).toBe('')
  })
})

describe('聚合搜索', () => {
  it('轮流排：前几条来自不同平台', () => {
    expect(interleave<unknown>([[1, 2, 3], ['a'], [], ['x', 'y']])).toEqual([1, 'a', 'x', 2, 'y', 3])
  })

  it('只搜有 item search 的平台；失败的写进 failures，不影响别的平台', async () => {
    const ok = platform('ok', () => [], { search: true }).p
    const none = platform('none', () => []).p
    const bad = definePlatform({
      id: 'bad',
      name: '坏平台',
      aliases: [],
      item: '帖子',
      endpoints: {
        web: {
          login: { methods: [] },
          guest: true,
          commands: {
            'item search': {
              upstream: 'full',
              auth: 'optional',
              handler: async () => async () => {
                throw new CatbusError('UPSTREAM', '接口挂了')
              },
            },
          },
        },
        app: 'planned',
        pc: 'planned',
      },
    })
    expect(searchable([ok, none, bad]).map((p) => p.id)).toEqual(['ok', 'bad'])
    const settled: string[] = []
    const r = await searchAll({ platforms: [ok, none, bad], keyword: '猫', log, account: () => undefined, onSettled: (p) => settled.push(p.id) })
    expect(r.items).toEqual([{ id: 'ok1' }, { id: 'ok2' }])
    expect(r.origins.map((o) => o.platform.id)).toEqual(['ok', 'ok'])
    expect(r.counts).toEqual({ ok: 2 })
    expect(r.failures.map((f) => [f.platform.id, f.error.code])).toEqual([['bad', 'UPSTREAM']])
    expect(settled.sort()).toEqual(['bad', 'ok'])
  })

  it('平台的搜索入口：有 item search 用它，没有时用 feed list', () => {
    const ok = platform('ok2', () => [], { search: true }).p
    const none = platform('none2', () => []).p
    expect(primaryCommand(ok)?.key).toBe('item search')
    expect(primaryCommand(none)).toBeNull()
  })
})

describe('评论的行', () => {
  const c = (id: string, replies = 0) => ({ id, text: id, stats: { likes: 1, replies } })

  it('展开的评论下面是回复，还有更多时有“更多”行；评论还有下一页时最后是“更多”', () => {
    let s = appendComments(EMPTY, { items: [c('c1', 3), c('c2')], cursor: 'p2', hasMore: true })
    expect(rows(s).map((r) => r.type)).toEqual(['comment', 'comment', 'more'])
    s = appendReplies(s, 0, { items: [c('r1'), c('r2')], cursor: 'q2', hasMore: true })
    expect(rows(s).map((r) => r.type)).toEqual(['comment', 'reply', 'reply', 'replies', 'comment', 'more'])
    s = updateThread(s, 0, (t) => ({ ...t, open: false }))
    expect(rows(s).map((r) => r.type)).toEqual(['comment', 'comment', 'more'])
    s = appendComments(s, { items: [c('c3')], cursor: null, hasMore: false })
    expect(rows(s).map((r) => r.type)).toEqual(['comment', 'comment', 'comment'])
    // 先后回来的两页不会互相覆盖：都是在当时的状态上接
    expect(s.threads.map((t) => t.comment.id)).toEqual(['c1', 'c2', 'c3'])
    expect(s.threads[0]!.replies?.map((r) => r.id)).toEqual(['r1', 'r2'])
  })
})

describe('媒体列表、摘要', () => {
  it('只要 http(s) 地址；封面单独一条，和媒体重复时不重复列', () => {
    const list = mediaOf({
      media: [
        { type: 'image', url: 'https://a/1.jpg', width: 10, height: 20 },
        { type: 'video', url: null },
        { type: 'video', url: 'javascript:alert(1)' },
      ],
      cover: 'https://a/cover.jpg',
    })
    expect(list.map((m) => [m.url, m.label])).toEqual([['https://a/1.jpg', '图片 · 10×20'], ['https://a/cover.jpg', '封面']])
    expect(mediaOf({ media: [{ type: 'image', url: 'https://a/c.jpg' }], cover: 'https://a/c.jpg' })).toHaveLength(1)
    expect(mediaOf('x')).toEqual([])
  })

  it('下载结果（File）有自己的列；大小写成人能读的单位', () => {
    const f = { path: '/tmp/a.mp4', type: 'video', url: null, size: 5 * 1024 * 1024 }
    expect(kindOf(f)).toBe('file')
    expect(columnsFor([f]).map((c) => c.head)).toEqual(['文件', '类型', '大小'])
    expect([bytes(0), bytes(1536), bytes(5 * 1024 * 1024), bytes(null), bytes(-1)]).toEqual(['0 B', '1.5 KB', '5.0 MB', '-', '-'])
  })

  it('带头像的 UserRef 仍写成“名字（id）”一行', () => {
    const lines = flatten({ author: { id: '7', name: '作者', url: 'https://u/7', avatar: 'https://a/7.jpg' } })
    expect(lines).toEqual([{ key: 'author', value: '作者（7）' }])
  })
})

describe('设置：下载目录', () => {
  it('~ 展开成主目录，相对路径相对于启动时的目录', () => {
    expect(expandDir('~')).toBe(homedir())
    expect(expandDir('~/Downloads')).toBe(`${homedir()}/Downloads`.replace(/\//g, process.platform === 'win32' ? '\\' : '/'))
      expect(expandDir('/abs/dir')).toMatch(/abs[\\/]dir$/)
    })
  })
