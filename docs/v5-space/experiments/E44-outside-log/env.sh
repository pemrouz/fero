# E-44: where things are. Source this, with HERE set to this folder (fetch.sh and run.sh do).
SP=${SP:-/tmp/fero-sp}
export E44_NPM=$SP/e44/npm E44_DATA=${DATA:-$(cd "$HERE/../../../../.." && pwd)/data}
export E44_SERVERS=127.0.0.1:14431,127.0.0.1:14432,127.0.0.1:14433
NODE="node --experimental-strip-types --no-warnings"
