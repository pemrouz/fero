;; E-22b: real Elle 0.2.8 (jepsen-io/elle, Clojure) on E-22's saved list-append histories.
;;
;; Usage: java -cp "$SP/dl/elle-mvn/jars/*" clojure.main elle_check.clj <out.jsonl> <file.edn> ...
;;
;; E-22 wrote one EDN file per seed with completions only ({:type :ok|:fail|:info, :value [...],
;; :process p}): the Go port it used (pingcap/tipocket pkg/elle) accepts that. Real Elle builds a
;; jepsen.history, which pairs each completion with an :invoke of the same process and throws
;; ::double-complete on a second completion with no invoke. So this script adds, just before each
;; completion, an :invoke of the same process with the same transaction (reads with a nil value),
;; and :f :txn on both. That is the only change. With the two models E-22 used (:read-committed
;; and :serializable) Elle uses no realtime or process edges, so where the invokes sit cannot
;; change a verdict.
;;
;; For each file: two checks, as E-22 ran the port: {:consistency-models [:read-committed]} and
;; {:consistency-models [:serializable]}. One JSON line per file.
;;
;; E22B_RULE=port (an ablation, to test a root cause): Elle 0.2.8 places an append that no read
;; ever saw just after the last element any read saw on that key, and draws ww and rw edges from
;; that. The Go port (tipocket v1.0.0, list_append/utils.go previouslyAppendElement) draws no edge
;; for such an append. With E22B_RULE=port this script swaps Elle's function for the port's rule:
;; an unseen append has no known predecessor. Nothing else changes.
(ns e22b.elle-check
  (:require [elle.list-append :as la]
            [jepsen.history :as h]
            [clojure.edn :as edn]
            [clojure.java.io :as io]
            [clojure.data.json :as json]
            [e22b.pairing :refer [read-ops paired]]))

(when (= "port" (System/getenv "E22B_RULE"))
  (alter-var-root #'la/previously-appended-element
                  (fn [orig]
                    (fn [append-index write-index op [f k v :as mop]]
                      (when (some? (get-in append-index [k :indices v]))
                        (orig append-index write-index op mop))))))

(defn summarize [r]
  (let [as (:anomalies r)]
    {:valid (let [v (:valid? r)] (if (keyword? v) (name v) v))
     :types (mapv name (sort (keys as)))
     :counts (into (sorted-map) (map (fn [[k v]] [(name k) (count v)]) as))
     :not (some->> (:not r) (map name) sort vec)}))

(defn check-file [path]
  (let [ops  (read-ops path)
        hist (h/history (paired ops))
        t0   (System/nanoTime)
        rc   (la/check {:consistency-models [:read-committed]} hist)
        sr   (la/check {:consistency-models [:serializable]} hist)
        ms   (/ (- (System/nanoTime) t0) 1e6)]
    {:file (.getName (io/file path))
     :ops  (count ops)
     :rc   (summarize rc)
     :sr   (summarize sr)
     :ms   (Math/round (double ms))}))

(defn -main [out & files]
  (with-open [w (io/writer out)]
    (doseq [f files]
      (let [res (try (check-file f)
                     (catch Throwable e
                       {:file (.getName (io/file f)) :error (str (class e) ": " (.getMessage e))}))]
        (.write w (json/write-str res))
        (.write w "\n")
        (.flush w))))
  (shutdown-agents)
  (System/exit 0))

(apply -main *command-line-args*)
