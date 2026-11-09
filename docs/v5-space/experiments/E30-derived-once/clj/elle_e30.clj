;; E-30: real Elle 0.2.8 (jepsen-io/elle) on the derived-output histories that
;; elle_hist.py writes. Each file holds invoke and completion ops in order
;; ({:type :invoke|:ok|:info, :f :txn, :value [...], :process p}).
;;
;; Usage: java -cp "clj:$SP/dl/elle-mvn/jars/*" clojure.main clj/elle_e30.clj <out.jsonl> <file.edn> ...
;;
;; One JSON line per file: Elle's verdict and anomaly types at read-committed
;; (Elle reports :duplicate-elements, a read that holds one append twice, at
;; every consistency model) and at serializable.
(ns e30.elle
  (:require [elle.list-append :as la]
            [jepsen.history :as h]
            [clojure.edn :as edn]
            [clojure.java.io :as io]
            [clojure.data.json :as json]))

(defn read-ops [file]
  (with-open [r (java.io.PushbackReader. (io/reader file))]
    (doall (take-while some? (repeatedly #(edn/read {:eof nil} r))))))

(defn summarize [r]
  (let [as (:anomalies r)]
    {:valid (let [v (:valid? r)] (if (keyword? v) (name v) v))
     :types (mapv name (sort (keys as)))}))

(defn check-file [path]
  (let [ops  (read-ops path)
        hist (h/history ops)
        rc   (la/check {:consistency-models [:read-committed]} hist)
        sr   (la/check {:consistency-models [:serializable]} hist)]
    {:file (.getName (io/file path)) :ops (count ops) :rc (summarize rc) :sr (summarize sr)}))

(defn -main [out & files]
  (with-open [w (io/writer out)]
    (doseq [f files]
      (let [res (try (check-file f)
                     (catch Throwable e {:file (.getName (io/file f)) :error (str (class e) ": " (.getMessage e))}))]
        (.write w (json/write-str res))
        (.write w "\n")
        (.flush w))))
  (shutdown-agents)
  (System/exit 0))

(apply -main *command-line-args*)
