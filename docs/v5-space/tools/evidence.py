#!/usr/bin/env python3
"""Build EVIDENCE.md: every experiment's closing answer line(s), plus an index from
each requirement id to the experiments whose answer names it. Run from docs/v5-space:
    python3 tools/evidence.py
The text is copied from each experiments/E*/README.md; nothing is rewritten."""
import glob, os, re

REQ = re.compile(r'\b(?:PERF|DATA|TEST|DEV|DEP|OPS|SC|P|F)-\d+\b')
AREAS = ['P', 'PERF', 'SC', 'F', 'DEV', 'DEP', 'TEST', 'DATA', 'OPS']

def eid(folder):
    m = re.match(r'E(\d+)([a-z]?\d?)', folder)
    return 'E-%d%s' % (int(m.group(1)), m.group(2))

def answers(text):
    paras = [p.strip() for p in re.split(r'\n\s*\n', text) if p.strip()]
    hits = [p for p in paras if re.match(r'^[>*\s`_-]*Q-\d+', p)]
    with_moves = [p for p in hits if 'Moves' in p]
    return with_moves or hits[-1:]

rows, index = [], {}
for d in sorted(glob.glob('experiments/E*/')):
    folder = d.rstrip('/').split('/')[-1]
    readme = d + 'README.md'
    if not os.path.exists(readme):
        continue
    text = open(readme).read()
    title = next((l.lstrip('# ').strip() for l in text.splitlines() if l.startswith('#')), folder)
    ans = answers(text)
    rows.append((eid(folder), folder, title, ans))
    for a in ans:
        for r in set(REQ.findall(a)):
            index.setdefault(r, []).append(eid(folder))

def key(r):
    a, n = r.rsplit('-', 1)
    return (AREAS.index(a), int(n))

out = ['# The evidence ledger: what each experiment answered', '',
       'One entry per experiment: its closing answer, copied word for word from its README. '
       'The line says what was found, then which candidates it moves up or down, on which requirement. '
       'Built by `python3 tools/evidence.py`; edit the READMEs, never this file. '
       'Candidates are the rows of [SPACE.md](SPACE.md) §4; requirement ids are in [REQUIREMENTS.md](REQUIREMENTS.md); '
       'questions are in [QUESTIONS.md](QUESTIONS.md).', '',
       '## 1. Answers', '']
for e, folder, title, ans in rows:
    out.append('### %s: %s' % (e, title))
    out.append('')
    out.append('Folder: [experiments/%s](experiments/%s/README.md)' % (folder, folder))
    out.append('')
    for a in ans:
        out.append(a)
        out.append('')
out += ['## 2. Which experiments name each requirement', '',
        'A requirement is listed when an answer line above names it. A requirement that is missing here '
        'has no experiment that moves a candidate on it.', '',
        '| Requirement | Experiments |', '|---|---|']
for r in sorted(index, key=key):
    out.append('| %s | %s |' % (r, ', '.join(dict.fromkeys(index[r]))))
open('EVIDENCE.md', 'w').write('\n'.join(out) + '\n')
print('experiments:', len(rows), ' requirements named:', len(index), ' bytes:', os.path.getsize('EVIDENCE.md'))
