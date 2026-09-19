import { spawn, type ChildProcess } from 'node:child_process'
import net from 'node:net'

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

// poll every 25 ms until check() is truthy, or give up after ms
export const until = async (check: () => unknown, ms = 10_000): Promise<boolean> => {
    for (const t0 = Date.now(); ; await sleep(25)) {
        try { if (await check()) return true } catch {}
        if (Date.now() - t0 > ms) return false
    }
}

// a check meets its own directory on a free port, never the box's, so it never meets your terminals
export const privateDirectory = async (): Promise<void> => {
    if (process.env.FERO_RENDEZVOUS) return
    const port = await new Promise<number>((resolve, reject) => {
        const s = net.createServer()
        s.once('error', reject)
        s.listen(0, '127.0.0.1', () => { const a = s.address() as net.AddressInfo; s.close(() => resolve(a.port)) })
    })
    process.env.FERO_RENDEZVOUS = `127.0.0.1:${port}`
}

export interface Role { pid: number; out: string; exited: Promise<number | null>; stop(signal?: NodeJS.Signals): Promise<number | null>; child: ChildProcess }

// whatever happens to the check, every role it started is stopped
const children: ChildProcess[] = []
process.on('exit', () => { for (const c of children) if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL') })
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.once(sig, () => { for (const c of children) c.kill('SIGTERM'); setTimeout(() => process.exit(1), 500) })

// run `node <file>` as a reader would; stop() sends ctrl-c and gives up (SIGKILL, null) after 5 s
export const spawnRole = (file: string, tag: string): Role => {
    const child = spawn(process.execPath, [file], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
    children.push(child)
    const exited = new Promise<number | null>((r) => child.once('exit', (code) => r(code)))
    const role: Role = {
        pid: child.pid!, out: '', exited, child,
        stop: async (signal = 'SIGINT') => {
            child.kill(signal)
            const code = await Promise.race([exited, sleep(5000).then(() => 'hung' as const)])
            if (code !== 'hung') return code
            child.kill('SIGKILL')
            return null
        },
    }
    for (const [stream, err] of [[child.stdout!, false], [child.stderr!, true]] as const) {
        let buf = ''
        stream.setEncoding('utf8').on('data', (d: string) => {
            if (!err) role.out += d
            const lines = (buf + d).split('\n')
            buf = lines.pop()!
            for (const l of lines) (err ? console.error : console.log)(`[${tag}] ${l}`)
        })
    }
    return role
}
