;; Print every network-journal event of a Maelstrom run that involves one client and one
;; message id (as id or in_reply_to). Uses the Maelstrom jar's own Fressian handlers.
;; Usage: java -cp maelstrom.jar clojure.main journal_grep.clj <net-journal dir> <client> <msg_id>
(require '[maelstrom.net.journal :as j]
         '[clojure.data.fressian :as fress]
         '[clojure.java.io :as io])
(let [[dir client id] *command-line-args*
      id (Long/parseLong id)]
  (doseq [f (sort-by #(.getName ^java.io.File %)
                     (filter #(re-find #"\.fressian$" (.getName ^java.io.File %)) (file-seq (io/file dir))))
          ev (j/reader-seq (fress/create-reader (io/input-stream f) :handlers @#'j/read-handlers))]
    (let [m (:message ev)
          b (:body m)]
      (when (and (or (= client (:src m)) (= client (:dest m)))
                 (or (= id (:msg_id b)) (= id (:in_reply_to b))))
        (prn (select-keys ev [:type :time]) (select-keys m [:id :src :dest]) b)))))
