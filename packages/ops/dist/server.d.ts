import type { Access, Fetch, OpsCache } from './access.ts';
import type { Args, Command } from './contract.ts';
export type OpsContext = {
    login: string;
};
export type OpsOutput = {
    result: unknown;
    summary?: string;
};
export type OpsCommand = Command & {
    run(args: Args, ctx: OpsContext): Promise<OpsOutput> | OpsOutput;
    preview?(args: Args, ctx: OpsContext): Promise<OpsOutput> | OpsOutput;
};
export type OpsLogFields = {
    command?: string;
    mode?: string;
    outcome?: string;
    durationMs?: number;
};
export type OpsLogger = {
    info(message: 'ops command ran', fields?: OpsLogFields): void;
    warn(message: 'ops command rejected', fields?: OpsLogFields): void;
    error(message: 'ops command failed', fields?: OpsLogFields, error?: unknown): void;
};
export type OpsAuthorize = (token: string, ctx: {
    fetch: Fetch;
}) => Promise<Access>;
type OpsAccess = {
    repo: string;
    authorize?: undefined;
} | {
    repo?: undefined;
    authorize: OpsAuthorize;
};
export type OpsHandlerOptions = OpsAccess & {
    product: string;
    environment: string;
    commands: readonly OpsCommand[];
    fetch?: Fetch;
    cache?: OpsCache;
    logger?: OpsLogger;
};
export type OpsHandler = (request: Request, basePath: string) => Promise<Response>;
export declare function createOpsHandler(options: OpsHandlerOptions): OpsHandler;
export {};
