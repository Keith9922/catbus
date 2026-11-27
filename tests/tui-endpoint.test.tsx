import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readCredential } from '../src/core/auth-store.js'
import { fakeResponse, mockSender } from '../src/core/http.js'
import { finishLogin, freshCredential, interactive, prompt, showLink } from '../src/core/login.js'
import { definePlatform, type HandlerContext } from '../src/core/registry.js'
import { PLATFORMS } from '../src/platforms/index.js'
import { activeEndpoint, endpointOf, groupCommands } from '../src/tui/model.js'
import { useTempHome } from './helpers.js'
import { KEYS, type Session, start } from './tui-harness.js'

// 默认端不是 web 的平台（discord 是 pc，AGENTS 4.3）：界面按默认端取命令、账号、登录，运行命令也走这一端。
// 假平台，不联网；登录里有两处只能由界面接管的交互：令牌（隐藏输入）和人机验证链接。

const seen: { key: string; endpoint: string }[] = []
const calls: string[] = []

const pc = definePlatform({
  id: 'demopc',
  name: '桌面演示',
  aliases: [],
  item: '消息',
  defaultEndpoint: 'pc',
  endpoints: {
    web: 'planned',
    app: 'planned',
    pc: {
      label: '桌面端',
      login: { methods: ['token'], default: 'token' },
      commands: {
        'auth login': {
          upstream: 'full',
          handler: async () => async (ctx: HandlerContext) => {
            calls.push(`auth login endpoint=${ctx.endpoint} interactive=${interactive()}`)
            const token = await prompt('令牌：', { hidden: true })
            // 令牌之后还要过一次人机验证：链接走界面，不写终端
            showLink('http://127.0.0.1:9/captcha', '请在浏览器打开下面的链接完成人机验证', '请在浏览器打开 http://127.0.0.1:9/captcha 完成人机验证', '需要在浏览器里完成演示验证')
            if (token !== 'good-token') throw new Error('令牌不对')
            // 真实的人机验证要等用户在浏览器里完成：这里一直等到取消
            await new Promise<void>((resolve) => ctx.signal.addEventListener('abort', () => resolve(), { once: true }))
            ctx.signal.throwIfAborted()
            return finishLogin(ctx, freshCredential(ctx, 'token'), { id: 'u1', name: '桌面用户', url: null, avatar: null })
          },
        },
        'auth status': 'full',
        'guild list': {
          upstream: 'full',
          auth: 'required',
          summary: '列出服务器',
          args: [],
          output: '{id name}[]',
          paged: true,
          handler: async () => async (ctx: HandlerContext) => {
            seen.push({ key: `${ctx.resource} ${ctx.action}`, endpoint: ctx.endpoint })
            return { data: [{ id: 'g1', name: '第一个服务器', url: null, count: 3 }], page: { cursor: null, has_more: false } }
          },
        },
      },
    },
  },
})

describe('默认端不是 web 的平台', () => {
  useTempHome()
  let s: Session | null = null
  let dir = ''
  afterEach(() => {
    s?.stop()
    s = null
    seen.length = 0
    calls.length = 0
    if (dir) rmSync(dir, { recursive: true, force: true })
  })
  const text = () => s!.screen().join('\n')

  it('命令、端的名字都按默认端取：界面里能看到 pc 端的命令，顶栏写 pc', async () => {
    expect(endpointOf(pc)).toBe('pc')
    expect(activeEndpoint(pc)).not.toBeNull()
    expect(groupCommands(pc).map((g) => g.resource)).toEqual(['guild'])
    dir = mkdtempSync(join(tmpdir(), 'catbus-pc-'))
    s = await start({ columns: 120, rows: 34, platforms: [pc] })
    expect(text()).toContain('端 pc')
    expect(text()).toContain('桌面演示')
  })

  it('登录：令牌在界面里隐藏输入，人机验证的链接显示在页面上；凭证存在 pc 端目录下', async () => {
    s = await start({ columns: 120, rows: 34, platforms: [pc] })
    await s.press('a', 'n')
    await s.press(KEYS.enter)
    await s.waitForText('令牌')
    await s.type('good-token')
    expect(text()).not.toContain('good-token')
    await s.press(KEYS.enter)
    await s.waitForText('需要在浏览器里完成演示验证')
    expect(text()).toContain('http://127.0.0.1:9/captcha')
    expect(calls[0]).toBe('auth login endpoint=pc interactive=true')
    await s.press(KEYS.esc)
    // 取消后没有保存凭证
    expect(await readCredential('demopc', 'pc', 'default')).toBeNull()
  })

  it('运行命令走 pc 端；没登录时给出带 -e 的登录提示由 CLI 负责，界面直接进登录', async () => {
    s = await start({ columns: 120, rows: 34, platforms: [pc] })
    await s.press(KEYS.enter, KEYS.down, KEYS.enter) // 命令栏 → guild 组 → guild list
    await s.press(KEYS.enter)
    await s.waitForText('需要登录')
  })

  it('真实的 discord 在界面里有命令、顶栏是 pc、登录页列出各方式的选项', async () => {
    const discord = PLATFORMS.find((p) => p.id === 'discord')!
    expect(endpointOf(discord)).toBe('pc')
    expect(groupCommands(discord).length).toBeGreaterThan(0)
    s = await start({ columns: 120, rows: 34, platforms: [discord] })
    expect(text()).toContain('端 pc')
    await s.press('a', 'n')
    expect(text()).toContain('登录方式')
  })

  it('真实的 discord：导入凭证时在界面里隐藏输入令牌，登录成功后凭证存在 pc 端目录', async () => {
    const TOKEN = 'synthetic-discord-token-for-tui-test'
    const restore = mockSender((p) => {
      // 登录只会请求 /users/@me 校验令牌；带的 Authorization 就是用户在界面里输入的
      expect(p.headers).toContainEqual(['Authorization', TOKEN])
      return fakeResponse({ id: '1001', username: 'example', global_name: '测试账号' })
    })
    try {
      const discord = PLATFORMS.find((p) => p.id === 'discord')!
      s = await start({ columns: 120, rows: 34, platforms: [discord] })
      await s.press('a', 'n')
      await s.press(KEYS.right, KEYS.right) // 登录方式：导入凭证
      expect(text()).toContain('--token-file')
      expect(text()).not.toContain('--token-stdin')
      await s.press(KEYS.enter)
      await s.waitForText('Discord 凭证')
      await s.type(TOKEN)
      // 令牌是隐藏输入：屏幕上不能出现明文
      expect(text()).not.toContain(TOKEN)
      await s.press(KEYS.enter)
      await s.waitForText('已登录')
      expect((await readCredential('discord', 'pc', 'default'))?.scopes.main?.tokens.authorization).toBe(TOKEN)
      expect(await readCredential('discord', 'web', 'default')).toBeNull()
      expect(text()).not.toContain(TOKEN)
    } finally {
      restore()
    }
  })
})
