import { hasDatabaseContext } from '../db/index.ts';
import { EventEmitter } from 'node:events';
// Astro bundles server modules separately; this bus is shared with server.mjs.
const key = Symbol.for('rally.events');
const shared = globalThis as typeof globalThis & { [key]?: EventEmitter };
const bus = (shared[key] ??= new EventEmitter());
export const events = new Proxy(bus, {
  get(target, property) {
    if (property === 'emit')
      return (event: string | symbol, ...args: unknown[]) => {
        if (hasDatabaseContext() && event === 'power-hour-change') return false;
        return target.emit(event, ...args);
      };
    const value = Reflect.get(target, property, target);
    return typeof value === 'function' ? value.bind(target) : value;
  },
});
