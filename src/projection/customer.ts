/**
 * Customers, reduced to their allowlist in `fields.ts`. Neither `confirmation`,
 * a pending-confirmation token that REST does return, nor any custom attribute
 * is named there, so neither can reach the model.
 */
import type { RawCustomer, RawCustomerAddress } from '../magento/raw-types.js';
import { projectAddress } from './address.js';
import type { Customer, CustomerAddress } from './fields.js';
import { present, utcTimestamp } from './values.js';

export function projectCustomer(raw: RawCustomer): Customer {
    return {
        id: raw.id,
        email: raw.email,
        firstname: raw.firstname,
        lastname: raw.lastname,
        createdAt: utcTimestamp(raw.created_at),
        groupId: raw.group_id,
        addresses: (raw.addresses ?? []).map(projectCustomerAddress)
    };
}

/**
 * The address's own `default_billing`/`default_shipping` booleans, rather than
 * the customer-level fields, which hold address IDs as strings.
 */
function projectCustomerAddress(raw: RawCustomerAddress): CustomerAddress {
    return {
        ...projectAddress(raw, raw.region?.region),
        defaultBilling: present(raw.default_billing),
        defaultShipping: present(raw.default_shipping)
    };
}
