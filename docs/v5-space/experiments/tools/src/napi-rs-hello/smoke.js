const m = require(process.argv[2]);
const b = Buffer.alloc(4096, 1);
console.log('ok napi-rs', process.version, m.hello(), m.sum(2, 3), m.byteSum(b));
