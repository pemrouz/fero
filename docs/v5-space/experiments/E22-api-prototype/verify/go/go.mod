module e22check

go 1.24

require (
	github.com/anishathalye/porcupine v1.3.1
	github.com/pingcap/tipocket v1.0.0
)

require (
	github.com/BurntSushi/toml v0.3.1 // indirect
	github.com/juju/errors v1.0.0 // indirect
	github.com/kr/pretty v0.3.1 // indirect
	github.com/ngaut/log v0.0.0-20180314031856-b8e36e7ba5ac // indirect
	go.uber.org/atomic v1.5.0 // indirect
	go.uber.org/multierr v1.3.0 // indirect
	go.uber.org/tools v0.0.0-20190618225709-2cfd321de3ee // indirect
	go.uber.org/zap v1.14.0 // indirect
	golang.org/x/lint v0.0.0-20190930215403-16217165b5de // indirect
	golang.org/x/tools v0.0.0-20191029190741-b9c20aec41a5 // indirect
	gopkg.in/yaml.v2 v2.4.0 // indirect
	honnef.co/go/tools v0.0.1-2019.2.3 // indirect
)

// tipocket's whole module pulls Kubernetes, TiDB and chaos-mesh; only its pkg/elle (the Go port of
// Elle) is used. fetch.sh copies pkg/elle/{core,txn,list_append} out of the verified module zip,
// without two files nothing calls (list_append/viz.go: graphviz plotting; txn/wr_txn.go: a random
// history generator), into ./tipocket-elle beside this file in the build folder.
replace github.com/pingcap/tipocket => ./tipocket-elle
