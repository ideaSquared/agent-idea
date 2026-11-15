import { z } from 'zod';
export declare const OPS_CONTRACT_VERSION = 1;
export declare const FIELD_TYPES: readonly ["string", "number", "boolean", "enum", "id"];
export declare const OPS_ERROR_CODES: readonly ["unauthenticated", "forbidden", "not_found", "invalid_argument", "internal"];
export declare const FieldSchema: z.ZodObject<{
    name: z.ZodString;
    type: z.ZodEnum<{
        string: "string";
        number: "number";
        boolean: "boolean";
        enum: "enum";
        id: "id";
    }>;
    required: z.ZodBoolean;
    description: z.ZodString;
    values: z.ZodOptional<z.ZodArray<z.ZodString>>;
    positional: z.ZodOptional<z.ZodBoolean>;
}, z.core.$strip>;
export type Field = z.infer<typeof FieldSchema>;
export declare const CommandSchema: z.ZodObject<{
    id: z.ZodString;
    group: z.ZodString;
    name: z.ZodString;
    summary: z.ZodString;
    kind: z.ZodEnum<{
        read: "read";
        write: "write";
    }>;
    fields: z.ZodArray<z.ZodObject<{
        name: z.ZodString;
        type: z.ZodEnum<{
            string: "string";
            number: "number";
            boolean: "boolean";
            enum: "enum";
            id: "id";
        }>;
        required: z.ZodBoolean;
        description: z.ZodString;
        values: z.ZodOptional<z.ZodArray<z.ZodString>>;
        positional: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strip>>;
    dryRun: z.ZodBoolean;
}, z.core.$strip>;
export type Command = z.infer<typeof CommandSchema>;
export declare const CatalogSchema: z.ZodObject<{
    version: z.ZodLiteral<1>;
    product: z.ZodString;
    environment: z.ZodString;
    commands: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        group: z.ZodString;
        name: z.ZodString;
        summary: z.ZodString;
        kind: z.ZodEnum<{
            read: "read";
            write: "write";
        }>;
        fields: z.ZodArray<z.ZodObject<{
            name: z.ZodString;
            type: z.ZodEnum<{
                string: "string";
                number: "number";
                boolean: "boolean";
                enum: "enum";
                id: "id";
            }>;
            required: z.ZodBoolean;
            description: z.ZodString;
            values: z.ZodOptional<z.ZodArray<z.ZodString>>;
            positional: z.ZodOptional<z.ZodBoolean>;
        }, z.core.$strip>>;
        dryRun: z.ZodBoolean;
    }, z.core.$strip>>;
}, z.core.$strip>;
export type Catalog = z.infer<typeof CatalogSchema>;
export declare const ModeSchema: z.ZodEnum<{
    run: "run";
    preview: "preview";
}>;
export type Mode = z.infer<typeof ModeSchema>;
export declare const InvokeRequestSchema: z.ZodObject<{
    command: z.ZodString;
    args: z.ZodRecord<z.ZodString, z.ZodUnknown>;
    mode: z.ZodEnum<{
        run: "run";
        preview: "preview";
    }>;
}, z.core.$strip>;
export type InvokeRequest = z.infer<typeof InvokeRequestSchema>;
export declare const InvokeResponseSchema: z.ZodObject<{
    command: z.ZodString;
    mode: z.ZodEnum<{
        run: "run";
        preview: "preview";
    }>;
    result: z.ZodUnknown;
    summary: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export type InvokeResponse = z.infer<typeof InvokeResponseSchema>;
export declare const OpsErrorCodeSchema: z.ZodEnum<{
    unauthenticated: "unauthenticated";
    forbidden: "forbidden";
    not_found: "not_found";
    invalid_argument: "invalid_argument";
    internal: "internal";
}>;
export type OpsErrorCode = z.infer<typeof OpsErrorCodeSchema>;
export declare const ErrorResponseSchema: z.ZodObject<{
    error: z.ZodObject<{
        code: z.ZodEnum<{
            unauthenticated: "unauthenticated";
            forbidden: "forbidden";
            not_found: "not_found";
            invalid_argument: "invalid_argument";
            internal: "internal";
        }>;
        message: z.ZodString;
    }, z.core.$strip>;
}, z.core.$strip>;
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;
export declare const OPS_ERROR_STATUS: Record<OpsErrorCode, number>;
export type ArgValue = string | number | boolean;
export type Args = Record<string, ArgValue>;
export declare class OpsError extends Error {
    readonly code: OpsErrorCode;
    constructor(code: OpsErrorCode, message: string);
}
