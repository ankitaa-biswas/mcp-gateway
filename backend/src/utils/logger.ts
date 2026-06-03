// Simple structured logger (console-based for demo; swap with Winston/Pino in prod)
const timestamp = () => new Date().toISOString();

export const logger = {
  info:  (msg: string, ...args: unknown[]) => console.log(`[${timestamp()}] INFO  ${msg}`, ...args),
  error: (msg: string, ...args: unknown[]) => console.error(`[${timestamp()}] ERROR ${msg}`, ...args),
  warn:  (msg: string, ...args: unknown[]) => console.warn(`[${timestamp()}] WARN  ${msg}`, ...args),
  http:  (msg: string, ...args: unknown[]) => console.log(`[${timestamp()}] HTTP  ${msg}`, ...args),
  debug: (msg: string, ...args: unknown[]) => {
    if (process.env.NODE_ENV !== 'production') {
      console.debug(`[${timestamp()}] DEBUG ${msg}`, ...args);
    }
  },
};
