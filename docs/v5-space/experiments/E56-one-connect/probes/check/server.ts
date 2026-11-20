// file: server.ts — the server's row type, as a typed client imports it (`import type`, evidence 9)
export interface Widget { name: string; stock: number; tags: string[] }
export type Shop = Record<string, Widget>
