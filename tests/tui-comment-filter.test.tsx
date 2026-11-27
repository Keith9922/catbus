import { afterEach, describe, expect, it } from 'vitest'
import { definePlatform, type HandlerContext } from '../src/core/registry.js'
import { useTempHome } from './helpers.js'
import { KEYS, type Session, start } from './tui-harness.js'

// 评论区筛选（AGENTS 4.13）：只作用于已加载的顶层评论，不发请求、不改翻页。真实的 App，假平台，不联网。

const item = { id: 'v1', kind: 'video', url: null, title: '一条帖子', text: null, author: { id: 'a1', name: '作者', url: null, avatar: null }, created_at: null, cover: null, media: [], stats: {}, price: null, status: null }
const comment = (id: string, text: string, author: string, likes: number) => ({ id, item_id: 'v1', parent_id: null, author: { id: author, name: author, url: null, avatar: null }, text, created_at: '2026-11-02T09:00:00+08:00', stats: { likes, replies: 0 } })

// 6 条（超过 COMMENT_FILTER_MIN=5），一页取完，没有下一页：筛选不会和翻页混在一起
const COMMENTS = [
  comment('c1', '这只猫真可爱', '小明', 5),
  comment('c2', '沙发', '阿狗', 20),
  comment('c3', '求链接', '小明', 1),
  comment('c4', '哈哈哈', '路人', 8),
  comment('c5', '一般', '甲', 2),
  comment('c6', '支持', '乙', 3),
]

const demo = definePlatform({
  id: 'demofilter',
  name: '演示筛选',
  aliases: [],
  item: '帖子',
  endpoints: {
    web: {
      login: { methods: [] },
      guest: true,
      commands: {
        'item get': { upstream: 'full', auth: 'optional', handler: async () => async () => item },
        'comment list': { upstream: 'full', auth: 'optional', handler: async () => async () => ({ data: COMMENTS, page: { cursor: null, has_more: false } }) },
      },
    },
    app: 'planned',
    pc: 'planned',
  },
})

describe('评论区筛选：/ 搜索、s 排序', () => {
  useTempHome()
  let s: Session | null = null
  afterEach(() => {
    s?.stop()
    s = null
  })
  const text = () => s!.screen().join('\n')
  const openComments = async () => {
    s = await start({ columns: 120, rows: 34, platforms: [demo] })
    await s.press(KEYS.enter, KEYS.down, KEYS.enter) // 进命令栏（item 组已展开）→ get → 表单
    await s.type('v1')
    await s.press(KEYS.enter)
    await s.waitForText('一条帖子')
    await s.press('m')
    await s.waitForText('求链接')
  }

  it('不足 5 条时不显示搜索和排序提示', async () => {
    const small = definePlatform({
      id: 'demofilter2',
      name: '演示筛选二',
      aliases: [],
      item: '帖子',
      endpoints: {
        web: {
          login: { methods: [] },
          guest: true,
          commands: {
            'item get': { upstream: 'full', auth: 'optional', handler: async () => async () => item },
            'comment list': { upstream: 'full', auth: 'optional', handler: async () => async () => ({ data: COMMENTS.slice(0, 4), page: { cursor: null, has_more: false } }) },
          },
        },
        app: 'planned',
        pc: 'planned',
      },
    })
    s = await start({ columns: 120, rows: 34, platforms: [small] })
    await s.press(KEYS.enter, KEYS.down, KEYS.enter)
    await s.type('v1')
    await s.press(KEYS.enter)
    await s.waitForText('一条帖子')
    await s.press('m')
    await s.waitForText('哈哈哈')
    expect(text()).not.toContain('搜索')
    expect(text()).not.toContain('排序')
  })

  it('/ 搜索：正文或昵称子串匹配，Enter 提交；c 清除', async () => {
    await openComments()
    await s!.press('/')
    await s!.type('小明')
    await s!.press(KEYS.enter)
    await s!.waitForText('找到 2 条')
    expect(text()).toContain('这只猫真可爱')
    expect(text()).toContain('求链接')
    expect(text()).not.toContain('沙发')
    await s!.press('c')
    await s!.waitForText('哈哈哈')
    expect(text()).not.toContain('找到')
  })

  it('搜索框里 Esc 放弃输入、不提交，原来的筛选不变', async () => {
    await openComments()
    await s!.press('/')
    await s!.type('沙发')
    await s!.press(KEYS.enter)
    await s!.waitForText('找到 1 条')
    await s!.press('/')
    await s!.type('改了但不提交')
    await s!.press(KEYS.esc)
    expect(text()).toContain('找到 1 条')
    expect(text()).not.toContain('改了但不提交')
  })

  it('s 排序：最热按点赞降序，再按一次是最新，再按一次回到默认', async () => {
    await openComments()
    await s!.press('s')
    await s!.waitForText('排序：最热')
    const order = () => s!.screen().filter((l) => l.includes('：') && !l.includes('排序')).map((l) => l.trim())
    // 最热：阿狗 20 排第一
    await s!.waitForText('阿狗')
    expect(order()[0]).toContain('阿狗')
    await s!.press('s')
    await s!.waitForText('排序：最新')
    await s!.press('s')
    await s!.waitForText('排序：默认')
    expect(text()).not.toContain('找到')
  })

  it('搜索和排序一起用；清除筛选（c）把两者都复位', async () => {
    await openComments()
    await s!.press('/')
    await s!.type('一般') // 只匹配「一般」这一条（c5，甲，2 赞）之外，正文含“一般”的只有它自己
    await s!.press(KEYS.enter)
    await s!.press('s')
    await s!.waitForText('找到 1 条')
    expect(text()).toContain('一般')
    await s!.press('c')
    await s!.waitForText('哈哈哈')
    expect(text()).not.toContain('找到')
    expect(text()).not.toContain('排序：最热')
  })
})
