export type Level = 'debug' | 'info' | 'warn' | 'error';
export type FieldValue = string | number | boolean | null;
export type LogEvent = {
    timestamp: string;
    level: Level;
    service: string;
    message: string;
    meta?: Record<string, FieldValue>;
    error?: {
        type: string;
        message: string;
        stack?: string;
    };
    dropped?: number;
};
export type Sink = (event: LogEvent) => void;
export type Message<M extends string> = {} extends Record<M, 1> ? never : M;
export type Fields<F extends string> = Partial<Record<F, FieldValue>>;
export type Logger<F extends string> = {
    debug<M extends string>(message: Message<M>, fields?: Fields<F>): void;
    info<M extends string>(message: Message<M>, fields?: Fields<F>): void;
    warn<M extends string>(message: Message<M>, fields?: Fields<F>, error?: unknown): void;
    error<M extends string>(message: Message<M>, fields?: Fields<F>, error?: unknown): void;
    with(fields: Fields<F>): Logger<F>;
};
export type LoggerOptions<F extends string> = {
    service: string;
    fields: readonly F[];
    level?: Level;
    sink?: Sink;
};
export declare function createLogger<const F extends string>(options: LoggerOptions<F>): Logger<F>;
export declare function memorySink(): Sink & {
    events: LogEvent[];
};
