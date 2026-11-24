#!/bin/sh
# Negative control: proves that the datadriven check can fail.
#
# It copies the test files, corrupts ONE expected line in each of three
# files, and runs the same binary on the copy. The run must fail exactly
# those three files, on top of whatever fails on the clean files.
#
#   sh negative-control.sh
#   FILES="quorum/joint_vote.txt confchange/zero.txt campaign.txt" sh negative-control.sh
#
# FILES names three files under the testdata directory. WORK is the scratch
# directory (default ./target/work). The binary is read from CARGO_TARGET_DIR
# when it is set. Ends with "ok negative-control: ...".
set -eu

root=$(cd "$(dirname "$0")/../../.." && pwd)
WORK=${WORK:-$root/target/work}
FILES=${FILES:-"quorum/majority_commit.txt confchange/joint_safety.txt campaign.txt"}
src=$root/crates/raft/testdata
dst=$WORK/negative-control
bin=${CARGO_TARGET_DIR:-$root/target}/release/raft-datadriven

fail() {
    echo "FAIL negative-control: $1" >&2
    exit 1
}

set -- $FILES
[ $# -eq 3 ] || fail "FILES must name three files"

(cd "$root" && cargo build -q --release -p raft-harness --bin raft-datadriven)

rm -rf "$dst"
mkdir -p "$dst"
cp -R "$src/." "$dst/"

# The name the runner prints: files at the top are the interaction suite.
shown() {
    case $1 in
        */*) echo "$1" ;;
        *) echo "interaction/$1" ;;
    esac
}

# Corrupt the first line of the first non-empty expected block.
: > "$dst/.want"
for f in "$@"; do
    [ -f "$dst/$f" ] || fail "no such file: $f"
    awk '
        done == 0 && prev == "----" && $0 != "" && $0 != "----" { print $0 " CORRUPTED"; done = 1; prev = $0; next }
        { print; prev = $0 }
        END { if (done == 0) exit 3 }
    ' "$src/$f" > "$dst/$f" || fail "found no expected line to corrupt in $f"
    cmp -s "$src/$f" "$dst/$f" && fail "$f was not changed"
    [ "$(diff "$src/$f" "$dst/$f" | grep -c '^>')" = 1 ] || fail "$f: more than one line changed"
    shown "$f" >> "$dst/.want"
done
sort -o "$dst/.want" "$dst/.want"

failing() {
    # The names on the runner's "FAIL <file> at ..." lines.
    "$bin" --testdata "$1" | sed -n 's/^FAIL \([^ ]*\) at .*/\1/p' | sort
}

failing "$src" > "$dst/.clean" || true
failing "$dst" > "$dst/.dirty" || true

# The corrupted files must pass when clean, or the control proves nothing.
if [ -n "$(comm -12 "$dst/.want" "$dst/.clean")" ]; then
    fail "a chosen file already fails on the clean files: $(comm -12 "$dst/.want" "$dst/.clean" | tr '\n' ' ')"
fi
# New failures = failing on the copy, but not on the clean files.
comm -13 "$dst/.clean" "$dst/.dirty" > "$dst/.new"
if ! cmp -s "$dst/.want" "$dst/.new"; then
    echo "corrupted:    $(tr '\n' ' ' < "$dst/.want")" >&2
    echo "new failures: $(tr '\n' ' ' < "$dst/.new")" >&2
    fail "the new failures are not exactly the corrupted files"
fi
# Nothing that failed before may pass now.
[ -z "$(comm -23 "$dst/.clean" "$dst/.dirty")" ] || fail "a file that fails on the clean files passes on the copy"

"$bin" --testdata "$dst" | grep -F -f "$dst/.want" | grep '^FAIL' || true
echo "ok negative-control: 3 corrupted files, 3 new failures: $(tr '\n' ' ' < "$dst/.want")"
