#!/usr/bin/env bash
# *** Print the project tree with noisy directories collapsed

echo 'Project layout:'

prune=(
  -name .git -o -name .tmp -o -name playwright-report
  -o -name test-results -o -name .output -o -name .wxt
  -o -name dist -o -name node_modules -o -name static
  -o -name tests -o -name .historical
)

{
  find . \( "${prune[@]}" \) -prune -o -print

  find . \( "${prune[@]}" \) -prune -print | while read -r d; do
    n=$(find "$d" -mindepth 1 -maxdepth 1 | wc -l | tr -d ' ')
    if [ "$n" -eq 1 ]; then word=entry; else word=entries; fi
    echo "$d"
    echo "$d/... $n $word excluded"
  done
} | sort
