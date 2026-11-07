;; For planted bug 2 (E46_READ=leaderlocal): did any read reach a deposed leader, and could it be stale?
;; Reads the whole Maelstrom network journal on its one clock and tracks, per node, whether it is acting
;; as leader: from its first MsgApp/MsgHeartbeat/MsgSnap in term T until it sends anything a non-leader
;; sends (MsgAppResp, MsgHeartbeatResp, (Pre)Vote and their answers, a forwarded MsgProp or MsgReadIndex)
;; or any message with a higher term. A node acting as leader in T is DEPOSED once some node has sent a
;; leader message in a term above T. In leaderlocal mode a node acting as leader answers reads from its own
;; state, so every read_ok it sends while deposed is a read the bug served in the danger window.
;; For each such read it prints the last write/cas on that key that finished before the read was sent,
;; and whether the read returned that value. That is a hint, not a verdict: writes that overlap can explain it.
;; Usage: java -cp maelstrom.jar clojure.main journal_deposed.clj <net-journal dir>
(require '[maelstrom.net.journal :as j] '[clojure.data.fressian :as fress] '[clojure.java.io :as io])
(def leader-types #{3 7 8})
(def follower-types #{2 4 5 6 9 15 17 18})
(let [[dir] *command-line-args*
      evs (sort-by :time
                   (for [f (filter #(re-find #"\.fressian$" (.getName ^java.io.File %)) (file-seq (io/file dir)))
                         ev (j/reader-seq (fress/create-reader (io/input-stream f) :handlers @#'j/read-handlers))]
                     ev))
      client? #(and (string? %) (.startsWith ^String % "c"))]
  (loop [evs evs, acting {}, max-term 0, reqs {}, last-write {}, exposed 0, stale 0, windows 0, deposed-now #{}]
    (if-let [ev (first evs)]
      (let [m (:message ev) b (:body m) src (:src m) dest (:dest m) t (:time ev)]
        (cond
          ;; raft messages a node sent: update its acting-leader state
          (and (= :send (:type ev)) (= "raft" (:type b)))
          (let [rm (:m b) ty (get rm "Type") term (or (get rm "Term") 0)
                cur (get acting src)
                acting' (cond (leader-types ty) (assoc acting src term)
                              (or (follower-types ty) (and cur (> term cur))) (dissoc acting src)
                              :else acting)
                max' (if (leader-types ty) (max max-term term) max-term)
                dep (set (for [[n tm] acting' :when (< tm max')] n))
                new-windows (count (remove deposed-now dep))]
            (recur (rest evs) acting' max' reqs last-write exposed stale (+ windows new-windows) dep))
          ;; client requests (recorded when sent by the client)
          (and (= :send (:type ev)) (client? src) (#{"read" "write" "cas"} (:type b)))
          (recur (rest evs) acting max-term (assoc reqs [src (:msg_id b)] (assoc b :t t :node dest)) last-write exposed stale windows deposed-now)
          ;; replies to clients
          (and (= :send (:type ev)) (client? dest))
          (let [rq (get reqs [dest (:in_reply_to b)])]
            (cond
              (and rq (#{"write_ok" "cas_ok"} (:type b)))
              (recur (rest evs) acting max-term reqs
                     (assoc last-write (:key rq) {:t t :value (if (= "write" (:type rq)) (:value rq) (:to rq)) :node src})
                     exposed stale windows deposed-now)
              (and rq (= "read_ok" (:type b)) (deposed-now src))
              (let [w (->> (get last-write (:key rq)) (#(when (and % (< (:t %) (:t rq))) %)))
                    bad (and w (not= (:value w) (:value b)))]
                (println (format "deposed %s (acting leader in term %d, newest leader term %d) read key %s -> %s; last finished write before the read: %s%s"
                                 src (get acting src) max-term (:key rq) (:value b)
                                 (if w (str (:value w) " via " (:node w) ", " (quot (- (:t rq) (:t w)) 1000000) " ms before") "none")
                                 (if bad "  DIFFERS (a hint only: overlapping writes may explain it; Porcupine decides)" "")))
                (recur (rest evs) acting max-term reqs last-write (inc exposed) (if bad (inc stale) stale) windows deposed-now))
              :else (recur (rest evs) acting max-term reqs last-write exposed stale windows deposed-now)))
          :else (recur (rest evs) acting max-term reqs last-write exposed stale windows deposed-now)))
      (println (format "summary: %d times a node became a deposed acting leader; %d reads answered by a deposed leader; %d of them differ from the last finished write"
                       windows exposed stale)))))
