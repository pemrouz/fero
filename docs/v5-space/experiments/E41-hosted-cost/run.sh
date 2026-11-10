#!/bin/sh
# E-41: the cost table. No download, no timing, no lock: it is arithmetic on cited prices and measured numbers.
#   ./run.sh     writes results/tables.md, results/inputs.md and results/cost.csv, and prints the tables
cd "$(dirname "$0")" && python3 cost.py
