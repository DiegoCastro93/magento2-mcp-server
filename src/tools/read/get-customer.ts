/**
 * `get_customer`: one customer account, by email or by ID.
 *
 * "Exactly one of" is checked here rather than with a zod `.refine`, for the
 * reason given in `search-products.ts`. A union of two input shapes is no way
 * out either: a tool's input schema must be a single object.
 */
import * as z from 'zod';
import { ToolError } from '../../errors/tool-error.js';
import type { RawCustomer } from '../../magento/raw-types.js';
import { projectCustomer } from '../../projection/customer.js';
import { GetCustomerOutputSchema, type Customer, type GetCustomerOutput } from '../../projection/fields.js';
import { READ_ANNOTATIONS, READ_RETRY, type ToolDefinition, type ToolDeps } from '../definition.js';

const DESCRIPTION =
    'Look up one customer account by email address or by numeric customer ID. Provide exactly one of the two. ' +
    'Returns profile and address fields only — never credentials or tokens. The customer group is a numeric ID; ' +
    'its name is not resolved. Guest checkouts have no customer account and will not be found here; use ' +
    'search_orders by email instead.';

const EXACTLY_ONE = 'Provide exactly one of email or customerId.';

const GetCustomerInputSchema = z.object({
    email: z.email().optional().describe(EXACTLY_ONE),
    customerId: z.number().int().positive().optional().describe(EXACTLY_ONE)
});

export function defineGetCustomer(
    deps: ToolDeps
): ToolDefinition<typeof GetCustomerInputSchema, typeof GetCustomerOutputSchema> {
    const { client } = deps;

    return {
        name: 'get_customer',
        description: DESCRIPTION,
        inputSchema: GetCustomerInputSchema,
        outputSchema: GetCustomerOutputSchema,
        annotations: READ_ANNOTATIONS,
        retry: READ_RETRY,

        async handler({ email, customerId }) {
            const raw = await lookUp(email, customerId);
            const customer = projectCustomer(raw);

            const structuredContent: GetCustomerOutput = { customer };
            return { structuredContent, text: summarize(customer) };
        }
    };

    async function lookUp(email: string | undefined, customerId: number | undefined): Promise<RawCustomer> {
        if (email !== undefined && customerId !== undefined) {
            throw new ToolError('INVALID_INPUT', `${EXACTLY_ONE} Both were given.`, {
                suggestion: 'Call again with only one of them.'
            });
        }

        if (email !== undefined) {
            const raw = await client.findCustomerByEmail(email);
            if (raw !== undefined) return raw;
            throw new ToolError('NOT_FOUND', `No customer account with email '${email}'.`, {
                suggestion: 'A guest checkout creates no customer account. Use search_orders with this email.'
            });
        }

        if (customerId !== undefined) {
            const raw = await client.getCustomerById(customerId);
            if (raw !== undefined) return raw;
            throw new ToolError('NOT_FOUND', `No customer with ID ${customerId}.`, {
                suggestion: 'Check the ID, or look the customer up by email address instead.'
            });
        }

        throw new ToolError('INVALID_INPUT', `${EXACTLY_ONE} Neither was given.`, {
            suggestion: "Call again with the customer's email address or numeric customer ID."
        });
    }
}

/** "Customer 1: Veronica Costello <roni_cost@example.com>, 1 address." */
function summarize(customer: Customer): string {
    const count = customer.addresses.length;
    const addresses = count === 0 ? 'no addresses' : count === 1 ? '1 address' : `${count} addresses`;
    return `Customer ${customer.id}: ${customer.firstname} ${customer.lastname} <${customer.email}>, ${addresses}.`;
}
