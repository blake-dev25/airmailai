#!/usr/bin/env bash
# List the project tree, collapsing noisy dirs into an entry count.

echo 'Project layout:'

prune=(
  -name .git -o -name .tmp -o -name playwright-report
  -o -name test-results -o -name .output -o -name .wxt
  -o -name dist -o -name node_modules
)

{
  # everything we keep (pruned dirs are not printed by this pass)
  find . \( "${prune[@]}" \) -prune -o -print

  # pruned dirs: print the dir, then a count of what's inside it
  find . \( "${prune[@]}" \) -prune -print | while read -r d; do
    n=$(find "$d" -mindepth 1 -maxdepth 1 | wc -l | tr -d ' ')
    if [ "$n" -eq 1 ]; then word=entry; else word=entries; fi
    echo "$d"
    echo "$d/... $n $word excluded"
  done
} | sort
