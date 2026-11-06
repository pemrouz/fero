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
(ns e22b.elle-check
  (:require [elle.list-append :as la]
            [jepsen.history :as h]
            [clojure.edn :as edn]
            [clojure.java.io :as io]
            [clojure.data.json :as json]))

(defn read-ops [file]
  (with-open [r (java.io.PushbackReader. (io/reader file))]
    (doall (take-while some? (repeatedly #(edn/read {:eof nil} r))))))

(defn invoke-of [op]
  (assoc op :type :invoke
         :value (mapv (fn [[f k v]] (if (= f :r) [f k nil] [f k v])) (:value op))))

(defn paired
  "Each completion becomes [invoke, completion], adjacent, in file order."
  [ops]
  (vec (mapcat (fn [op] [(assoc (invoke-of op) :f :txn) (assoc op :f :txn)]) ops)))

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
