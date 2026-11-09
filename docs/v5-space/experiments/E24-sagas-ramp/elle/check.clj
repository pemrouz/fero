;; E-24: real Elle 0.2.8 (list-append) on the histories elle/sim.py writes.
;; Usage: java -cp "<jars>" clojure.main check.clj OUT.jsonl FILE.edn ...
;; Each file: two checks, {:consistency-models [:read-committed]} (P-15's MUST:
;; no G0, G1a, G1b, G1c, lost or doubled element) and [:serializable] (which
;; adds G-single: a reader saw part of a unit, P-15's SHOULD). One JSON line
;; per file: the verdicts and the anomaly types with their counts.
(ns e24.check
  (:require [elle.list-append :as la]
            [jepsen.history :as h]
            [clojure.edn :as edn]
            [clojure.java.io :as io]
            [clojure.data.json :as json]))

(defn summarize [r]
  (let [as (:anomalies r)]
    {:valid (let [v (:valid? r)] (if (keyword? v) (name v) v))
     :counts (into (sorted-map) (map (fn [[k v]] [(name k) (if (coll? v) (count v) 1)]) as))}))

(defn check-file [path]
  (let [ops  (edn/read-string (slurp path))
        hist (h/history ops)]
    {:file (.getName (io/file path))
     :ops  (count ops)
     :rc   (summarize (la/check {:consistency-models [:read-committed]} hist))
     :sr   (summarize (la/check {:consistency-models [:serializable]} hist))}))

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
