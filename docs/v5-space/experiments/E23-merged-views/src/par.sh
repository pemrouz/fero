#!/bin/sh
# Run the command lines read from stdin, N at a time (default 3: the brief's
# limit of three heavy jobs at once). run.sh wraps this in ONE hold of
# $SP/bin/heavy per part, so a part waits for the shared lock once, not once
# per run. Each line is a full shell command (with its own output redirect).
N=${1:-3}
exec xargs -d '\n' -P "$N" -I{} sh -c '{}'
