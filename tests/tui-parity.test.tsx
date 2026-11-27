import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { newCredential, setCurrent, writeCredential } from '../src/core/auth-store.js'
import { CatbusError } from '../src/core/errors.js'
import { definePlatform, type HandlerContext } from '../src/core/registry.js'
import { useTempHome } from './helpers.js'
import { KEYS, type Session, start } from './tui-harness.js'

// 和网页界面对齐的几项（AGENTS 4.13）：下载、评论、媒体、本次浏览账号、设置、搜索入口与回到结果、聚合搜索。
// 真实的 App，假平台（不联网）；下载写到临时目录。

const seen: { key: string; account: string | null; options: Record<string, unknown> }[] = []
const record = (ctx: HandlerContext) => seen.push({ key: `${ctx.resource} ${ctx.action}`, account: ctx.account, options: { ...ctx.options } })

const user = (id: string) => ({ id, name: `作者${id}`, url: `https://demo.example/u/${id}`, avatar: null })
const item = (id: string, title: string) => ({
  id,
  kind: 'video',
  url: `https://demo.example/v/${id}`,
  title,
  text: `${title}的正文`,
  author: user('a' + id),
  created_at: '2026-11-01T10:00:00+08:00',
  cover: `https://cdn.demo.example/${id}.jpg`,
  media: [{ id: 'm' + id, type: 'video', url: `https://cdn.demo.example/${id}.mp4`, width: 1920, height: 1080, duration: 61 }],
  stats: { views: 1200, likes: 34, comments: 3, collects: 1, shares: 0 },
  price: null,
  status: null,
})
const comment = (id: string, text: string, replies: number) => ({ id, item_id: 'v1', parent_id: null, author: user('c' + id), text, created_at: '2026-11-02T09:00:00+08:00', stats: { likes: 7, replies } })

/** 能下载、能看评论和媒体的平台多出来的几条命令。 */
function mediaCommands(id: string) {
  return {
    'item download': {
      upstream: 'full' as const,
      auth: 'optional' as const,
      handler: async () => async (ctx: HandlerContext) => {
        record(ctx)
        const path = join(String(ctx.options.dir), `${id}_${ctx.args.item}.mp4`)
        writeFileSync(path, 'fake video')
        return [{ path, type: 'video', url: null, size: 10 }]
      },
    },
    'item media': {
      upstream: 'full' as const,
      auth: 'optional' as const,
      handler: async () => async (ctx: HandlerContext) => {
        record(ctx)
        return [{ id: 'hd', type: 'video', url: `https://cdn.demo.example/${ctx.args.item}-hd.mp4`, width: 3840, height: 2160, duration: 61 }]
      },
    },
    'comment list': {
      upstream: 'full' as const,
      auth: 'optional' as const,
      handler: async () => async (ctx: HandlerContext) => {
        record(ctx)
        if (ctx.cursor === 'p2') return { data: [comment('c3', '第三条评论，在第二页', 0)], page: { cursor: null, has_more: false } }
        return { data: [comment('c1', '第一条评论', 2), comment('c2', '第二条评论', 0)], page: { cursor: 'p2', has_more: true } }
      },
    },
    'comment replies': {
      upstream: 'full' as const,
      auth: 'optional' as const,
      handler: async () => async (ctx: HandlerContext) => {
        record(ctx)
        return { data: [comment('r1', '楼中楼一', 0), comment('r2', '楼中楼二', 0)], page: { cursor: null, has_more: false } }
      },
    },
  }
}

function demo(id: string, name: string, opts: { download?: boolean; fail?: string } = {}) {
  return definePlatform({
    id,
    name,
    aliases: [],
    item: '视频',
    endpoints: {
      web: {
        login: { methods: [] },
        guest: true,
        commands: {
          'item search': {
            upstream: 'full',
            auth: 'optional',
            handler: async () => async (ctx: HandlerContext) => {
              record(ctx)
              if (opts.fail) throw new CatbusError(opts.fail as 'RISK_CONTROL', '需要人机验证', { detail: { kind: 'captcha' } })
              return { data: [item(`${id}-1`, `${name}的第一条`), item(`${id}-2`, `${name}的第二条`)], page: { cursor: null, has_more: false } }
            },
          },
          ...(opts.download ? mediaCommands(id) : undefined),
        },
      },
      app: 'planned',
      pc: 'planned',
    },
  })
}

/** 搜索结果分两页：第一页 6 条，滚到末尾附近时自动取第二页。 */
const paged = definePlatform({
  id: 'demop',
  name: '演示翻页',
  aliases: [],
  item: '视频',
  endpoints: {
    web: {
      login: { methods: [] },
      guest: true,
      commands: {
        'item search': {
          upstream: 'full',
          auth: 'optional',
          handler: async () => async (ctx: HandlerContext) => {
            const page = ctx.cursor === 'p2' ? 2 : 1
            const data = Array.from({ length: 6 }, (_, i) => item(`p${page}-${i}`, `第 ${page} 页第 ${i + 1} 条`))
            return { data, page: page === 1 ? { cursor: 'p2', has_more: true } : { cursor: null, has_more: false } }
          },
        },
      },
    },
    app: 'planned',
    pc: 'planned',
  },
})

const A = demo('demoa', '演示甲', { download: true })
const B = demo('demob', '演示乙')
const C = demo('democ', '演示丙', { fail: 'RISK_CONTROL' })

describe('tui：和网页界面对齐的功能', () => {
  useTempHome()
  let s: Session | null = null
  let dir = ''
  beforeEach(() => {
    seen.length = 0
    dir = mkdtempSync(join(tmpdir(), 'catbus-tui-dl-'))
    // 下载目录默认是启动时的目录：测试里换成临时目录，不往仓库里写文件
    vi.spyOn(process, 'cwd').mockReturnValue(dir)
  })
  afterEach(() => {
    s?.stop()
    s = null
    vi.restoreAllMocks()
    rmSync(dir, { recursive: true, force: true })
  })
  const text = () => s!.screen().join('\n')
  const open = async (platforms = [A, B, C]) => (s = await start({ columns: 120, rows: 34, platforms }))
  /** 按 s 打开搜索，输入关键词运行，等结果出来。 */
  const search = async (kw: string) => {
    await s!.press('s')
    await s!.type(kw)
    await s!.press(KEYS.enter)
    await s!.waitForText('的第一条')
  }

  it('s 直达本平台的搜索；r 回到上一次的结果', async () => {
    await open()
    await search('猫')
    expect(seen.at(-1)).toMatchObject({ key: 'item search' })
    expect(text()).toContain('演示甲的第二条')
    await s!.press(KEYS.down)
    // Esc 回到搜索表单（可以换个关键词再搜）；再 Esc 回到命令栏，r 回到上一次的结果
    await s!.press(KEYS.esc)
    expect(text()).not.toContain('演示甲的第一条')
    await s!.press(KEYS.esc, 'r')
    expect(text()).toContain('演示甲的第一条')
  })

  it('下载：空格选几条，d 打开选项面板，默认选项下再按 d 开始下载，D 看进度；文件写到下载目录', async () => {
    await open()
    await search('猫')
    await s!.press(' ', ' ')
    expect(text()).toContain('已选 2')
    await s!.press('d')
    await s!.waitForText('下载选项')
    expect(text()).toContain('2 条')
    await s!.press('d')
    await s!.waitForText('已加入下载 2 条')
    await s!.press('D')
    await s!.waitForText('完成 2')
    expect(text()).toContain('1 个文件')
    expect(existsSync(join(dir, 'demoa_demoa-1.mp4'))).toBe(true)
    expect(existsSync(join(dir, 'demoa_demoa-2.mp4'))).toBe(true)
    expect(seen.filter((x) => x.key === 'item download').map((x) => x.options.dir)).toEqual([dir, dir])
    // 默认选项：没有多余的 meta/comments/replies/noMedia
    for (const x of seen.filter((x) => x.key === 'item download')) {
      expect(x.options).not.toHaveProperty('meta')
      expect(x.options).not.toHaveProperty('comments')
    }
    await s!.press(KEYS.esc)
    expect(text()).toContain('演示甲的第一条')
  })

  it('下载选项：勾选“只要信息”、填“导出评论”后开始，传给 item download；Esc 取消不会加入队列', async () => {
    await open()
    await search('猫')
    await s!.press(' ')
    await s!.press('d')
    await s!.waitForText('下载选项')
    await s!.press(KEYS.esc) // 先验证取消
    expect(text()).toContain('演示甲的第一条')
    expect(seen.some((x) => x.key === 'item download')).toBe(false)
    await s!.press('d')
    await s!.waitForText('下载选项')
    await s!.press(KEYS.down, KEYS.down) // 到“导出评论”（第 3 行：只要信息、写信息、导出评论）
    await s!.press(KEYS.enter)
    await s!.type('20')
    await s!.press(KEYS.enter)
    await s!.press('d')
    await s!.waitForText('已加入下载 1 条')
    await s!.press('D')
    await s!.waitForText('完成 1')
    const job = seen.find((x) => x.key === 'item download')!
    // comments 隐含 meta
    expect(job.options).toMatchObject({ meta: true, comments: '20' })
  })

  it('下载选项：评论条数不是正整数或 all 时报错，不会开始下载', async () => {
    await open()
    await search('猫')
    await s!.press('d')
    await s!.waitForText('下载选项')
    await s!.press(KEYS.down, KEYS.down)
    await s!.press(KEYS.enter)
    await s!.type('不是数字')
    await s!.press(KEYS.enter)
    await s!.press('d')
    await s!.waitForText('只能是正整数或 all')
    expect(seen.some((x) => x.key === 'item download')).toBe(false)
  })

  it('多选在翻页后还在：滚到末尾附近自动取下一页，已选的不清掉', async () => {
    await open([paged])
    await s!.press('s')
    await s!.type('猫')
    await s!.press(KEYS.enter)
    await s!.waitForText('第 1 页第 1 条')
    await s!.press(' ')
    expect(text()).toContain('已选 1')
    for (let i = 0; i < 4; i++) await s!.press(KEYS.down)
    await s!.waitForText('第 2 页第 1 条')
    expect(text()).toContain('已选 1')
    expect(text()).toContain('· 12 · 已选 1')
  })

  it('不能下载的平台：给出提示，不加入队列', async () => {
    await open([B])
    await search('猫')
    await s!.press('d')
    await s!.waitForText('不能在界面里下载')
    expect(seen.some((x) => x.key === 'item download')).toBe(false)
  })

  it('评论：m 打开评论，Enter 展开楼中楼，翻到底取下一页', async () => {
    await open()
    await search('猫')
    await s!.press('m')
    await s!.waitForText('第一条评论')
    expect(text()).toContain('回复 2')
    await s!.press(KEYS.enter)
    await s!.waitForText('楼中楼二')
    expect(seen.find((x) => x.key === 'comment replies')).toBeTruthy()
    // 往下翻到底：自动取第二页
    for (let i = 0; i < 5; i++) await s!.press(KEYS.down)
    await s!.waitForText('第三条评论，在第二页')
    await s!.press(KEYS.esc)
    expect(text()).toContain('演示甲的第一条')
  })

  it('媒体：i 列出图片和视频地址（含 item media 取到的）', async () => {
    await open()
    await search('猫')
    await s!.press('i')
    await s!.waitForText('demoa-1-hd.mp4')
    expect(text()).toContain('视频 · 3840×2160 · 61 秒')
    expect(text()).toContain('封面')
  })

  it('聚合搜索：一个关键词同时搜几个平台，结果标出平台，失败的平台写在下面', async () => {
    await open()
    await s!.press('A')
    expect(text()).toContain('聚合搜索')
    await s!.type('狗')
    await s!.press(KEYS.enter)
    await s!.waitForText('演示乙的第一条')
    const t = text()
    expect(t).toContain('演示甲的第一条')
    expect(t).toContain('平台')
    expect(t).toContain('失败：演示丙 RISK_CONTROL')
    // 轮流排：第二条来自第二个平台
    const lines = s!.screen().filter((l) => l.includes('的第一条') || l.includes('的第二条'))
    expect(lines[0]).toContain('演示甲')
    expect(lines[1]).toContain('演示乙')
    // 等价命令按选中这一条的平台写
    expect(t).toContain('catbus demoa item search 狗')
    await s!.press(KEYS.down)
    expect(text()).toContain('catbus demob item search 狗')
  })

  it('本次浏览账号：账号页按 b，之后的命令带 -a，不改当前账号', async () => {
    for (const a of ['one', 'two']) {
      const c = newCredential({ platform: 'demoa', endpoint: 'web', account: a, method: 'cookie' })
      c.user = { id: 'u-' + a, name: '用户' + a, url: null, avatar: null }
      await writeCredential(c)
    }
    await setCurrent('demoa', 'web', 'one')
    await open()
    await s!.press('a')
    await s!.waitForText('用户two')
    await s!.press(KEYS.down, 'b')
    expect(text()).toContain('本次浏览用 two')
    await s!.press(KEYS.esc)
    expect(text()).toContain('two（本次）')
    await search('猫')
    expect(seen.at(-1)).toMatchObject({ key: 'item search', account: 'two' })
    const { getCurrent } = await import('../src/core/auth-store.js')
    expect(await getCurrent('demoa', 'web')).toBe('one')
  })

  it('设置：代理写进 config.toml（同一套校验），下载目录只在这次运行里生效', async () => {
    const home = process.env.CATBUS_HOME!
    await open()
    await s!.press('S')
    await s!.waitForText('代理')
    await s!.press(KEYS.enter)
    await s!.type('not-a-proxy')
    await s!.press(KEYS.enter)
    await s!.waitForText('代理')
    expect(existsSync(join(home, 'config.toml'))).toBe(false)
    // 清掉输入，换成合法的
    for (let i = 0; i < 12; i++) await s!.press(KEYS.backspace)
    await s!.type('http://127.0.0.1:7890')
    await s!.press(KEYS.enter)
    await s!.waitForText('已写入 config.toml')
    expect(readFileSync(join(home, 'config.toml'), 'utf8')).toContain('proxy = "http://127.0.0.1:7890"')
    // 下载目录：不存在的目录不接受
    await s!.press(KEYS.down, KEYS.down, KEYS.enter)
    for (let i = 0; i < 80; i++) await s!.press(KEYS.backspace)
    await s!.type(join(dir, 'nope'))
    await s!.press(KEYS.enter)
    await s!.waitForText('目录不存在')
  })
})

