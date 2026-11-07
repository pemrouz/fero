;; Usage: java -cp maelstrom.jar clojure.main journal_window.clj <net-journal dir> <node a> <node b> <from ns> <to ns>
;; Print every raft message event between two nodes in a time window (ns), both directions, sends and receives.
(require '[maelstrom.net.journal :as j] '[clojure.data.fressian :as fress] '[clojure.java.io :as io])
(let [[dir a b lo hi] *command-line-args* lo (Long/parseLong lo) hi (Long/parseLong hi)]
  (->> (for [f (filter #(re-find #"\.fressian$" (.getName ^java.io.File %)) (file-seq (io/file dir)))
             ev (j/reader-seq (fress/create-reader (io/input-stream f) :handlers @#'j/read-handlers))
             :let [m (:message ev) bd (:body m) rm (:m bd)]
             :when (and (= "raft" (:type bd)) (<= lo (:time ev) hi) (#{[a b] [b a]} [(:src m) (:dest m)]))]
         [(:time ev) (:type ev) (:id m) (:src m) (:dest m) (get rm "Type") (get rm "Term") "idx" (get rm "Index") "lt" (get rm "LogTerm")
          "commit" (get rm "Commit") "rej" (get rm "Reject") "hint" (get rm "RejectHint") "n" (count (get rm "Entries"))
          "snap" (get-in rm ["Snapshot" "M" "I"])])
       (sort-by first) (map prn) dorun))
