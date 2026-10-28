#!/usr/bin/env python3
"""catbus tui 的伪终端冒烟测试（AGENTS 7.5）：在真实的 pty 里启动界面、进出备用屏幕、按键、退出。

只用标准库，POSIX 专用（Windows 没有 pty 模块）。由 scripts/smoke.mjs 在有 python3 的 POSIX 系统上调用。
用法：python3 scripts/smoke-tui.py <catbus 命令或 js 入口...>
成功时退出码 0，并在 stdout 打印每一项检查；任何一项失败退出码 1。
"""
import fcntl, os, pty, re, select, signal, struct, sys, tempfile, termios, time

CMD = sys.argv[1:] or ["catbus"]
ANSI = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)")


def session(cols, rows, steps):
    """在 pty 里跑 `catbus tui`，依次执行 steps，返回 (输出, 是否已退出, 退出状态)。"""
    home = tempfile.mkdtemp(prefix="catbus-smoke-tui-")
    pid, fd = pty.fork()
    if pid == 0:
        env = dict(os.environ, TERM="xterm-256color", COLORTERM="truecolor", CATBUS_HOME=home, CATBUS_TUI_ANIMATE="0")
        os.execvpe(CMD[0], CMD + ["tui"], env)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
    buf = b""

    def drain(seconds):
        nonlocal buf
        end = time.time() + seconds
        while time.time() < end:
            r, _, _ = select.select([fd], [], [], 0.1)
            if not r:
                continue
            try:
                data = os.read(fd, 65536)
            except OSError:
                return
            if not data:
                return
            buf += data

    drain(2.5)  # 冷启动（加载 Ink、React、Yoga）在慢机器上要几秒
    for step in steps:
        if step[0] == "send":
            os.write(fd, step[1].encode())
        elif step[0] == "resize":
            fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", step[2], step[1], 0, 0))
            os.kill(pid, signal.SIGWINCH)
        drain(0.7)
    drain(0.5)
    done, status = os.waitpid(pid, os.WNOHANG)
    exited = done != 0
    if not exited:
        os.kill(pid, signal.SIGKILL)
        os.waitpid(pid, 0)
    return buf.decode("utf8", "replace"), exited, status


failed = 0


def check(name, ok, detail=""):
    global failed
    print(("ok    " if ok else "FAIL  ") + name + (("：" + detail) if detail else ""))
    if not ok:
        failed += 1


def plain(text):
    return ANSI.sub("", text)


out, exited, status = session(100, 30, [("send", "q")])
text = plain(out)
check("进入备用屏幕", "\x1b[?1049h" in out)
check("画出首页", "平台" in text and "小红书" in text and "12306" in text, "平台栏 / 命令栏")
check("q 退出，退出码 0", exited and os.WEXITSTATUS(status) == 0 if exited else False, f"exited={exited} status={status}")
check("退出时离开备用屏幕、恢复光标", "\x1b[?1049l" in out and "\x1b[?25h" in out)

out, exited, status = session(100, 30, [("send", "/"), ("send", "12306"), ("send", "\x1b"), ("send", "\x03")])
text = plain(out)
check("命令面板", "命令面板" in text and "12306 ticket search" in text)
check("Ctrl-C 退出", exited)

out, exited, status = session(120, 34, [("resize", 60, 15), ("resize", 120, 34), ("send", "q")])
text = plain(out)
check("窗口缩小提示放大，放大后恢复", "终端太小了" in text and text.rfind("平台") > text.rfind("终端太小了"))

sys.exit(1 if failed else 0)
