;; For each raft MsgSnap (Type 7) that reached its follower in a Maelstrom run, print the
;; follower's first answer to that leader after it: a MsgAppResp (Type 4) sent within 200 ms.
;; A follower that restores the snapshot answers Index = the snapshot index; one that ignores it
;; because it already holds that index answers Index = its commit index (etcd raft handleSnapshot).
;; Output lines: <recv time ns> <leader> -> <follower> idx <snapshot index> resp <Index> reject <true|false>
;; Usage: java -cp maelstrom.jar clojure.main journal_snapcheck.clj <net-journal dir>
(require '[maelstrom.net.journal :as j]
         '[clojure.data.fressian :as fress]
         '[clojure.java.io :as io])
(let [[dir] *command-line-args*
      evs (vec (for [f (filter #(re-find #"\.fressian$" (.getName ^java.io.File %)) (file-seq (io/file dir)))
                     ev (j/reader-seq (fress/create-reader (io/input-stream f) :handlers @#'j/read-handlers))
                     :let [m (:message ev) b (:body m) rm (:m b) t (get rm "Type")]
                     :when (and (= "raft" (:type b)) (or (and (= 7 t) (= :recv (:type ev)))
                                                         (and (= 4 t) (= :send (:type ev)))))]
                 {:t t :time (:time ev) :src (:src m) :dest (:dest m)
                  :idx (get-in rm ["Snapshot" "M" "I"]) :index (get rm "Index") :reject (boolean (get rm "Reject"))}))
      resps (group-by (juxt :src :dest) (sort-by :time (filter #(= 4 (:t %)) evs)))]
  (doseq [s (sort-by :time (filter #(= 7 (:t %)) evs))]
    (let [r (first (filter #(and (> (:time %) (:time s)) (< (- (:time %) (:time s)) 200000000)
                                 (not (:reject %)) (>= (or (:index %) 0) (:idx s)))
                           (get resps [(:dest s) (:src s)])))]
      (println (:time s) (:src s) "->" (:dest s) "idx" (:idx s)
               "resp" (if r (:index r) "none") "reject" (if r (:reject r) "-")))))
