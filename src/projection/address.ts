import type { RawOrderAddress } from '../magento/raw-types.js';
import type { Address } from './fields.js';
import { text } from './values.js';

/** The fields an order address and a customer address share, with the same shapes. */
export type RawAddressFields = Pick<
    RawOrderAddress,
    'firstname' | 'lastname' | 'company' | 'street' | 'city' | 'postcode' | 'country_id' | 'telephone'
>;

/**
 * @param region the region's name. REST shapes it differently for the two kinds
 *   of address — a plain string on an order, an object on a customer — so each
 *   caller reads its own.
 */
export function projectAddress(raw: RawAddressFields, region: string | null | undefined): Address {
    return {
        firstname: raw.firstname,
        lastname: raw.lastname,
        company: text(raw.company),
        street: [...raw.street],
        city: raw.city,
        region: text(region),
        postcode: text(raw.postcode),
        countryId: raw.country_id,
        telephone: text(raw.telephone)
    };
}
