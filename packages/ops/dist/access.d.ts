export type Access = {
    outcome: 'allowed';
    login: string;
} | {
    outcome: 'denied';
    login: string;
} | {
    outcome: 'unauthenticated';
};
export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;
export type OpsCache = {
    get(key: string): Promise<string | null>;
    put(key: string, value: string, options: {
        expirationTtl: number;
    }): Promise<unknown>;
};
export declare function checkWriteAccess(token: string, repo: string, fetcher: Fetch): Promise<Access>;
export type TeamRef = {
    org: string;
    team: string;
};
export declare function checkTeamMembership(token: string, { org, team }: TeamRef, fetcher: Fetch): Promise<Access>;
export declare function cachedWriteAccess(token: string, repo: string, cache: OpsCache, fetcher: Fetch): Promise<Access>;
