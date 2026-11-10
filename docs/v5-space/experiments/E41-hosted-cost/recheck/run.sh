#!/bin/sh
# E-41 price re-check of 2026-11-10: the same cost.py with Fly's exact page rates, a 730-hour month,
# and the Fly-to-Tigris upload billed. Each script imports ../cost.py by path and never writes its tables.
cd "$(dirname "$0")" && python3 recheck.py ../cost.py > results/recheck.md \
  && python3 floors.py ../cost.py > results/floors.md && python3 regions.py ../cost.py > results/regions.md
