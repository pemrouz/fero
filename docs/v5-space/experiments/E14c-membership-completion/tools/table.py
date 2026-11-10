#!/usr/bin/env python3
"""table.py: results/tables.md from results/runs.json (steps 1 and 3),
results/bugs.json (step 2), results/r19.json (step 4) and the cross-check
files results/partial-*.json (step 3)."""
import glob
import json
import os

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
R = os.path.join(HERE, 'results')
SKIP = ('AllowDrop', 'AllowStepDown', 'LeaderLease', 'ProgressAbove', 'NoConfAfterFault', 'Canon', 'StopAtGoal')


def load(n):
    p = os.path.join(R, n)
    return json.load(open(p)) if os.path.exists(p) else {}


def fmt(x):
    return '{:,}'.format(x) if isinstance(x, int) else ('' if x is None else str(x))


def model(n, r):
    """Which model a run used: the full one (MCferoc.tla), or the bounds of
    MCferoq.tla (1 to 4) and MCferoz.tla (5 and 6), or MCferog.tla (grow first)."""
    kw = r['kw']
    mod = r.get('module') or ('MCferog' if n.endswith('-g') else 'MCferoz' if n.endswith('-z')
                              else 'MCferoq' if 'ProgressAbove' in kw else 'MCferoc')
    if mod == 'MCferoc':
        return 'full'
    b = ['1']
    if kw.get('NoConfAfterFault'):
        b.append('2')
    if kw.get('Canon'):
        b.append('3')
    if kw.get('StopAtGoal'):
        b.append('4')
    if mod in ('MCferoz', 'MCferog'):
        b += ['5', '6']
    s = 'bounds ' + ('1 to %s' % b[-1] if len(b) > 2 and b == [str(k) for k in range(1, len(b) + 1)] else '+'.join(b))
    return s + (', grow first' if mod == 'MCferog' else '')


def main():
    out = ['# E-14c tables (made by tools/table.py)', '']
    runs = load('runs.json')
    out += ['## Runs (steps 1 and 3)', '',
            '"model": full is MCferoc.tla as E-14b bounded it; "bounds" are MCferoq.tla\'s (1 to 4) and '
            'MCferoz.tla\'s (5 and 6), which apply only above the judged term; "grow first" is MCferog.tla\'s '
            'healing-order rule. "plan" is E-14b\'s plan goal; where the model has the budget flag, it is judged where the '
            'change budget still allows the plan, and the last column counts the states where the leader had spent it.', '',
            '| run | scenario | model | settings | segments | wall s | distinct | depth | finished | violated | '
            'AG EF | stuck with a live majority (judged) | plan | plan: cannot finish (judged) | budget spent (not judged) |',
            '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|']
    for n in sorted(runs):
        r = runs[n]
        a = r.get('agef') or {}
        kw = ', '.join('%s=%s' % (k, v) for k, v in sorted(r['kw'].items()) if k not in SKIP)
        fin = 'yes' if r.get('complete') else ('no' + (': ' + r['error'] if r.get('error') else ''))
        if 'plan_open_judged' in a:
            pl = '%s (%s)' % (fmt(a.get('plan_open_stuck')), fmt(a.get('plan_open_judged')))
            sp = fmt(a.get('plan_spent'))
        elif 'plan_judged' in a:
            pl = '%s (%s)' % (fmt(a.get('plan_stuck')), fmt(a.get('plan_judged')))
            sp = ''
        else:
            pl = sp = ''
        out.append('| %s | %s | %s | %s | %s | %s | %s | %s | %s | %s | %s | %s | %s | %s | %s |' % (
            n, r['scen'], model(n, r), kw, r.get('segments'), fmt(r.get('secs')), fmt(r.get('distinct')),
            fmt(r.get('depth')), fin, r.get('violated') or '', a.get('result', ''),
            ('%s (%s)' % (fmt(a.get('stuck_live')), fmt(a.get('judged')))) if a else '', a.get('plan_result', ''), pl, sp))
    ps = sorted(glob.glob(os.path.join(R, 'partial-*.json')))
    if ps:
        out += ['', '## The reduced runs against the full runs\' part-graphs (tools/partial.py)', '',
                '| reduced run (finished) | full run (part-graph) | states in both | with a flag different | '
                'judged states of the full run missing in the reduced | reduced steps out of states the full run '
                'expanded | of which the full run lacks | judged with a live majority: not shown to reach a working '
                'leader, reduced alone | in the union |',
                '|---|---|---|---|---|---|---|---|---|']
        for p in ps:
            x = json.load(open(p))
            out.append('| %s (%s) | %s (%s) | %s | %s | %s | %s | %s | %s | %s |' % (
                x['small'], fmt(x['small_states']), x['big'], fmt(x['big_states']), fmt(x['common_states']),
                fmt(x['common_flags_differ']), fmt(x['judged_big_not_in_small']), fmt(x['small_steps_from_expanded']),
                fmt(x['small_steps_not_in_big']), fmt(x['small']['not_shown']), fmt(x['union']['not_shown'])))
    r19 = load('r19.json')
    if r19:
        out += ['', '## r19 (step 4)', '', 'rule: `%s`; mutant: `%s`' % (r19.get('rule'), r19.get('mutant_line')), '',
                '| run | distinct | finished | violated | judged at term | AG EF | stuck with a live majority (judged) | plan |',
                '|---|---|---|---|---|---|---|---|']
        for n in sorted(k for k in r19 if isinstance(r19[k], dict)):
            r = r19[n]
            out.append('| %s | %s | %s | %s | %s | %s | %s | %s |' % (
                n, fmt(r.get('distinct')), 'yes' if r.get('complete') else 'no', r.get('violated') or '',
                r.get('agef_judge'), r.get('agef_result'),
                '%s (%s)' % (fmt(r.get('agef_stuck_live')), fmt(r.get('agef_judged'))), r.get('agef_plan_result')))
    b = os.path.join(R, 'bugs.md')
    if os.path.exists(b):
        out += ['', '## Bugs (step 2)', ''] + open(b).read().splitlines()[2:]
    open(os.path.join(R, 'tables.md'), 'w').write('\n'.join(out) + '\n')
    print('\n'.join(out))


if __name__ == '__main__':
    main()
