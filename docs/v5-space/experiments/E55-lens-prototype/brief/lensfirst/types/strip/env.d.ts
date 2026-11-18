// file: env.d.ts — stand-ins for the app's own world, so the pattern files type-check
declare const console: { log(...a: unknown[]): void }
declare const process: { pid: number; argv: string[]; exit(code?: number): never }
interface Socket { send(s: string): void; on(ev: 'message', fn: (text: string) => void): void; on(ev: 'close', fn: () => void): void }
declare const wss: { on(ev: 'connection', fn: (ws: Socket, room: string) => void): void }
declare const db: { price(sku: string): Promise<{ sku: string; cents: number } | undefined> }
declare function resize(url: string): Promise<string>
declare function sendMail(to: string): Promise<void>
declare function bill(order: unknown): Promise<void>
declare function render(x: unknown): void
declare const savedCursor: string | undefined      // text from the app's own storage
declare function save(c: string): void
declare const UserV3: import('fero').Schema<{ id: string; name: { first: string; last: string } }>
