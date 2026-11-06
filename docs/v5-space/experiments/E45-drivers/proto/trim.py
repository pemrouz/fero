# trim.py RPC_PROTO KV_PROTO > etcd-subset.proto
# Keeps the services and messages E-45's etcd front serves, verbatim (same names and field numbers),
# without gogoproto and google.api options, so @grpc/proto-loader can load it with no other files.
import re, sys
rpc = open(sys.argv[1]).read()
kv = open(sys.argv[2]).read()
KEEP_MSG = ['ResponseHeader', 'RangeRequest', 'RangeResponse', 'PutRequest', 'PutResponse', 'DeleteRangeRequest',
            'DeleteRangeResponse', 'RequestOp', 'ResponseOp', 'Compare', 'TxnRequest', 'TxnResponse',
            'WatchRequest', 'WatchCreateRequest', 'WatchCancelRequest', 'WatchProgressRequest', 'WatchResponse',
            'LeaseGrantRequest', 'LeaseGrantResponse', 'LeaseRevokeRequest', 'LeaseRevokeResponse',
            'LeaseKeepAliveRequest', 'LeaseKeepAliveResponse', 'LeaseTimeToLiveRequest', 'LeaseTimeToLiveResponse',
            'StatusRequest', 'StatusResponse', 'CompactionRequest', 'CompactionResponse',
            'MemberListRequest', 'MemberListResponse', 'Member']
KEEP_RPC = {'KV': ['Range', 'Put', 'DeleteRange', 'Txn', 'Compact'], 'Watch': ['Watch'],
            'Lease': ['LeaseGrant', 'LeaseRevoke', 'LeaseKeepAlive', 'LeaseTimeToLive'], 'Maintenance': ['Status'], 'Cluster': ['MemberList']}

def blocks(text, kind):
    out = {}
    for m in re.finditer(r'^%s (\w+)\s*\{' % kind, text, re.M):
        i, depth = m.end(), 1
        while depth:
            depth += {'{': 1, '}': -1}.get(text[i], 0); i += 1
        out[m.group(1)] = text[m.start():i]
    return out

def clean(b):
    b = re.sub(r'\s*\[\(gogoproto[^\]]*\]', '', b)
    b = re.sub(r'^\s*option \([^;]*;\s*$', '', b, flags=re.M)
    b = re.sub(r'^\s*//.*$', '', b, flags=re.M)
    b = re.sub(r'\n\s*\n+', '\n', b)
    return b

msgs = blocks(rpc, 'message')
svcs = blocks(rpc, 'service')
print('// Derived by proto/trim.py from etcd v3.5.17 api/etcdserverpb/rpc.proto and api/mvccpb/kv.proto')
print('// (Apache-2.0, go.etcd.io/etcd/api/v3@v3.5.17): the same package, names and field numbers.')
print('syntax = "proto3";\npackage etcdserverpb;\n')
for s, rpcs in KEEP_RPC.items():
    print('service %s {' % s)
    for r in rpcs:
        m = re.search(r'rpc %s\(([^)]*)\) returns \(([^)]*)\)' % r, svcs[s])
        print('  rpc %s(%s) returns (%s) {}' % (r, m.group(1), m.group(2)))
    print('}')
for n in KEEP_MSG:
    print(clean(msgs[n]).replace('mvccpb.', ''))
kvm = blocks(kv, 'message')
for n in ['KeyValue', 'Event']:
    print(clean(kvm[n]))
