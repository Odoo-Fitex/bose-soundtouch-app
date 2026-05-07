declare module "wol" {
  export function wake(mac: string, opts?: { address?: string; port?: number }, cb?: (err: Error | null) => void): void;
  export function wake(mac: string, cb: (err: Error | null) => void): void;
}
