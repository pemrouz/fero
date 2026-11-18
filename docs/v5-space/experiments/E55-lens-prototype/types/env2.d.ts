// file: env2.d.ts — the app's own world for the lens lines (beside API.md's env.d.ts)
declare function render(el: unknown, x: unknown): void
declare const el: { textContent: string; isConnected: boolean }
declare const board: { rows: unknown }
declare const listEl: { textContent: string }
declare const label: { textContent: string }
declare function patch(...a: unknown[]): void
declare const text: string
declare const headline: string
declare const room: string
declare const ws: Socket
declare const l: import('fero-base').LockRef
declare const row: { stock: number; price: number }
declare const sku: string
declare const cursor: import('fero-base').Cursor
declare const otherCursor: import('fero-base').Cursor
declare function apply(e: unknown): void
