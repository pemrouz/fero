;; Usage: java -cp maelstrom.jar clojure.main journal_snaprepeat.clj <net-journal dir>
;; For each MsgSnap send that repeats an earlier (leader, follower, index) send, print what the follower
;; sent to that leader in between (raft type, Index, Reject), and the leader's own MsgApp sends in between.
(require '[maelstrom.net.journal :as j] '[clojure.data.fressian :as fress] '[clojure.java.io :as io])
(let [[dir] *command-line-args*
      evs (sort-by :time (for [f (filter #(re-find #"\.fressian$" (.getName ^java.io.File %)) (file-seq (io/file dir)))
                ev (j/reader-seq (fress/create-reader (io/input-stream f) :handlers @#'j/read-handlers))
                :let [m (:message ev) b (:body m) rm (:m b)]
                :when (and (= "raft" (:type b)) (= :send (:type ev)))]
            {:time (:time ev) :src (:src m) :dest (:dest m) :t (get rm "Type") :idx (get-in rm ["Snapshot" "M" "I"])
             :index (get rm "Index") :reject (boolean (get rm "Reject")) :hint (get rm "RejectHint")}))
      v (vec evs)]
  (loop [i 0 last {}]
    (when (< i (count v))
      (let [e (v i)]
        (if (= 7 (:t e))
          (let [k [(:src e) (:dest e) (:idx e)] p (last k)]
            (when p
              (let [between (filter #(and (> (:time %) p) (< (:time %) (:time e))
                                          (= (:src %) (:dest e)) (= (:dest %) (:src e)) (= 4 (:t %))) v)]
                (println (:src e) "->" (:dest e) "idx" (:idx e) "repeat after" (quot (- (:time e) p) 1000000) "ms; follower replies between:"
                         (mapv (fn [x] [(:index x) (if (:reject x) (str "REJECT hint " (:hint x)) "ok")]) between))))
            (recur (inc i) (assoc last k (:time e))))
          (recur (inc i) last))))))
