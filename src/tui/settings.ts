import { getConfig, setConfig, unsetConfig } from '../core/config.js'

// 设置页（AGENTS 4.13）：代理、超时写进 config.toml，与 `catbus config set proxy|timeout` 同一套校验；
// 下载目录只在这次运行里有效（config.toml 只有 AGENTS 5.5 列出的几项，不往里加界面自己的东西）。

export type SettingKey = 'proxy' | 'timeout'

export interface Settings {
  proxy: string | null
  timeout: number | null
}

export async function readSettings(): Promise<Settings> {
  const proxy = await getConfig(['proxy'])
  const timeout = await getConfig(['timeout'])
  return { proxy: typeof proxy === 'string' ? proxy : null, timeout: typeof timeout === 'number' ? timeout : null }
}

/** 写一项：空字符串表示删除（回到默认值）。校验不过时抛 USAGE，配置文件不变。 */
export async function writeSetting(key: SettingKey, raw: string): Promise<void> {
  const value = raw.trim()
  if (value === '') await unsetConfig([key])
  else await setConfig([key], value)
}
