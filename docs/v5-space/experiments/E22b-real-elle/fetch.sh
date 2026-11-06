#!/bin/sh
# E-22b: the real Jepsen checkers, from Clojars, with Maven (the toolsmith's pom; TOOLS.md).
#   elle    0.2.8   https://repo.clojars.org/elle/elle/0.2.8/            sha1 a6dc52fca28872825e65e74ec7f51862e7bd34ab
#   knossos 0.3.16  https://repo.clojars.org/knossos/knossos/0.3.16/     sha1 b5945515932f6cca140bc0f00a114b368af15b75
#   history 0.1.9   https://repo.clojars.org/io/jepsen/history/0.1.9/    sha1 e69cbedd9bd528af6428e6df18ae57c924cbcc63
# Each sha1 is the one Clojars publishes beside the jar (checked on 2026-11-06, and again below).
# Every other jar on the classpath is pinned by its sha256 below (first seen on 2026-11-06; Maven
# Central and Clojars publish sha1 only). The Go side needs nothing new: it reuses E-22's verified
# module cache (Porcupine v1.3.1, tipocket v1.0.0; E-22's verify/fetch.sh).
set -eu
SP="${SP:-/tmp/claude-0/-home-user-fero/bac5b7a6-c95f-59b1-b9a5-8d26a3a427c5/scratchpad}"
D="$SP/dl/elle-mvn"
mkdir -p "$D/jars"
if [ ! -f "$D/jars/elle-0.2.8.jar" ]; then
  cat > "$D/pom.xml" <<'POM'
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <groupId>fero.study</groupId><artifactId>checkers</artifactId><version>1</version>
  <repositories>
    <repository><id>clojars</id><url>https://repo.clojars.org/</url></repository>
  </repositories>
  <dependencies>
    <dependency><groupId>org.clojure</groupId><artifactId>clojure</artifactId><version>1.12.0</version></dependency>
    <dependency><groupId>elle</groupId><artifactId>elle</artifactId><version>0.2.8</version></dependency>
    <dependency><groupId>knossos</groupId><artifactId>knossos</artifactId><version>0.3.16</version></dependency>
    <dependency><groupId>org.clojure</groupId><artifactId>data.json</artifactId><version>2.5.1</version></dependency>
  </dependencies>
</project>
POM
  # settings.xml (if present) gives Maven the box's HTTPS proxy
  ( cd "$D" && mvn -q ${MVN_SETTINGS:+-s "$MVN_SETTINGS"} dependency:copy-dependencies -DoutputDirectory=jars )
fi
cd "$D/jars"
for x in "elle/elle/0.2.8/elle-0.2.8.jar a6dc52fca28872825e65e74ec7f51862e7bd34ab" \
         "knossos/knossos/0.3.16/knossos-0.3.16.jar b5945515932f6cca140bc0f00a114b368af15b75" \
         "io/jepsen/history/0.1.9/history-0.1.9.jar e69cbedd9bd528af6428e6df18ae57c924cbcc63"; do
  set -- $x; f=$(basename "$1")
  have=$(sha1sum "$f" | cut -d' ' -f1)
  [ "$have" = "$2" ] || { echo "sha1 mismatch: $f $have"; exit 1; }
  pub=$(curl -sS --max-time 20 "https://repo.clojars.org/$1.sha1" || echo offline)
  [ "$pub" = "$2" ] || [ "$pub" = offline ] || { echo "Clojars publishes $pub for $f, expected $2"; exit 1; }
  echo "ok $f sha1 $have (Clojars: $pub)"
done
sha256sum -c <<'SUMS'
839f750f7a7bfcae6af0a96a016382097da23b879a3dd95ea7c1bdbd0c0c508f  algo.generic-0.1.2.jar
f3e70c94a784db4921c8652c4336c01c8c0740e0ab278ba7699f6a800dc5e08b  analemma-1.0.0.jar
605a47b4a83572bd00f2602510d21758288bf50150ffbffc2f2e6a5f84542fc1  bifurcan-0.2.0-rc4.jar
c045a14f39011e40b08fa89601afc6fc978c9f50eb8f090daf1870695d1e5107  bifurcan-clj-0.1.6.jar
c45333006441a059ea9fdb1341fc6c1f40b921a10dccd82665311e48a0384763  clojure-1.12.0.jar
51f98eba7b2cd42ee30f3826925dcde8791167f76f712329ae51b88244e8138e  core.rrb-vector-0.1.2.jar
eb73ac08cf49ba840c88ba67beef11336ca554333d9408808d78946e0feb9ddb  core.specs.alpha-0.4.74.jar
7e4233f6ac79c76c0e3d880253e28a744890fa8be07bf2ac4ccd216ac2e0fd96  data.generators-1.1.1.jar
6da57351e334173c85dea1696c7d4847a4f3e11dbaeb397da65e7a26849e94b3  data.json-2.5.1.jar
d21401fbf7c5d4d1e59b1ac22093c7c708146a263f535b87cfd6074f55ba6633  dom-top-1.0.11.jar
2f4f2a3b5c3964e01149d4b46f2550ed18d45512ab5a31f1cc881f37d9f4739c  elle-0.2.8.jar
db6789a035c013ce11a991eb3818882d68d47fa6a9eee4627b2e0d9e1bef05f2  fipp-0.6.29.jar
3a212e61c3dd6a8c8c9a975279aacbb5b703a96f7f6daf7064e02e5ab7aacdac  generator-0.1.6.jar
568051bbc23cd955e84af39ce8e614404c166542c6942d1d6f64ba55bd72053a  hiccup-2.0.0.jar
e529306290e184905443f2b190853fb0e6ce158d15e8eadba7cc8b22af52a650  high-scale-lib-1.0.6.jar
acf2e2a3c70593447d1c3bdef225f8675cf9105ea04ce07b70dd32e3cf2e9270  history-0.1.9.jar
b83aaf7242e0845df37eecafbc8bc68f5223b8ced775573206200b1063815747  interval-metrics-1.0.1.jar
cef71a591cbb7d7d3df29cc332bb03930cc18802104f7441d551aeb36f510b1b  jepsen.txn-0.1.3.jar
7f0afc6fd813b9343dec74c9abea87e2eb196666fd71aaccba99c345465ce05b  knossos-0.3.16.jar
06cc5b1312ef9d056aca8aaa014d4ad71d30da88163dcc3a18dc84736d22b0b0  math.combinatorics-0.3.2.jar
0f1a967693584c6e9a125ed6952fa84ab5c7cb6cb288d86fce23574d4ba68465  multiset-0.1.1.jar
53da97f00b44bb934af4ce92dc800d31e4a548a449de129fd4a74f2ef679963a  potemkin-0.4.9.jar
a6678d83735ae9b082636ab0668871fcf47ff24250920700b67a356363e57441  primitive-math-1.0.1.jar
82482d9417a33ff101a55cb196dec5329d5880ef3dc6606f543bfe2b5f052149  rhizome-0.2.9.jar
c38dbfa82e0decfd406185db0f881c383705f1fc1ed6b011a61c78c3d016b679  riddley-0.2.2.jar
a68ac22bf2ea3cd54ce34db70fd69844d631ef549f6450c278c30e6f79df63f3  slingshot-0.12.2.jar
d9af7f726da31666add5d286091c604233590f4f1384ecc8de396aa8b2c77159  slingshot-0.13.0.jar
94cd99b6ea639641f37af4860a643b6ed399ee5a8be5d717cff0b663c8d75077  spec.alpha-0.5.238.jar
07d21835e60ba74566ad137ddbc275d5159ec1bfced4863cc41d0343fbab6bfd  tesser.core-1.0.10.jar
2a2d1769aa5ced5aa40e92c8ff568ea2751398b0ea45520308774ec2317abcee  tools.cli-1.4.256.jar
13fb97ea2472056ea0660d4f8e88b4f66486c2cfff380b82859ab3cd33592935  tools.logging-1.3.1.jar
SUMS
