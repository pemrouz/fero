;; E-22b: E-22's partition model (verify/go/model.go, the model Porcupine checked), ported line by
;; line to a Knossos model, so Knossos 0.3.16 can check the same per-partition histories.
;;
;; The Go model is nondeterministic (a touch without a ttl may or may not move the row's version),
;; and Porcupine handles that by tracking a set of states. Knossos wants one deterministic model,
;; so the Knossos model here is that set of states (the usual powerset construction): a step maps
;; every state, keeps every result, and is inconsistent only when no state accepts the operation.
;;
;; Values are read from JSON with every number made a double, as Go's encoding/json makes them
;; float64, so equality here is equality there (Go compares values by their JSON form).
(ns e22b.fero-model
  (:require [knossos.model :as m]))

;; ── JSON paths (model.go: pkey, leaf, setIn) ─────────────────────────────────────────────────────
(defn pkey [x]
  (cond (string? x) x
        (number? x) (let [d (double x)]
                      (if (and (== d (Math/rint d)) (< (Math/abs d) 1e15)) (str (long d)) (str d)))
        (nil? x) "<nil>"
        :else (str x)))

(defn atoi [s]
  (when (re-matches #"[+-]?\d+" s)
    (try (Long/parseLong (if (.startsWith ^String s "+") (subs s 1) s)) (catch Exception _ nil))))

(defn leaf
  "[value found?] at path, as model.go leaf."
  [v path]
  (loop [x v, p (seq path)]
    (if-not p
      [x true]
      (let [k (first p)]
        (cond (map? x) (let [kk (pkey k)]
                         (if (contains? x kk) (recur (get x kk) (next p)) [nil false]))
              (vector? x) (let [i (atoi (pkey k))]
                            (if (and i (>= i 0) (< i (count x))) (recur (nth x i) (next p)) [nil false]))
              :else [nil false])))))

(defn set-in [v path val remove?]
  (if (empty? path)
    (if remove? nil val)
    (let [h (pkey (first path))]
      (if (vector? v)
        (let [i (atoi h)]
          (if (and i (>= i 0))
            (let [n (into v (repeat (max 0 (- (inc i) (count v))) nil))]
              (if (= 1 (count path))
                (assoc n i (if remove? nil val))
                (assoc n i (set-in (nth n i) (rest path) val remove?))))
            v))
        (let [mm (if (map? v) v {})]
          (if (= 1 (count path))
            (if remove? (dissoc mm h) (assoc mm h val))
            (assoc mm h (set-in (get mm h) (rest path) val remove?))))))))

;; ── ops (model.go computeOp); [value ok?] ────────────────────────────────────────────────────────
(defn compute-op [cur has? spec]
  (case (get spec "op")
    "incr" (let [c (cond (and has? (some? cur)) (if (number? cur) (double cur) ::bad)
                         (and has? (nil? cur)) ::bad
                         :else 0.0)]
             (if (= c ::bad)
               [nil false]
               (let [nx (+ c (double (get spec "n"))) mn (get spec "min") mx (get spec "max")]
                 (cond (and (some? mn) (< nx (double mn))) [nil false]
                       (and (some? mx) (> nx (double mx))) [nil false]
                       :else [nx true]))))
    "push" (let [base (if has? (if (vector? cur) cur ::bad) [])]
             (if (= base ::bad)
               [nil false]
               ;; Go: append(append(nil, base...), items...) is nil when both are empty
               (let [r (into base (get spec "items"))] [(if (empty? r) nil r) true])))
    "merge" (let [base (if has? (if (map? cur) cur ::bad) {})]
              (if (= base ::bad) [nil false] [(merge base (get spec "fields")) true]))
    ("max" "min") (let [x (get spec "x")]
                    (if-not has?
                      [x true]
                      (let [gt (cond (number? x) (if (number? cur)
                                                   (if (= "min" (get spec "op")) (< x cur) (> x cur))
                                                   ::take)
                                     (string? x) (if (string? cur)
                                                   (let [c (compare x cur)] (if (= "min" (get spec "op")) (neg? c) (pos? c)))
                                                   ::take)
                                     :else false)]
                        (cond (= gt ::take) [x true]
                              gt [x true]
                              :else [cur true]))))
    [nil false]))

;; ── conditions (model.go evalCond); :pass :fail :unknown ────────────────────────────────────────
(def zero-row {:v "" :val nil :known false})

(defn eval-cond [c row present? path vals?]
  (if (nil? c)
    :pass
    (let [version (get c "version")]
      (cond (and (true? (get c "absent")) present?) :fail
            (and (true? (get c "present")) (not present?)) :fail
            (and (some? version) (not= (if present? (:v row) "") version)) :fail
            :else
            (let [res (if (contains? c "equals")
                        (if (or (not present?) (not (:known row)) (not vals?))
                          :unknown
                          (let [[x _] (leaf (:val row) path)] (if (= x (get c "equals")) :pass :fail)))
                        :pass)]
              (cond (= res :fail) :fail
                    (true? (get c "expired")) :unknown
                    :else res))))))

(defn vstr [x] (if (string? x) x ""))
(defn after? [v last] (pos? (compare v last)))

;; ── a refused write (model.go refused): legal when the state refuses it; changes nothing ────────
(defn refused [s in out vals?]
  (let [code (vstr (get out "code"))]
    (loop [rows (:rows s), ws (seq (get in "ws"))]
      (if-not ws
        []
        (let [w (first ws) k (get w "k") rk (pkey (first k)) present? (contains? rows rk)
              row (get rows rk zero-row) path (vec (rest k)) rm? (true? (get w "rm")) op (get w "op")
              can (case code
                    "absent-row" (and (> (count k) 1) (not present?) (not rm?))
                    "absent-path" (and (> (count k) 2) (not rm?)
                                       (or (not present?) (not (:known row)) (not vals?)
                                           (let [[p has?] (leaf (:val row) (subvec (vec k) 1 (dec (count k))))]
                                             (or (not has?) (not (or (map? p) (vector? p)))))))
                    "conflict" (or (not= :pass (eval-cond (get w "if") row present? path vals?))
                                   (and (some? op)
                                        (or (not vals?) (and present? (not (:known row)))
                                            (let [[cur has?] (if present? (leaf (:val row) path) [nil false])]
                                              (not (second (compute-op cur has? op)))))))
                    false)]
          (if can
            [s]
            (recur (cond (and (nil? op) (empty? path))
                         (if rm? (dissoc rows rk) (assoc rows rk {:v (:v row) :val (get w "v") :known vals?}))
                         present? (assoc rows rk (assoc row :known false))
                         :else rows)
                   (next ws))))))))

;; ── the step (model.go step): a vector of next states, empty when illegal ───────────────────────
(defn step1 [s kind in out vals?]
  (let [rows (:rows s) v (vstr (get out "v"))]
    (case kind
      "r" (let [k (get in "k") rk (pkey (first k)) present? (contains? rows rk) row (get rows rk)]
            (cond (not present?) (if (and (= v "") (not (true? (get out "has")))) [s] [])
                  (not= v (:v row)) []
                  (and vals? (:known row))
                  (let [[x has?] (leaf (:val row) (rest k)) ohas (true? (get out "has"))]
                    (if (or (not= has? ohas) (and has? (not= x (get out "val")))) [] [s]))
                  :else [s]))
      "e" (if-not (after? v (:last s))
            []
            (let [n (reduce (fn [rs r]
                              (let [k (get r "k") rk (pkey (first k)) present? (contains? rs rk)
                                    row (get rs rk zero-row) t (double (or (get r "t") 0))]
                                (cond (and (== t 2.0) (= 1 (count k))) (dissoc rs rk)
                                      (= 1 (count k)) (assoc rs rk {:v v :val (get r "v") :known vals?})
                                      (not present?) (reduced ::illegal)
                                      :else (assoc rs rk (assoc row :v v :val (set-in (:val row) (rest k) (get r "v") (== t 2.0)))))))
                            rows (get in "recs"))]
              (if (= n ::illegal)
                []
                [{:last v
                  :rows (reduce (fn [rs kk] (if (contains? rs kk) (assoc-in rs [kk :v] v) rs)) n (get in "bump"))}])))
      "claim" (cond (= v "") [s]
                    (not (after? v (:last s))) []
                    :else (let [n (reduce (fn [rs kk] (if (contains? rs kk) (assoc-in rs [kk :v] v) (reduced ::illegal)))
                                          rows (get out "rows"))]
                            (if (= n ::illegal) [] [{:last v :rows n}])))
      "touch" (let [key (get in "key") present? (contains? rows key) row (get rows key zero-row)
                    code (vstr (get out "code"))]
                (if (not= code "")
                  (case code
                    "absent-row" (if present? [] [s])
                    "conflict" (cond (not present?) []
                                     (not= :pass (eval-cond (get in "if") row present? nil vals?)) [s]
                                     :else [])
                    [])
                  (cond (or (not present?) (not (after? v (:last s)))) []
                        (= :fail (eval-cond (get in "if") row present? nil vals?)) []
                        :else (let [n {:last v :rows rows}
                                    bumped {:last v :rows (assoc rows key (assoc row :v v))}]
                                (if (true? (get in "ttl")) [bumped] [bumped n])))))
      "w" (cond (false? (get out "ok")) (refused s in out vals?)
                (not (after? v (:last s))) []
                :else
                (let [ws (vec (get in "ws")) nws (count ws)]
                  (loop [i 0, rs rows]
                    (if (= i nws)
                      [{:last v :rows rs}]
                      (let [w (nth ws i) k (get w "k") rk (pkey (first k)) present? (contains? rs rk)
                            row (get rs rk zero-row) path (vec (rest k)) rm? (true? (get w "rm")) op (get w "op")]
                        (cond
                          (and (> (count k) 1) (not present?) (not rm?)) []
                          (= :fail (eval-cond (get w "if") row present? path vals?)) []
                          :else
                          (let [[ans has-ans?] (if (true? (get out "hasAns"))
                                                 (let [a (get out "ans")]
                                                   (cond (= nws 1) [a true]
                                                         (and (vector? a) (< i (count a))) [(nth a i) true]
                                                         :else [nil false]))
                                                 [nil false])]
                            (cond
                              (some? op)
                              (let [known (and vals? (or (:known row) (not present?)))
                                    [cur has?] (if present? (leaf (:val row) path) [nil false])
                                    r (if known
                                        (let [[exp okc] (compute-op cur has? op)]
                                          (cond (not okc) ::illegal
                                                (and has-ans? (not= exp ans)) ::illegal
                                                :else exp))
                                        (if has-ans? ans nil))]
                                (if (= r ::illegal)
                                  []
                                  (let [row' (if (empty? path)
                                               {:val r :known (boolean (or known (and has-ans? vals?)))}
                                               (assoc row :val (set-in (:val row) path r false) :known (and (:known row) known)))]
                                    (recur (inc i) (assoc rs rk (assoc row' :v v))))))
                              rm? (if (empty? path)
                                    (recur (inc i) (dissoc rs rk))
                                    (let [row' (if present? (assoc row :val (set-in (:val row) path nil true)) row)]
                                      (recur (inc i) (assoc rs rk (assoc row' :v v)))))
                              :else
                              (let [row' (if (empty? path)
                                           {:val (get w "v") :known vals?}
                                           (assoc row :val (set-in (:val row) path (get w "v") false)))]
                                (recur (inc i) (assoc rs rk (assoc row' :v v))))))))))))
      [])))

;; ── the Knossos model: the set of states the partition may be in ────────────────────────────────
(defrecord FeroPartition [states]
  m/Model
  (step [this op]
    (let [{:strs [kind in out vals]} (:value op)
          nxt (into #{} (mapcat #(step1 % kind in out (true? vals))) states)]
      (if (empty? nxt)
        (m/inconsistent (str "no state accepts " kind " " (pr-str in) " -> " (pr-str out)))
        (FeroPartition. nxt)))))

(defn fero-partition [] (FeroPartition. #{{:last "" :rows {}}}))
