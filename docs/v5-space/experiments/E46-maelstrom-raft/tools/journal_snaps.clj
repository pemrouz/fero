;; For each raft MsgSnap (Type 7) in a Maelstrom run's network journal, print one line:
;; the journal time it was sent, from, to, snapshot index, and whether it was received.
;; Usage: java -cp maelstrom.jar clojure.main journal_snaps.clj <net-journal dir>
;; (Maelstrom keywordizes only the message and body keys; the raft message inside keeps string keys.)
(require '[maelstrom.net.journal :as j]
         '[clojure.data.fressian :as fress]
         '[clojure.java.io :as io])
(let [[dir] *command-line-args*
      evs (for [f (filter #(re-find #"\.fressian$" (.getName ^java.io.File %)) (file-seq (io/file dir)))
                ev (j/reader-seq (fress/create-reader (io/input-stream f) :handlers @#'j/read-handlers))
                :let [m (:message ev) b (:body m) rm (:m b)]
                :when (and (= "raft" (:type b)) (= 7 (get rm "Type")))]
            {:type (:type ev) :time (:time ev) :id (:id m) :src (:src m) :dest (:dest m)
             :idx (get-in rm ["Snapshot" "M" "I"])})
      by-id (group-by :id evs)]
  (doseq [[id es] (sort-by (fn [[_ es]] (apply min (map :time es))) by-id)]
    (let [s (first (filter #(= :send (:type %)) es))
          r (first (filter #(= :recv (:type %)) es))]
      (println (:time s) (:src s) "->" (:dest s) "idx" (:idx s) (if r "received" "DROPPED")))))
