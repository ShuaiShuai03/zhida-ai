#!/usr/bin/env python3

from pathlib import Path
import re
import sys


ROOT = Path(__file__).resolve().parent.parent
DOC_FILES = sorted(
    path for path in ROOT.rglob("*.md")
    if ".git/" not in path.as_posix()
)
LINK_RE = re.compile(r"\[[^\]]+\]\(([^)]+)\)")
FORBIDDEN_PATTERNS = (
    "../../issues",
    "../../actions/",
    "../../security/",
    "your-username",
)


def is_external(target: str) -> bool:
    return (
        target.startswith("http://")
        or target.startswith("https://")
        or target.startswith("mailto:")
        or target.startswith("#")
    )


def main() -> int:
  errors = []

  for path in DOC_FILES:
    text = path.read_text(encoding="utf-8")

    for pattern in FORBIDDEN_PATTERNS:
      if pattern in text:
        errors.append(f"{path.relative_to(ROOT)}: forbidden placeholder/pattern: {pattern}")

    for target in LINK_RE.findall(text):
      if is_external(target):
        continue

      relative_target = target.split("#", 1)[0]
      if not relative_target:
        continue

      resolved = (path.parent / relative_target).resolve()
      if not resolved.exists():
        errors.append(
          f"{path.relative_to(ROOT)}: broken relative link target: {target}"
        )

  if errors:
    print("Markdown validation failed:")
    for error in errors:
      print(f"- {error}")
    return 1

  print(f"Validated {len(DOC_FILES)} Markdown files.")
  return 0


if __name__ == "__main__":
  sys.exit(main())
