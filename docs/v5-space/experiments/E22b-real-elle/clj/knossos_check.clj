;; E-22b: Knossos 0.3.16 (jepsen-io/knossos) on E-22's per-partition histories, beside Porcupine.
;;
;; Usage: java -cp "$SP/dl/elle-mvn/jars/*:<this dir>" clojure.main knossos_check.clj \
;;          <jobs.jsonl> <out.jsonl> <time-limit-ms> [analyzer]
;;   jobs.jsonl  one partition per line, as E-22 exported it, plus where it came from:
;;               {"file","seed","idx","res","p","vals","ops":[{"c","r","kind","in","out"}...]}
;;   analyzer    competition (default: linear and wgl race, as Jepsen's checker does), wgl or linear
;;
;; The history is built the way E-22's Go checker hands it to Porcupine (verify/go/main.go toOps):
;; every operation is its own client; call and return times are int64(t * 1e6); events are ordered
;; by time, a call before a return at the same time (Porcupine's byTime). A refused write is an :ok
;; completion whose value says "refused", so the model checks the refusal was legal, as Porcupine
;; does (Knossos would drop a :fail op unchecked). A write whose client never got an answer but
;; which committed returns at 1e12 ms, as in E-22's export: it must take effect before the end.
(ns e22b.knossos-check
  (:require [e22b.fero-model :as fm]
            [knossos.competition :as kc]
            [knossos.wgl :as wgl]
            [knossos.linear :as lin]
            [clojure.data.json :as json]
            [clojure.java.io :as io]
            [clojure.walk :as walk]))

(defn dbl [x]
  (walk/postwalk (fn [v] (if (and (number? v) (not (instance? Double v))) (double v) v)) x))

(defn t->long [t] (long (* (double t) 1e6)))

(defn history [part]
  (let [vals? (true? (get part "vals"))
        evs (->> (get part "ops")
                 (map-indexed
                   (fn [i o]
                     (let [v {"kind" (get o "kind") "in" (dbl (get o "in")) "out" (dbl (get o "out")) "vals" vals?}]
                       [[(t->long (get o "c")) 0 i {:type :invoke :process i :f :op :value v}]
                        [(t->long (get o "r")) 1 i {:type :ok :process i :f :op :value v}]])))
                 (apply concat)
                 (sort-by (fn [[t k i]] [t k i])))]
    (mapv (fn [[_ _ _ op] j] (assoc op :index j)) evs (range))))

(defn analyze [analyzer hist limit]
  (let [model (fm/fero-partition)
        opts {:time-limit limit}]
    (case analyzer
      "wgl" (wgl/analysis model hist opts)
      "linear" (lin/analysis model hist opts)
      (kc/analysis model hist opts))))

(defn verdict [r]
  (let [v (:valid? r)]
    (cond (true? v) "ok" (false? v) "illegal" :else "unknown")))

(defn -main [jobs out limit & [analyzer]]
  (let [limit (Long/parseLong limit)
        analyzer (or analyzer "competition")]
    (with-open [rd (io/reader jobs) w (io/writer out)]
      (doseq [line (line-seq rd)]
        (let [part (json/read-str line)
              t0 (System/nanoTime)
              res (try (let [h (history part)
                             r (analyze analyzer h limit)]
                         {:knossos (verdict r)
                          :analyzer (some-> (:analyzer r) name)
                          :cause (some-> (:cause r) str)
                          :why (when (false? (:valid? r))
                                 (let [s (str (or (:op r) (some-> r :final-paths first)))]
                                   (subs s 0 (min 300 (count s)))))})
                       (catch Throwable e {:knossos "error" :cause (str (class e) ": " (.getMessage e))}))
              ms (/ (- (System/nanoTime) t0) 1e6)]
          (.write w (json/write-str (merge (select-keys part ["file" "check" "mode" "mutant" "seed" "idx" "res" "p"])
                                           {:ops (count (get part "ops")) :ms (Math/round (double ms))}
                                           res)))
          (.write w "\n")
          (.flush w)))))
  (shutdown-agents)
  (System/exit 0))

(apply -main *command-line-args*)
