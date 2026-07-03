export type LogLevel = 'errors' | 'info' | 'all';

export interface Logger {
    error: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    info: (...args: unknown[]) => void;
    debug: (...args: unknown[]) => void;
}

export function normalizeLogLevel(level: string | undefined): LogLevel {
    return level === 'all' || level === 'info' ? level : 'errors';
}

const noop = () => {};

export function createLogger(
    prefix: string,
    level: string | undefined
): Logger {
    const normalized = normalizeLogLevel(level);
    return {
        error: console.error.bind(console, prefix),
        warn: console.warn.bind(console, prefix),
        info:
            normalized === 'errors' ? noop : console.log.bind(console, prefix),
        debug:
            normalized === 'all'
                ? console.log.bind(console, prefix, '[debug]')
                : noop,
    };
}
