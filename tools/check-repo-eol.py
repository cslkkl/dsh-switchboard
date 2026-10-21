#!/usr/bin/env python3
"""仓库换行守卫：确认仓库里存的是 LF，工作区副本也是 LF。

为什么要单独一个脚本：

`check-line-endings.py` 查的是**工作区文件**的换行是否一致，但这个仓库的
`.gitattributes` 写的是 `* text=auto eol=lf` —— 仓库里存的必须是 LF，检出一律
按 LF 写出。两件事要分开看：

- **仓库 blob**：git 提交进去的内容。必须是 LF，否则 Linux 上 clone 下来
  整文件都是 CRLF，别人改一行就是满屏 diff。
- **工作区副本**：本机的文件。Windows 上被 PowerShell 的 `WriteAllLines`、
  `Set-Content` 之类写过就会变成 CRLF，与仓库不一致 —— `git status` 会报 M
  但 `git diff` 是空的（内容一样，只有换行符不同），很难看出问题。

本脚本直接读 git 对象的原始字节判定，不走 PowerShell 之类的文本管道 ——
那些管道会做换行转换，测出来的结果是假的。

用法：
    python tools/check-repo-eol.py            # 查工作区与仓库
    python tools/check-repo-eol.py --fix      # 把工作区副本转成 LF
    python tools/check-repo-eol.py --ci       # CI 模式：工作区副本不匹配即失败

退出码：0 = 干净；1 = 有问题（--ci 或默认模式）；--fix 修复成功返回 0。
"""

from __future__ import annotations

import argparse
import os
import subprocess
import sys

TEXT_EXTS = {
    ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx",
    ".md", ".json", ".yml", ".yaml", ".py", ".txt", ".css", ".html",
}
TEXT_NAMES = {".gitignore", ".gitattributes", ".node-version", ".editorconfig"}
SKIP_DIRS = {".git", "node_modules", "research", "__pycache__", ".venv", "venv"}


def is_text_file(name: str) -> bool:
    if name in TEXT_NAMES:
        return True
    _, ext = os.path.splitext(name)
    return ext.lower() in TEXT_EXTS


def git(args: list[str]) -> bytes:
    return subprocess.check_output(["git", *args])


def tracked_files() -> list[str]:
    raw = git(["ls-tree", "-r", "--name-only", "HEAD"]).decode("utf-8", "replace")
    return [line for line in raw.splitlines() if line and is_text_file(line)]


def count_eol(data: bytes) -> tuple[int, int]:
    """返回 (CRLF 数, 纯 LF 数)。"""
    crlf = data.count(b"\r\n")
    lf = data.count(b"\n") - crlf
    return crlf, lf


def check_blobs(files: list[str]) -> list[str]:
    """仓库里存的 blob 必须是 LF。"""
    bad = []
    for name in files:
        data = git(["cat-file", "blob", f"HEAD:{name}"])
        crlf, _ = count_eol(data)
        if crlf:
            bad.append(f"  仓库 blob 含 CRLF: {name} ({crlf} 处)")
    return bad


def check_worktree(files: list[str]) -> list[str]:
    """工作区副本必须与仓库一致（也就是 LF）。"""
    bad = []
    for name in files:
        if not os.path.isfile(name):
            continue
        with open(name, "rb") as handle:
            data = handle.read()
        crlf, _ = count_eol(data)
        if crlf:
            bad.append(f"  工作区副本含 CRLF: {name} ({crlf} 处)")
    return bad


def fix_worktree(files: list[str]) -> int:
    """把工作区副本转成 LF。内容不变，只换换行符。"""
    changed = 0
    for name in files:
        if not os.path.isfile(name):
            continue
        with open(name, "rb") as handle:
            data = handle.read()
        if b"\r\n" not in data:
            continue
        fixed = data.replace(b"\r\n", b"\n")
        with open(name, "wb") as handle:
            handle.write(fixed)
        print(f"  已转成 LF: {name}")
        changed += 1
    return changed


def main() -> int:
    parser = argparse.ArgumentParser(description="仓库换行守卫")
    parser.add_argument("--fix", action="store_true", help="把工作区副本转成 LF")
    parser.add_argument("--ci", action="store_true", help="CI 模式：只报不改")
    args = parser.parse_args()

    try:
        files = tracked_files()
    except subprocess.CalledProcessError:
        print("  不是 git 仓库，跳过")
        return 0

    if not files:
        print("  没有受检的文本文件")
        return 0

    if args.fix:
        count = fix_worktree(files)
        if count == 0:
            print("  工作区副本本来就是 LF，无需处理")
        # 修完再验一遍仓库侧，仓库本身的问题 --fix 修不了。
        bad = check_blobs(files)
        if bad:
            print("仓库侧仍有问题：")
            for line in bad:
                print(line)
            return 1
        print("  仓库 blob 全部 LF")
        return 0

    bad = check_blobs(files) + check_worktree(files)
    if not bad:
        print(f"  {len(files)} 个文本文件：仓库与工作区都是 LF")
        return 0

    print("发现换行问题：")
    for line in bad:
        print(line)
    if args.ci:
        print("CI 模式：修不了，请本地跑 `python tools/check-repo-eol.py --fix`")
    else:
        print("修复：python tools/check-repo-eol.py --fix")
    return 1


if __name__ == "__main__":
    sys.exit(main())
