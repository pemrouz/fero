// E-44 side probe: does JetStream remember the message id of a publish it refused?
// Publish with id X and a wrong expected sequence (refused), then publish again with id X and no expectation.
// If the second answer says "duplicate", the refused publish burned its id, and the message is not stored.
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
const { connect, StorageType } = createRequire(pathToFileURL(process.env.E44_NPM + '/'))('nats')
const out = (o) => console.log(JSON.stringify(o))
const nc = await connect({ servers: process.env.E44_SERVERS.split(',') }), jsm = await nc.jetstreamManager(), js = nc.jetstream()
for (const replicas of [3, 1]) {
  const name = 'MSGID' + replicas + '_' + (Date.now() % 100000), subj = 'msgid.' + name
  await jsm.streams.add({ name, subjects: [subj], num_replicas: replicas, storage: StorageType.File })
  await js.publish(subj, 'first')                                       // the subject's last sequence is now 1
  let refused = null
  try { await js.publish(subj, 'second', { msgID: 'X', expect: { lastSubjectSequence: 999 } }) } catch (e) { refused = e.message }
  const again = await js.publish(subj, 'second', { msgID: 'X' })       // the same id, nothing in its way now
  const st = (await jsm.streams.info(name)).state
  out({ probe: 'a refused publish burns its message id', replicas, firstTry: refused, secondTry: { seq: again.seq, duplicate: again.duplicate }, messagesInStream: st.messages, burned: again.duplicate === true && st.messages === 1 })
}
await nc.close(); process.exit(0)
