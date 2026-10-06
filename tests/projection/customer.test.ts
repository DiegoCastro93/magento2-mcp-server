import { describe, expect, it } from 'vitest';
import { projectCustomer } from '../../src/projection/customer.js';
import { CustomerSchema } from '../../src/projection/fields.js';
import { loadCustomer, wire } from './fixtures.js';

describe('projectCustomer', () => {
    it('keeps exactly the allowlist', async () => {
        const customer = wire(projectCustomer(await loadCustomer(1)));

        expect(customer).toStrictEqual({
            id: 1,
            email: 'roni_cost@example.com',
            firstname: 'Veronica',
            lastname: 'Costello',
            createdAt: '2026-09-24T04:18:51Z',
            groupId: 1,
            addresses: [
                {
                    firstname: 'Veronica',
                    lastname: 'Costello',
                    street: expect.any(Array),
                    city: expect.any(String),
                    region: 'Michigan',
                    postcode: expect.any(String),
                    countryId: 'US',
                    telephone: expect.any(String),
                    defaultBilling: true,
                    defaultShipping: true
                }
            ]
        });
        expect(CustomerSchema.safeParse(customer).success).toBe(true);
    });

    it('drops the confirmation token and every custom attribute', async () => {
        const raw = await loadCustomer(2);
        const confirmation = (raw as unknown as { confirmation: string }).confirmation;
        const json = JSON.stringify(projectCustomer(raw));

        expect(confirmation).toMatch(/\w{6,}/);
        expect(raw.custom_attributes).toEqual([{ attribute_code: 'loyalty_tier', value: 'gold' }]);
        expect(json).not.toContain(confirmation);
        expect(json).not.toMatch(/confirmation|loyalty_tier|gold|custom_attributes|is_subscribed|website_id/);
    });

    it('flattens the region object to its name, and keeps a second street line', async () => {
        const [address] = projectCustomer(await loadCustomer(2)).addresses;

        expect(address).toMatchObject({ street: ['1200 Barton Springs Rd', 'Apt 4B'], region: 'Texas' });
    });
});
