import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { Box, useInput } from 'ink'
import { useEffect, useRef, useState } from 'react'
import { toCatbusError } from '../core/errors.js'
import { edit, initial, splitAtCursor, type TextState } from './input.js'
import { Frame } from './screen.js'
import { readSettings, type Settings, writeSetting } from './settings.js'
import { clip, padEnd } from './text.js'
import { Row, T, useGlyphs } from './ui.js'

// 设置页（AGENTS 4.13）：代理和超时写进 config.toml（与 catbus config set 同一套校验，所有命令都生效）；
// 下载目录和主题只在这次运行里有效。

type Id = 'proxy' | 'timeout' | 'dir' | 'theme'
const ROWS: { id: Id; label: string; hint: string }[] = [
  { id: 'proxy', label: '代理', hint: '写进 config.toml 的 proxy，所有命令都用；留空表示不用代理。例如 http://127.0.0.1:7890' },
  { id: 'timeout', label: '超时（秒）', hint: '写进 config.toml 的 timeout；留空回到默认 30 秒' },
  { id: 'dir', label: '下载目录', hint: '只在这次运行里有效；默认是启动 catbus tui 时的目录。目录要已经存在' },
  { id: 'theme', label: '主题', hint: '只在这次运行里有效；固定用 CATBUS_TUI_THEME=light|dark' },
]

/** 把 ~ 和相对路径展开成绝对路径（相对于启动时的目录）。 */
export function expandDir(raw: string): string {
  const v = raw.trim()
  if (v === '~') return homedir()
  if (v.startsWith('~/')) return resolve(homedir(), v.slice(2))
  return resolve(v)
}

export function SettingsScreen({
  cols,
  rows,
  downloadDir,
  onDownloadDir,
  light,
  onToggleTheme,
  onExit,
}: {
  cols: number
  rows: number
  downloadDir: string
  onDownloadDir: (dir: string) => void
  light: boolean
  onToggleTheme: () => void
  onExit: () => void
}) {
  const g = useGlyphs()
  const [settings, setSettings] = useState<Settings | null>(null)
  const [sel, setSel] = useState(0)
  const [editing, setEditing] = useState<TextState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const alive = useRef(true)
  const reload = () =>
  readSettings().then(
    (s) => alive.current && setSettings(s),
    (e) => alive.current && setError(toCatbusError(e).message),
  )
  useEffect(() => {
    void reload()
    return () => {
      alive.current = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useEffect(() => {
    if (!note) return
    const t = setTimeout(() => setNote(null), 3000)
    return () => clearTimeout(t)
  }, [note])

  const row = ROWS[sel]!
  const valueOf = (id: Id): string => {
    if (id === 'proxy') return settings?.proxy ?? ''
    if (id === 'timeout') return settings?.timeout == null ? '' : String(settings.timeout)
    if (id === 'dir') return downloadDir
    return light ? '浅色' : '深色'
  }
  const save = async (id: Id, raw: string) => {
    try {
      if (id === 'dir') {
        const dir = expandDir(raw || '.')
        const s = await stat(dir).catch(() => null)
        if (!s?.isDirectory()) throw new Error(`目录不存在：${dir}`)
        onDownloadDir(dir)
        setNote(`下载目录：${dir}`)
      } else if (id === 'proxy' || id === 'timeout') {
        await writeSetting(id, raw)
        await reload()
        setNote(raw.trim() ? `已写入 config.toml：${id}` : `已从 config.toml 删除：${id}`)
      }
      setEditing(null)
      setError(null)
    } catch (e) {
      setError(toCatbusError(e).message)
    }
  }

  useInput((input, key) => {
    if (editing) {
      if (key.escape) {
        setEditing(null)
        setError(null)
        return
      }
      if (key.return) {
        void save(row.id, editing.value)
        return
      }
      const next = edit(editing, input, key)
      if (next) setEditing(next)
      return
    }
    if (key.escape || input === 'q') return onExit()
    if (key.upArrow || input === 'k') return setSel((n) => Math.max(0, n - 1))
    if (key.downArrow || input === 'j' || key.tab) return setSel((n) => Math.min(ROWS.length - 1, n + 1))
    if (key.return || input === ' ') {
      if (row.id === 'theme') return onToggleTheme()
      setError(null)
      setEditing(initial(valueOf(row.id)))
    }
  })

  const inner = cols - 2
  const labelW = 12
  return (
    <Frame
      cols={cols}
      rows={rows}
      title={`设置 ${g.sep} 代理、超时写进 config.toml；其余只在这次运行里有效`}
      info={row.hint}
      note={note}
      keys={editing ? [['Enter', '保存'], ['Esc', '取消']] : [['↑↓', '选择'], ['Enter', row.id === 'theme' ? '切换' : '修改'], ['Esc', '返回']]}
    >
      <Box height={1} />
      {ROWS.map((r, i) => {
        const on = i === sel
        let value: React.ReactNode
        if (on && editing) {
          const [a, c, b] = splitAtCursor(editing)
          value = (
            <>
              <T c="accent">{a}</T>
              <T bg="accent">{c === '' ? ' ' : c}</T>
              <T c="accent">{b}</T>
            </>
          )
        } else {
          const v = valueOf(r.id)
          value = v ? <T c="accent">{clip(v, inner - labelW - 4, g.more)}</T> : <T c="dim">{settings == null && r.id !== 'dir' && r.id !== 'theme' ? '读取中…' : '未设置'}</T>
        }
        return <Row key={r.id} cols={inner} selected={on} left={<>{padEnd(' ' + r.label, labelW)}{value}</>} />
      })}
      {error ? (
        <Box paddingLeft={2} paddingTop={1}>
          <T c="red">{clip(error, inner - 4, g.more)}</T>
        </Box>
      ) : null}
    </Frame>
  )
}
