;; E-22b: print real Elle's full explanation of the cycles it finds in one history, to root-cause
;; a disagreement with the Go port. Usage: ... clojure.main elle_explain.clj <model> <file.edn>
;; (the same pairing of invokes as elle_check.clj; E22B_RULE=port as there).
(ns e22b.elle-explain
  (:require [elle.list-append :as la]
            [jepsen.history :as h]
            [clojure.edn :as edn]
            [clojure.java.io :as io]
            [clojure.pprint :refer [pprint]]
            [e22b.pairing :as pairing]))

(pairing/port-rule-if-asked!)

(let [[model file] *command-line-args*
      ops (pairing/read-ops file)
      r (la/check {:consistency-models [(keyword model)]} (h/history (pairing/paired ops)))]
  (println "valid?" (:valid? r) "types" (:anomaly-types r))
  (doseq [[t as] (:anomalies r)
          a (take 3 as)]
    (println "----" t)
    (if (:steps a)
      (do (println (:cycle-explanation a "") ) (println "cycle:") (doseq [op (:cycle a)] (println " " (select-keys op [:index :type :process :value]))) (println "steps:") (pprint (:steps a)))
      (pprint a)))
  (shutdown-agents)
  (System/exit 0))
