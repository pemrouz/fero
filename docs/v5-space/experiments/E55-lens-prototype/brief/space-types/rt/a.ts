import type { shop } from './server.ts'; type S = typeof shop; const x: S['name'] = 'shop'; console.log('a: import type {shop} ->', x)
