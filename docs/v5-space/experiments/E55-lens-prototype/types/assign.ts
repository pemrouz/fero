// file: assign.ts — claim 5's retry of typed plain assignment: `shop.data.widgets.stock = 4` on a typed lens.
// Three tries, each must be recorded; none is part of the sketch. (A fourth, a mapped type with a getter and a
// setter of different types, is not valid syntax: `{ get [P in keyof T](): … }` gives TS1005; see results/.)
import { type Resource } from 'fero'
type Item = { stock: number }
declare const shop: Resource<Record<string, Item>>
// try 1: the lens as it is (readonly steps typed as lenses)
shop.data.widgets.stock = 4
// try 2: steps that are not readonly: assignment must then take a Lens, never a number
type Open<T> = { -readonly [P in keyof T]: { set(v: T[P]): void } }
declare const o: Open<Item>
o.stock = 4
// try 3: steps typed as the value or the lens: assignment types, but a read is a union and `.set` stops typing
type Either<T> = { -readonly [P in keyof T]: T[P] | { set(v: T[P]): void } }
declare const e: Either<Item>
e.stock = 4
e.stock.set(5)
// try 4: a declared accessor pair (TypeScript 5.1+: unrelated get/set types) works for a NAMED key only
interface Named { get stock(): { set(v: number): void }; set stock(v: number) }
declare const n: Named
n.stock = 4
n.stock.set(5)
export {}
