import { shop } from './server.ts'; const x: (typeof shop)['name'] = 'shop'; console.log('client ran', x)
