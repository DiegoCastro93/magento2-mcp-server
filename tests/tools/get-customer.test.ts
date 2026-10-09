import { beforeAll, describe, expect, it } from 'vitest';
import type * as z from 'zod';
import type { MagentoClient } from '../../src/magento/client.js';
import type { FixtureMagentoClient } from '../../src/magento/fixture-client.js';
import { GetCustomerOutputSchema, type GetCustomerOutput } from '../../src/projection/fields.js';
import { defineGetCustomer } from '../../src/tools/read/get-customer.js';
import { loadCustomer, wire } from '../projection/fixtures.js';
import { loadFixtureClient, memoryLogger, refusalOf } from './client-stubs.js';

type Input = z.input<ReturnType<typeof defineGetCustomer>['inputSchema']>;

let fixtures: FixtureMagentoClient;

beforeAll(async () => {
    fixtures = await loadFixtureClient();
});

function tool(client: MagentoClient = fixtures) {
    return defineGetCustomer({ client, logger: memoryLogger().logger, sourceCode: 'default', stockId: 1 });
}

function call(input: Input) {
    const definition = tool();
    return definition.handler(definition.inputSchema.parse(input));
}

/** The answer as it would cross stdio, checked against the output schema. */
async function answer(input: Input): Promise<{ result: GetCustomerOutput; text: string }> {
    const { structuredContent, text } = await call(input);
    const result = wire(structuredContent);
    expect(GetCustomerOutputSchema.safeParse(result).success).toBe(true);
    return { result, text };
}

describe('get_customer', () => {
    it('looks a customer up by ID, with a one-line summary', async () => {
        const { result, text } = await answer({ customerId: 1 });

        expect(result.customer).toMatchObject({ id: 1, email: 'roni_cost@example.com', groupId: 1 });
        expect(result.customer.addresses).toHaveLength(1);
        expect(text).toBe('Customer 1: Veronica Costello <roni_cost@example.com>, 1 address.');
    });

    it('looks a customer up by email, whatever its case', async () => {
        const { result } = await answer({ email: 'JORDAN.ELLIS@example.com' });

        expect(result.customer.id).toBe(2);
    });

    it('never lets the confirmation token through', async () => {
        const raw = await loadCustomer(2);
        const confirmation = (raw as unknown as { confirmation: string }).confirmation;
        const { result } = await answer({ customerId: 2 });

        expect(confirmation).toMatch(/\w{6,}/);
        expect(JSON.stringify(result)).not.toContain('confirmation');
        expect(JSON.stringify(result)).not.toContain(confirmation);
    });

    describe('when no account matches', () => {
        it('sends a guest checkout email to search_orders', async () => {
            // sam.rivera@example.net placed order 000000004 as a guest.
            const error = await refusalOf(call({ email: 'sam.rivera@example.net' }));

            expect(error.code).toBe('NOT_FOUND');
            expect(error.message).toBe("No customer account with email 'sam.rivera@example.net'.");
            expect(error.suggestion).toBe(
                'A guest checkout creates no customer account. Use search_orders with this email.'
            );
        });

        it('suggests checking an unknown ID, or the email', async () => {
            const error = await refusalOf(call({ customerId: 99 }));

            expect(error.code).toBe('NOT_FOUND');
            expect(error.message).toBe('No customer with ID 99.');
            expect(error.suggestion).toBe('Check the ID, or look the customer up by email address instead.');
        });
    });

    describe('refuses anything but exactly one key', () => {
        it('neither', async () => {
            const error = await refusalOf(call({}));

            expect(error.code).toBe('INVALID_INPUT');
            expect(error.message).toBe('Provide exactly one of email or customerId. Neither was given.');
            expect(error.retryable).toBe(false);
        });

        it('both', async () => {
            const error = await refusalOf(call({ email: 'roni_cost@example.com', customerId: 1 }));

            expect(error.code).toBe('INVALID_INPUT');
            expect(error.message).toBe('Provide exactly one of email or customerId. Both were given.');
            expect(error.suggestion).toBe('Call again with only one of them.');
        });
    });
});
