// file: react.ts — a stand-in for React's effect type (the shape of @types/react's EffectCallback, from memory)
declare const UNDEFINED_VOID_ONLY: unique symbol
type Destructor = () => void | { [UNDEFINED_VOID_ONLY]: never }
export type EffectCallback = () => void | Destructor
export declare function useEffect(effect: EffectCallback, deps?: readonly unknown[]): void
