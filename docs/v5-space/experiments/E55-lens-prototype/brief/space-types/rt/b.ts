import { shop } from './server.ts'; type S = typeof shop; const x: S['name'] = 'shop'; console.log('b: plain import {shop}, used as a type only ->', x)
