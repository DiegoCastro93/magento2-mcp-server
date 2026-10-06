/**
 * The allowlists double as increment 5's `outputSchema`. These specs pin what
 * the model will read in `tools/list`: no object, at any depth, admits a key
 * that is not named.
 */
import { describe, expect, it } from 'vitest';
import * as z from 'zod';
import {
    CustomerSchema,
    OrderDetailSchema,
    OrderSummarySchema,
    ProductDetailSchema,
    ProductSummarySchema
} from '../../src/projection/fields.js';
import { PaginationSchema } from '../../src/shared/pagination.js';

const SCHEMAS = {
    ProductSummarySchema,
    ProductDetailSchema,
    OrderSummarySchema,
    OrderDetailSchema,
    CustomerSchema,
    PaginationSchema
};

type JsonSchema = Record<string, unknown>;

/** Every object node in a JSON Schema, with the path that reaches it. */
function objectNodes(node: unknown, path = '$'): [string, JsonSchema][] {
    if (typeof node !== 'object' || node === null) return [];
    const schema = node as JsonSchema;
    const found: [string, JsonSchema][] = schema['type'] === 'object' ? [[path, schema]] : [];

    for (const [key, child] of Object.entries(schema)) {
        if (key === 'properties' || key === '$defs') {
            for (const [name, sub] of Object.entries(child as JsonSchema)) {
                found.push(...objectNodes(sub, `${path}.${name}`));
            }
        } else if (key === 'items' || key === 'additionalProperties') {
            found.push(...objectNodes(child, `${path}[]`));
        } else if (key === 'anyOf' || key === 'oneOf' || key === 'allOf') {
            (child as unknown[]).forEach((sub, i) => found.push(...objectNodes(sub, `${path}|${i}`)));
        }
    }
    return found;
}

describe('allowlist schemas', () => {
    it.each(Object.entries(SCHEMAS))('%s closes every object to unnamed keys', (_, schema) => {
        const nodes = objectNodes(z.toJSONSchema(schema, { io: 'output' }));

        expect(nodes.length).toBeGreaterThan(0);
        for (const [path, node] of nodes) {
            expect({ path, additionalProperties: node['additionalProperties'] }).toEqual({
                path,
                additionalProperties: false
            });
        }
    });

    it('reaches the nested objects of an order', () => {
        const paths = objectNodes(z.toJSONSchema(OrderDetailSchema, { io: 'output' })).map(([path]) => path);

        expect(paths).toEqual(
            expect.arrayContaining([
                '$',
                '$.shippingMethod',
                '$.paymentMethod',
                '$.billingAddress',
                '$.shippingAddress',
                '$.items[]',
                '$.totals',
                '$.comments[]'
            ])
        );
    });

    it('refuses a key outside the allowlist at any depth', () => {
        const order = {
            incrementId: '000000001',
            status: 'complete',
            state: 'complete',
            createdAt: '2026-03-01T10:00:00Z',
            customerEmail: 'roni_cost@example.com',
            grandTotal: 59,
            currency: 'USD',
            itemCount: 1,
            items: [],
            totals: { subtotal: 54, grandTotal: 59 },
            comments: []
        };

        expect(OrderDetailSchema.safeParse(order).success).toBe(true);
        expect(OrderDetailSchema.safeParse({ ...order, entity_id: 1 }).success).toBe(false);
        const totals = { ...order.totals, base_grand_total: 59 };
        expect(OrderDetailSchema.safeParse({ ...order, totals }).success).toBe(false);
    });

    it('carries field descriptions into the JSON Schema the model reads', () => {
        const schema = z.toJSONSchema(OrderSummarySchema, { io: 'output' }) as {
            properties: Record<string, { description?: string }>;
        };

        expect(schema.properties['itemCount']?.description).toMatch(/lines, not units/);
    });
});
