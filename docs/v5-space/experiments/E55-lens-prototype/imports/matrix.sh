#!/bin/sh
# Claim 24: four ways to import a server's type, under Node's type stripping, tsc with and without
# verbatimModuleSyntax, and esbuild (a bundler) with and without it. Prints one JSON line per cell.
cd "$(dirname "$0")"
NODE=${NODE:-node}
TSC=${TSC:-tsc}
: "${ESBUILD:?set ESBUILD to the esbuild binary (run.sh sets it from SP)}"
: "${OUT:?set OUT to a scratch folder for the bundles (run.sh sets it from SP)}"
mkdir -p "$OUT"
for f in a-type-Shop b-plain-Shop c-type-shop d-plain-shop; do
  node_out=$($NODE --experimental-strip-types --no-warnings $f.ts 2>&1 | tr '\n"' '  ' | cut -c1-160)
  node_ran=$(echo "$node_out" | grep -c 'SERVER MODULE RAN')
  for cfg in vms plain; do
    tsc_err=$(printf '{"extends":"./tsconfig.%s.json","files":["%s.ts"]}' $cfg $f > "$OUT/t.json"; cp "$OUT/t.json" ./_t.json; $TSC -p _t.json 2>&1 | grep -o 'error TS[0-9]*' | sort -u | tr '\n' ' '; rm -f _t.json)
    tsflag=""; [ $cfg = vms ] && tsflag="--tsconfig=tsconfig.vms.json" || tsflag="--tsconfig=tsconfig.plain.json"
    eb=$($ESBUILD $f.ts --bundle --format=esm --platform=node $tsflag --outfile="$OUT/$f.$cfg.js" 2>&1 | grep -o 'ERROR[^"]*' | head -1 | tr '"' ' ' | cut -c1-120)
    shipped=0; [ -f "$OUT/$f.$cfg.js" ] && shipped=$(grep -c 'SERVER MODULE RAN' "$OUT/$f.$cfg.js")
    [ -n "$eb" ] && shipped=error
    printf '{"exp":"E-55","claim":24,"client":"%s","config":"%s","node":"%s","nodeRanServer":%s,"nodeOutput":"%s","tscErrors":"%s","esbuildShipsServer":"%s","esbuildError":"%s"}\n' "$f" "$cfg" "$($NODE --version)" "$node_ran" "$node_out" "$tsc_err" "$shipped" "$eb"
    rm -f "$OUT/$f.$cfg.js"
  done
done
