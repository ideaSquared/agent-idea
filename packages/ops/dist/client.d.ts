import type { Fetch } from './access.ts';
import type { Catalog, InvokeRequest, InvokeResponse } from './contract.ts';
export declare function fetchCatalog(baseUrl: string, token: string, fetcher?: Fetch): Promise<Catalog>;
export declare function invoke(baseUrl: string, token: string, request: InvokeRequest, fetcher?: Fetch): Promise<InvokeResponse>;
