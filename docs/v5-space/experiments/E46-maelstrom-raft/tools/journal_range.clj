;; Print one client's requests and the replies to them, for msg ids lo..hi, from a Maelstrom network journal.
;; Usage: java -cp maelstrom.jar clojure.main journal_range.clj <net-journal dir> <client> <lo> <hi>
(require '[maelstrom.net.journal :as j] '[clojure.data.fressian :as fress] '[clojure.java.io :as io])
(let [[dir client lo hi] *command-line-args* lo (Long/parseLong lo) hi (Long/parseLong hi)]
  (->> (for [f (filter #(re-find #"\.fressian$" (.getName ^java.io.File %)) (file-seq (io/file dir)))
             ev (j/reader-seq (fress/create-reader (io/input-stream f) :handlers @#'j/read-handlers))
             :let [m (:message ev) b (:body m)]
             :when (and (= :send (:type ev)) (or (= client (:src m)) (= client (:dest m)))
                        (let [x (if (= client (:src m)) (:msg_id b) (:in_reply_to b))] (and x (<= lo x hi))))]
         [(:time ev) (:src m) (:dest m) b])
       (sort-by first) (map prn) dorun))
