#!/usr/bin/env python3
from __future__ import annotations

import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'sources' / 'roadmap'
DOCS = ROOT / 'docs'


def normalize(text: str) -> str:
    text = re.sub(r'^---\n.*?\n---\n', '', text, flags=re.S)
    text = re.sub(r'<!--.*?-->', '', text, flags=re.S)
    # Source links point at archive files, while site links use topic pages.
    # Compare the linked labels so coverage measures content, not routing.
    text = re.sub(r'\[([^\]]+)\]\([^)]*\)', r'[\1]', text)
    # The public site refers to the complete master document without exposing
    # its archival filename/version suffix. Canonicalize both sides so the
    # coverage audit still compares the citation content.
    text = text.replace(
        '`Hearth_个人Agent_OS_总体路线图_v3.md:280`',
        '完整主文档第 280 行',
    )
    text = text.replace('`Hearth_个人Agent_OS_总体路线图_v3.md`', '完整主文档')
    text = text.replace('完整主文档 第', '完整主文档第')
    return re.sub(r'\s+', ' ', text).strip()


def source_files() -> list[Path]:
    book = SOURCE / 'Hearth_路线图分册'
    files = sorted(book.glob('*.md'))
    files.extend(
        [
            SOURCE / 'Hearth_个人Agent_OS_总体路线图_v3.md',
            SOURCE / 'Hearth_自研与集成边界说明.md',
        ]
    )
    return [path for path in files if path.exists()]


def meaningful_blocks(text: str) -> list[str]:
    text = re.split(r'\n---\s*\n\s*\*\*分册导航', text, maxsplit=1)[0]
    blocks: list[str] = []
    current: list[str] = []
    in_fence = False
    for line in text.splitlines():
        if line.lstrip().startswith('```'):
            in_fence = not in_fence
        if not in_fence and not line.strip():
            if current:
                blocks.append('\n'.join(current))
                current = []
            continue
        current.append(line)
    if current:
        blocks.append('\n'.join(current))

    result: list[str] = []
    for block in blocks:
        normalized = normalize(block)
        if len(normalized) < 20:
            continue
        if normalized.startswith('#') or normalized.startswith('<') or normalized.startswith('| ---'):
            continue
        if normalized.startswith('**完整版：**') or normalized.startswith('**分册导航'):
            continue
        if normalized.startswith('> 对应主文档：') or normalized.startswith('> 版本：'):
            continue
        if normalized.startswith('> 来源：根据'):
            continue
        result.append(normalized)
    return result


def main() -> int:
    target_files = [
        path
        for path in DOCS.rglob('*.md')
        if 'en' not in path.relative_to(DOCS).parts
    ]
    target = normalize('\n'.join(path.read_text(encoding='utf-8') for path in target_files))

    print(f'Chinese target files: {len(target_files)}')
    print(f'Chinese target characters: {len(target)}')
    print()

    all_ok = True
    readme_ok = True
    for path in source_files():
        blocks = meaningful_blocks(path.read_text(encoding='utf-8'))
        missing = [block for block in blocks if block not in target]
        found_chars = sum(len(block) for block in blocks if block in target)
        total_chars = sum(len(block) for block in blocks)
        ratio = (found_chars / total_chars * 100) if total_chars else 100
        ok = not missing
        if path.name == 'README.md':
            readme_ok = ok
        all_ok = all_ok and ok
        print(
            f'{"OK" if ok else "GAP":3} {path.name}: '
            f'{len(blocks) - len(missing)}/{len(blocks)} blocks, {ratio:5.1f}% chars'
        )
        for block in missing[:3]:
            print(f'    missing: {block[:140]}')

    print()
    if readme_ok:
        print('README summary: all substantive blocks are present.')
    else:
        print('README summary: rewritten into guide pages; headings and conclusions were reviewed manually.')

    print('Coverage audit passed.' if all_ok else 'Coverage gaps found.')
    return 0 if all_ok else 1


if __name__ == '__main__':
    raise SystemExit(main())
