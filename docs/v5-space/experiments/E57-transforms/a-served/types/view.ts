// XA-11: a served view over two resources would carry one resource's positions only, so after a failover the other
// side could step back. The simpler fix the critic names: the types refuse it. A `{ view }` gets a context whose data
// is one resource's plain operators: no `lookup`, no second resource, no caller. A handler (`run`) keeps them.
// This file is self-contained (no fero package): the shapes only, checked by tsc 6.0.2 with `strict`.
type Json = string | number | boolean | null
type F<R> = Extract<keyof R, string>
interface Window<R> { readonly kind: 'window'; readonly row?: R }
interface Buckets { readonly kind: 'buckets' }
interface One { readonly kind: 'one' }
// what a view may return: bounded only
type Bounded<R> = Window<R> | Buckets | One
// one resource's rows, plain operators only (what a served view may build)
interface ViewData<R> {
  eq<K extends F<R>>(field: K, v: R[K] & Json): ViewData<R>
  gt<K extends F<R>>(field: K, v: R[K] & number): ViewData<R>
  az<K extends F<R>>(field: K, n: number, o?: { after: readonly [R[K], string] }): Window<R>
  za<K extends F<R>>(field: K, n: number, o?: { after: readonly [R[K], string] }): Window<R>
  by<K extends F<R>>(field: K, o?: { step: number }): { length(): Buckets; sum<V extends F<R>>(f: V): Buckets }
  sum<K extends F<R>>(field: K): One
  length(): One
}
// a handler's data: the same, plus a lookup into another resource (right of the live verb, here, on the server)
interface HandlerData<R> extends ViewData<R> {
  lookup<O>(other: Resource<O>, field: F<R>): ViewData<{ row: R; other: O | null }>
}
interface Resource<R> { readonly name: string; readonly __row?: R }
interface ViewCtx<R> { readonly data: ViewData<R> }                                   // no claims, no peer, no use()
interface HandlerCtx<R> { readonly data: HandlerData<R>; readonly claims: { sub: string }; use<O>(r: Resource<O>): HandlerData<O> }
type Method<R> =
  | { view: (arg: any, ctx: ViewCtx<R>) => Bounded<R>; allow?: (arg: any, claims: { sub: string }) => boolean }
  | { run: (arg: any, ctx: HandlerCtx<R>) => unknown }
declare function server<R>(name: string, methods: Record<string, Method<R>>): Resource<R>

type Order = { user: string; sku: string; cents: number; at: number }
type Product = { sku: string; title: string; price: number }
declare const products: Resource<Product>

server<Order>('orders', {
  // these compile: one resource, bounded
  best: { view: (n: number, ctx) => ctx.data.za('cents', Math.min(n, 100)) },
  byUser: { view: (_: null, ctx) => ctx.data.by('user').sum('cents') },
  mine: { view: (user: string, ctx) => ctx.data.eq('user', user).length(), allow: (user: string, claims) => claims.sub === user },
  // a handler may join, here, and answer once
  withTitles: { run: (n: number, ctx) => ctx.data.lookup(products, 'sku').length() },
  other: { run: (_: null, ctx) => ctx.use(products).length() },
  // @ts-expect-error a served view may not read another resource: its positions would cover one side only
  joined: { view: (_: null, ctx) => ctx.data.lookup(products, 'sku').length() },
  // @ts-expect-error a served view may not open a second resource
  opened: { view: (_: null, ctx) => ctx.use(products).length() },
  // @ts-expect-error a served view is shared by equal calls: it cannot read the caller
  leak: { view: (n: number, ctx) => ctx.data.eq('user', ctx.claims.sub).za('cents', n) },
})
