import { Box, useInput } from 'ink'
import { useEffect, useState } from 'react'
import { copyText, openFile } from './clipboard.js'
import type { DownloadQueue, Job, JobState } from './downloads.js'
import { Frame } from './screen.js'
import { scrollTo } from './state.js'
import { bytes } from './summary.js'
import { clip, width } from './text.js'
import { type ColorName, Row, T, useGlyphs } from './ui.js'

// 下载页（AGENTS 4.13）：批量下载的进度。队列在后台跑，离开这一页也不停。

const LABEL: Record<JobState, string> = { waiting: '排队', running: '下载中', done: '完成', failed: '失败', paused: '暂停' }
const COLOR: Record<JobState, ColorName> = { waiting: 'dim', running: 'accent', done: 'green', failed: 'red', paused: 'yellow' }

/** 一条的结果：完成时写文件数和大小，失败时写错误码和原因。 */
export function jobResult(job: Job): string {
  if (job.state === 'done') {
    const total = job.files.reduce((n, f) => n + (f.size ?? 0), 0)
    return job.files.length ? `${job.files.length} 个文件 · ${bytes(total)}` : '没有新文件（已有的文件默认跳过）'
  }
  if (job.state === 'failed' && job.error) return `${job.error.code}：${job.error.message}`
  if (job.state === 'paused') return '已暂停，按 r 重试'
  return ''
}

export function DownloadsScreen({ queue, dir, cols, rows, onExit }: { queue: DownloadQueue; dir: string; cols: number; rows: number; onExit: () => void }) {
  const g = useGlyphs()
  const [, setTick] = useState(0)
  const [sel, setSel] = useState(0)
  const [top, setTop] = useState(0)
  const [note, setNote] = useState<string | null>(null)
  const [spin, setSpin] = useState(0)
  useEffect(() => queue.subscribe(() => setTick((n) => n + 1)), [queue])
  useEffect(() => {
    const t = setInterval(() => setSpin((n) => n + 1), 250)
    return () => clearInterval(t)
  }, [])
  useEffect(() => {
    if (!note) return
    const t = setTimeout(() => setNote(null), 3000)
    return () => clearTimeout(t)
  }, [note])

  const jobs = queue.jobs
  // Pane 占 rows - 2 行，去掉标题线和底边；再留 1 行给“x-y / n”，3 行给下面的详情（空一行 + 两行）
  const visible = Math.max(1, rows - 2 - 2 - 1 - 3)
  const at = Math.min(sel, Math.max(0, jobs.length - 1))
  const picked = jobs[at]
  const move = (n: number) => {
    const next = Math.max(0, Math.min(jobs.length - 1, n))
    setSel(next)
    setTop((t) => scrollTo(next, t, visible, jobs.length))
  }

  useInput((input, key) => {
    if (key.escape || input === 'q') return onExit()
    if (key.upArrow || input === 'k') return move(at - 1)
    if (key.downArrow || input === 'j') return move(at + 1)
    if (input === 'r') {
      const n = queue.retry()
      setNote(n ? `重新排队 ${n} 条` : '没有失败或暂停的')
      return
    }
    if (input === 'x') {
      queue.stop()
      setNote('排队中的已停下；正在下载的那条下完为止')
      return
    }
    if (input === 'C') {
      queue.clearDone()
      setSel(0)
      setTop(0)
      return
    }
    if (input === 'o') {
      void openFile(dir).then((ok) => setNote(ok ? '已打开下载目录' : `没能打开，请手动打开：${dir}`))
      return
    }
    if (input === 'y' && picked) {
      const text = picked.files.map((f) => f.path).join('\n') || picked.ref
      void copyText(text).then((m) => setNote(m ? '已复制' : `没能写入剪贴板：${text}`))
    }
  })

  const c = queue.counts()
  const inner = cols - 2
  const title = `下载 ${g.sep} 完成 ${c.done} · 失败 ${c.failed} · 进行中 ${c.waiting + c.running}${c.paused ? ` · 暂停 ${c.paused}` : ''}`
  const detail = picked ? (picked.files.length ? picked.files.map((f) => f.path) : [jobResult(picked) || picked.ref]) : []
  return (
    <Frame
      cols={cols}
      rows={rows}
      title={title}
      info={`下载到  ${dir}`}
      note={note}
      keys={[['↑↓', '选择'], ['r', '重试失败和暂停'], ['x', '停止'], ['o', '打开目录'], ['y', '复制路径'], ['C', '清除已完成'], ['Esc', '返回']]}
    >
      {jobs.length === 0 ? (
        <Box paddingLeft={2} paddingTop={1}>
          <T c="dim">还没有下载。在结果页按空格选几条，再按 d。</T>
        </Box>
      ) : null}
      {jobs.slice(top, top + visible).map((job, i) => {
        const icon = job.state === 'running' ? g.spin[spin % g.spin.length]! : job.state === 'done' ? g.dotOn : g.dotOff
        const status = jobResult(job)
        const room = Math.max(8, inner - 26 - width(status))
        return (
          <Row
            key={job.id}
            cols={inner}
            selected={top + i === at}
            right={LABEL[job.state]}
            rightColor={COLOR[job.state]}
            left={
              <>
                <T c={COLOR[job.state]}>{icon}</T>
                <T c="sub">{' ' + clip(job.platform.name, 8, g.more) + '  '}</T>
                <T>{clip(job.title || job.ref, room, g.more)}</T>
                <T c={job.state === 'failed' ? 'red' : 'dim'}>{status ? '  ' + status : ''}</T>
              </>
            }
          />
        )
      })}
      {jobs.length > visible ? (
        <Box paddingLeft={1}>
          <T c="dim">{`${top + 1}-${Math.min(jobs.length, top + visible)} / ${jobs.length}`}</T>
        </Box>
      ) : null}
      {detail.length ? (
        <Box flexDirection="column" paddingLeft={2} paddingTop={1}>
          {detail.slice(0, 2).map((line, i) => (
            <T key={i} c={picked?.state === 'failed' ? 'red' : 'dim'}>
              {clip(line, inner - 4, g.more)}
            </T>
          ))}
        </Box>
      ) : null}
    </Frame>
  )
}
