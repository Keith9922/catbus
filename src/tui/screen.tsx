import { Box } from 'ink'
import type { ReactNode } from 'react'
import { clip } from './text.js'
import { Keys, Pane, T, useGlyphs } from './ui.js'

// 自己处理按键的整屏页面（下载、评论、媒体、设置、聚合搜索）共用的框：上面一个 Pane，下面一行说明、一行按键。
// 页面画在顶栏下面，rows 是顶栏以下的行数。

export function Frame({
  cols,
  rows,
  title,
  info,
  note,
  keys,
  children,
}: {
  cols: number
  rows: number
  title: string
  /** 倒数第二行的说明（等价命令、下载目录等）。 */
  info: string
  /** 有提示时代替按键行显示，几秒后由页面自己清掉。 */
  note: string | null
  keys: [string, string][]
  children: ReactNode
}) {
  const g = useGlyphs()
  return (
    <Box flexDirection="column" width={cols} height={rows}>
      <Pane title={title} cols={cols} rows={rows - 2} focused>
        {children}
      </Pane>
      <Box width={cols} height={1} paddingLeft={1} overflow="hidden">
        <T c="dim">{clip(info, cols - 2, g.more)}</T>
      </Box>
      <Box width={cols} height={1} paddingLeft={1} overflow="hidden">
        {note ? <T c="green">{clip(note, cols - 2, g.more)}</T> : <Keys cols={cols - 2} items={keys} />}
      </Box>
    </Box>
  )
}
