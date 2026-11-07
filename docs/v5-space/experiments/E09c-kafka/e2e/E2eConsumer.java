// E-09c / E-09d: end-to-end latency under load, measured the way the OpenMessaging Benchmark does it:
// latency = consumer receive time (ms) - the record's CreateTime (ms), set by the producer at send().
// kafka-producer-perf-test sends records without a timestamp, so the producer stamps each one at send().
// The consumer is assigned every partition of the topic and starts at the end, with no consumer group.
//
// Usage: java -cp kafka-clients.jar:... E2eConsumer <bootstrap> <topic> <skipFirst> <maxSeconds> <idleSeconds>
// Prints one JSON line: count, skipped, p50, p90, p99, p999, max, mean (ms, 1 ms resolution).
import java.time.Duration;
import java.util.*;
import org.apache.kafka.clients.consumer.*;
import org.apache.kafka.common.PartitionInfo;
import org.apache.kafka.common.TopicPartition;
import org.apache.kafka.common.serialization.ByteArrayDeserializer;

public class E2eConsumer {
  public static void main(String[] a) throws Exception {
    String bootstrap = a[0], topic = a[1];
    long skipFirst = Long.parseLong(a[2]);
    long maxMs = Long.parseLong(a[3]) * 1000, idleMs = Long.parseLong(a[4]) * 1000;
    Properties p = new Properties();
    p.put("bootstrap.servers", bootstrap);
    p.put("key.deserializer", ByteArrayDeserializer.class.getName());
    p.put("value.deserializer", ByteArrayDeserializer.class.getName());
    p.put("enable.auto.commit", "false");
    p.put("client.id", "e2e-consumer");
    long[] hist = new long[120_001];  // 1 ms buckets, last one is overflow
    long count = 0, seen = 0, sum = 0, maxLat = 0;
    try (KafkaConsumer<byte[], byte[]> c = new KafkaConsumer<>(p)) {
      List<TopicPartition> tps = new ArrayList<>();
      for (int i = 0; i < 100 && tps.isEmpty(); i++) {
        List<PartitionInfo> ps = c.partitionsFor(topic);
        if (ps != null) for (PartitionInfo pi : ps) tps.add(new TopicPartition(topic, pi.partition()));
        if (tps.isEmpty()) Thread.sleep(100);
      }
      c.assign(tps);
      c.seekToEnd(tps);
      for (TopicPartition tp : tps) c.position(tp);  // resolve the end offsets now, before the producer starts
      System.err.println("e2e-consumer ready " + tps.size() + " partitions");
      long start = System.currentTimeMillis(), first = -1, last = start;
      while (true) {
        ConsumerRecords<byte[], byte[]> rs = c.poll(Duration.ofMillis(100));
        long now = System.currentTimeMillis();
        for (ConsumerRecord<byte[], byte[]> r : rs) {
          seen++;
          if (first < 0) first = now;
          if (seen <= skipFirst) continue;
          long lat = Math.max(0, now - r.timestamp());
          hist[(int) Math.min(lat, hist.length - 1)]++;
          count++; sum += lat; if (lat > maxLat) maxLat = lat;
        }
        if (!rs.isEmpty()) last = now;
        if (first >= 0 && now - first > maxMs) break;
        if (now - last > idleMs && (first >= 0 || now - start > 60_000)) break;
      }
    }
    System.out.printf(Locale.ROOT,
        "{\"count\":%d,\"skipped\":%d,\"p50\":%d,\"p90\":%d,\"p99\":%d,\"p999\":%d,\"max\":%d,\"mean\":%.3f}%n",
        count, Math.min(seen, skipFirst), q(hist, count, 0.50), q(hist, count, 0.90), q(hist, count, 0.99),
        q(hist, count, 0.999), maxLat, count == 0 ? 0.0 : (double) sum / count);
  }

  static long q(long[] h, long n, double f) {
    if (n == 0) return -1;
    long want = (long) Math.ceil(f * n), acc = 0;
    for (int i = 0; i < h.length; i++) { acc += h[i]; if (acc >= want) return i; }
    return h.length - 1;
  }
}
