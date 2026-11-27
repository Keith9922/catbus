import { afterEach, describe, expect, it } from 'vitest'
import { CatbusError } from '../src/core/errors.js'
import { definePlatform, type HandlerContext } from '../src/core/registry.js'
import { useTempHome } from './helpers.js'
import { KEYS, type Session, start } from './tui-harness.js'

// 风控错误带的网页验证链接（AGENTS 6.4 的 detail.verify_url 约定，与网页界面的 VerifyDialog.vue 一致）：
// 错误页显示链接，按 o 用系统浏览器打开。假平台，不联网。

const risky = definePlatform({
  id: 'demorisk',
  name: '演示风控',
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
            throw new CatbusError('RISK_CONTROL', '需要人机验证', { detail: { kind: 'captcha', verify_url: 'https://verify.example.com/x?token=abc' } })
          },
        },
      },
    },
    app: 'planned',
    pc: 'planned',
  },
})

describe('风控错误带的验证链接', () => {
  useTempHome()
  let s: Session | null = null
  afterEach(() => {
    s?.stop()
    s = null
  })
  const text = () => s!.screen().join('\n')

  it('错误页显示 detail.verify_url，按 o 打开（这里只能验证不报错，真实打开浏览器不在测试里跑）', async () => {
    s = await start({ columns: 120, rows: 34, platforms: [risky] })
    await s.press('s')
    await s.type('猫')
    await s.press(KEYS.enter)
    await s.waitForText('触发风控')
    expect(text()).toContain('去验证')
    expect(text()).toContain('https://verify.example.com/x?token=abc')
    expect(text()).toContain('浏览器打开')
  })

  it('没有 verify_url 时不显示“去验证”，也不出现浏览器打开的按键', async () => {
    const quiet = definePlatform({
      id: 'demorisk3',
      name: '演示风控三',
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
                throw new CatbusError('RISK_CONTROL', '需要验证，没有给出链接', {})
              },
            },
          },
        },
        app: 'planned',
        pc: 'planned',
      },
    })
    s = await start({ columns: 120, rows: 34, platforms: [quiet] })
    await s.press('s')
    await s.type('猫')
    await s.press(KEYS.enter)
    await s.waitForText('触发风控')
    expect(text()).not.toContain('去验证')
    expect(text()).not.toContain('浏览器打开')
  })

  it('非 https 的 verify_url 不显示（避免把任意字符串交给系统打开命令）', async () => {
    const bad = definePlatform({
      id: 'demorisk2',
      name: '演示风控二',
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
                throw new CatbusError('RISK_CONTROL', '需要验证', { detail: { verify_url: 'javascript:alert(1)' } })
              },
            },
          },
        },
        app: 'planned',
        pc: 'planned',
      },
    })
    s = await start({ columns: 120, rows: 34, platforms: [bad] })
    await s.press('s')
    await s.type('猫')
    await s.press(KEYS.enter)
    await s.waitForText('触发风控')
    expect(text()).not.toContain('去验证')
    expect(text()).not.toContain('javascript:')
  })
})
