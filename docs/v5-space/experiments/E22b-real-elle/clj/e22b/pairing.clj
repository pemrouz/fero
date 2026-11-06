;; E-22b: E-22's completion-only EDN histories as jepsen.history ops (shared by elle_check.clj and
;; elle_explain.clj; see elle_check.clj for why invokes are added).
(ns e22b.pairing
  (:require [clojure.edn :as edn]
            [clojure.java.io :as io]))

(defn read-ops [file]
  (with-open [r (java.io.PushbackReader. (io/reader file))]
    (doall (take-while some? (repeatedly #(edn/read {:eof nil} r))))))

(defn invoke-of [op]
  (assoc op :type :invoke
         :value (mapv (fn [[f k v]] (if (= f :r) [f k nil] [f k v])) (:value op))))

(defn paired
  "Each completion becomes [invoke, completion], adjacent, in file order. E-22's self-test cases
  carry no :process; jepsen.history counts only ops with an integer process as client ops, so an
  op without one gets its own (1000 + its position), which no saga history uses."
  [ops]
  (vec (mapcat (fn [i op]
                 (let [op (if (integer? (:process op)) op (assoc op :process (+ 1000 i)))]
                   [(assoc (invoke-of op) :f :txn) (assoc op :f :txn)]))
               (range) ops)))
