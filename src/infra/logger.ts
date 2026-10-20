import pino from 'pino';

let logger = pino({ level: 'info' });

/** 日志脱敏：QQ 号只保留前 3 后 2 */
export function maskQQ(qq: string | number | undefined): string {
  if (qq === undefined || qq === null) return '(unknown)';
  const s = String(qq);
  if (s.length <= 5) return s;
  return `${s.slice(0, 3)}****${s.slice(-2)}`;
}

export interface LogOptions {
  level: string;
  pretty: boolean;
  maskQQ: boolean;
}

export function initLogger(opts: LogOptions): typeof logger {
  const transport = opts.pretty
    ? {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:HH:MM:ss',
          ignore: 'pid,hostname',
        },
      }
    : undefined;

  logger = pino({
    level: opts.level,
    transport,
    hooks: {
      logMethod(args, method, level) {
        if (!opts.maskQQ) return method.apply(this, args as any);
        const masked = args.map((a) => {
          if (typeof a === 'string') return a.replace(/\b(\d{5,12})\b/g, (m) => maskQQ(m));
          if (a && typeof a === 'object') {
            const clone: Record<string, unknown> = {};
            for (const [k, v] of Object.entries(a as Record<string, unknown>)) {
              clone[k] = typeof v === 'string' ? v.replace(/\b(\d{5,12})\b/g, (m) => maskQQ(m)) : v;
            }
            return clone;
          }
          return a;
        });
        return method.apply(this, masked as any);
      },
    },
  });
  return logger;
}

export function log(): typeof logger {
  return logger;
}
