export const CODEX_PROVIDER_ERROR_CODES = [
    "app_server_transport_closed",
    "app_server_transport_terminated",
    "active_turn_unavailable",
] as const;

export type CodexProviderErrorCode = (typeof CODEX_PROVIDER_ERROR_CODES)[number];

export interface CodexProviderErrorOptions extends ErrorOptions
{
    code?: CodexProviderErrorCode;
}

export type CodedCodexProviderError = CodexProviderError & {
    readonly code: CodexProviderErrorCode;
};

export function isCodexProviderErrorCode(code: unknown): code is CodexProviderErrorCode
{
    return typeof code === "string" && CODEX_PROVIDER_ERROR_CODES.includes(code as CodexProviderErrorCode);
}

export function isCodexProviderError(error: unknown): error is CodexProviderError
{
    return error instanceof CodexProviderError;
}

export function isCodedCodexProviderError(error: unknown): error is CodedCodexProviderError
{
    return isCodexProviderError(error) && isCodexProviderErrorCode(error.code);
}

/** Base error type for this provider package. */
export class CodexProviderError extends Error 
{
    readonly code?: string | number;

    constructor(message: string, options?: CodexProviderErrorOptions)
    {
        super(message, options);
        this.name = "CodexProviderError";
        if (options?.code !== undefined)
        {
            this.code = options.code;
        }
    }
}

/** Error used for methods intentionally left as stubs in early PRs. */
export class CodexNotImplementedError extends CodexProviderError 
{
    constructor(method: string) 
    {
        super(`Codex provider method not implemented yet: ${method}`);
        this.name = "CodexNotImplementedError";
    }
}
