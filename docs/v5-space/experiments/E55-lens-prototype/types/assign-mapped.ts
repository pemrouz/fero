// file: assign-mapped.ts — the accessor pair in a mapped type: not valid TypeScript
type Assignable<T> = { get [P in keyof T](): { set(v: T[P]): void }; set [P in keyof T](v: T[P]) }
export {}
