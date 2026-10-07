/**
 * What a tool is, independent of the server that registers it: its contract
 * with the model and a handler that is testable without constructing a server.
 */
import type { ToolAnnotations } from '@modelcontextprotocol/server';
import type * as z from 'zod';
import type { MagentoClient } from '../magento/client.js';
import type { Logger } from '../shared/logger.js';
import type { ToolName } from './names.js';

/**
 * All four hints, required. The spec's defaults are conservative — an omitted
 * `destructiveHint` means true — so a read tool that leaves one out is treated
 * as destructive by a cautious host.
 */
export type ToolHints = Required<
    Pick<ToolAnnotations, 'readOnlyHint' | 'destructiveHint' | 'idempotentHint' | 'openWorldHint'>
>;

/** Every read tool's hints. `openWorldHint`: the answer comes from an external store that changes. */
export const READ_ANNOTATIONS = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true
} as const satisfies ToolHints;

/**
 * What a failure means for a retry, when the handler could not say more: the
 * server's backstop maps anything a handler lets escape with it.
 */
export type RetryContext =
    | { readonly idempotent: true }
    | {
          readonly idempotent: false;
          /** How the agent can confirm whether the call was applied, such as checking with get_order. */
          readonly verifyBeforeRetry: string;
      };

export const READ_RETRY = { idempotent: true } as const satisfies RetryContext;

/** A successful answer: the payload, and the one line of text that stands for it. */
export interface ToolAnswer<T> {
    readonly structuredContent: T;
    /** A one-line summary, followed by the notice when there is one. */
    readonly text: string;
}

/** What every tool is built from. */
export interface ToolDeps {
    readonly client: MagentoClient;
    readonly logger: Logger;
    /** MSI source that stock is read from and written to. */
    readonly sourceCode: string;
    /** MSI stock for salable-quantity and is-salable lookups. */
    readonly stockId: number;
}

export interface ToolDefinition<In extends z.ZodObject = z.ZodObject, Out extends z.ZodObject = z.ZodObject> {
    readonly name: ToolName;
    readonly description: string;
    readonly inputSchema: In;
    /** Also checked by the server against every answer, before it leaves. */
    readonly outputSchema: Out;
    readonly annotations: ToolHints;
    readonly retry: RetryContext;
    /**
     * Throws a `ToolError` for anything the agent should be told, mapped with
     * what only the handler knows, such as whether the token was accepted.
     *
     * Declared as a method so a list of tools with different inputs can share
     * one type: the server only calls it with input the SDK has already
     * validated against `inputSchema`.
     */
    handler(input: z.infer<In>): Promise<ToolAnswer<z.infer<Out>>>;
}
