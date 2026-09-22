import { fero } from '../../api/index.ts'

// every shape fero refuses at fero() time, one line each: an async rejection, never a sync throw
for (const [name, opts] of [
    ['static', { rendezvous: false }],
    ['static', { listen: false, hosts: ['127.0.0.1:4801'] }],
    ['static', { server: true, hosts: ['10.0.0.5:4801'], rendezvous: false }],
    ['static', { server: false, listen: '127.0.0.1:4801' }],
    ['static', { listen: '0.0.0.0:3376' }],
    ['#static', { listen: false }],
    ['static', { listen: false, update() {} }],
] as const) await fero(name, opts).then(() => console.log('accepted?'), (e) => console.log('refused:', e.message.replace(/^fero\(.*?\): /, '').split(' — ')[0]))
