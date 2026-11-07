;; E-22b: E-22's completion-only EDN histories as jepsen.history ops (shared by elle_check.clj and
;; elle_explain.clj; see elle_check.clj for why invokes are added).
(ns e22b.pairing
  (:require [clojure.edn :as edn]
            [clojure.java.io :as io]
            [elle.list-append :as la]))

(defn port-rule-if-asked!
  "E22B_RULE=port: swap Elle 0.2.8's previously-appended-element for the Go port's rule (an
  append no read ever saw has no known predecessor, so it gets no ww or rw edge). See elle_check.clj."
  []
  (when (= "port" (System/getenv "E22B_RULE"))
    (alter-var-root #'la/previously-appended-element
                    (fn [orig]
                      (fn [append-index write-index op [f k v :as mop]]
                        (when (some? (get-in append-index [k :indices v]))
                          (orig append-index write-index op mop)))))))

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
