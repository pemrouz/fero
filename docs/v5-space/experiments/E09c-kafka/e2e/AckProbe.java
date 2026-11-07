// E-09c / E-09d: produce-ack latency with one record in flight, at microsecond resolution.
// kafka-e2e-latency prints its percentiles in whole milliseconds (rounded down), too coarse beside
// NATS's and etcd's sub-millisecond rows, so this probe repeats its produce half with System.nanoTime():
// send one 1,024-byte record with acks=all and linger.ms=0 (as kafka-e2e-latency sets it), wait for the
// ack, record the time, repeat. It uses Kafka's own Java client, nothing else.
//
// Usage: java -cp kafka-clients.jar:... AckProbe <bootstrap> <topic> <records> <warmup> <maxSeconds>
// Prints one JSON line: count, rate, p50, p90, p99, p999, max, mean (µs).
import java.util.*;
import org.apache.kafka.clients.producer.*;
import org.apache.kafka.common.serialization.ByteArraySerializer;

public class AckProbe {
  public static void main(String[] a) throws Exception {
    String bootstrap = a[0], topic = a[1];
    int n = Integer.parseInt(a[2]), warm = Integer.parseInt(a[3]);
    long maxNs = Long.parseLong(a[4]) * 1_000_000_000L;
    Properties p = new Properties();
    p.put("bootstrap.servers", bootstrap);
    p.put("key.serializer", ByteArraySerializer.class.getName());
    p.put("value.serializer", ByteArraySerializer.class.getName());
    p.put("acks", "all");
    p.put("linger.ms", "0");
    p.put("client.id", "ack-probe");
    byte[] v = new byte[1024];
    new Random(0).nextBytes(v);
    long[] us = new long[n];
    int count = 0;
    long t0 = 0;
    try (KafkaProducer<byte[], byte[]> prod = new KafkaProducer<>(p)) {
      for (int i = 0; i < warm; i++) prod.send(new ProducerRecord<>(topic, v)).get();
      t0 = System.nanoTime();
      while (count < n && System.nanoTime() - t0 < maxNs) {
        long b = System.nanoTime();
        prod.send(new ProducerRecord<>(topic, v)).get();
        us[count++] = (System.nanoTime() - b) / 1000;
      }
    }
    double secs = (System.nanoTime() - t0) / 1e9;
    long[] s = Arrays.copyOf(us, count);
    Arrays.sort(s);
    double sum = 0; for (long x : s) sum += x;
    System.out.printf(Locale.ROOT,
        "{\"count\":%d,\"rate\":%.1f,\"p50\":%d,\"p90\":%d,\"p99\":%d,\"p999\":%d,\"max\":%d,\"mean\":%.1f}%n",
        count, count / secs, q(s, 0.50), q(s, 0.90), q(s, 0.99), q(s, 0.999), s[count - 1], sum / count);
  }

  static long q(long[] s, double f) {
    int i = (int) Math.ceil(f * s.length) - 1;
    return s[Math.max(0, Math.min(i, s.length - 1))];
  }
}
