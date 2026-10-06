/**
 * Products, reduced to their allowlists in `fields.ts`.
 *
 * Of the custom attributes, only core ones whose values explain themselves are
 * read. Select and multiselect attributes such as `color`, `size` and
 * `material` hold option IDs (`"56"`, `"33,35,160"`), which mean nothing to an
 * agent and would invite it to guess; their labels need a call per attribute
 * and an ACL that projection, being pure, cannot use.
 */
import type { RawProduct } from '../magento/raw-types.js';
import { TEXT_LIMITS, type ProductDetail, type ProductSummary } from './fields.js';
import type { Notices } from './truncate.js';
import { calendarDate, decimal, htmlField, present, text, utcTimestamp } from './values.js';

const CATEGORY_ID = /^\d+$/;

export function projectProductSummary(raw: RawProduct): ProductSummary {
    return {
        sku: raw.sku,
        name: raw.name,
        price: present(raw.price),
        // The status attribute has two options: 1 enabled, 2 disabled.
        status: raw.status === 1 ? 'enabled' : 'disabled',
        type: raw.type_id
    };
}

/** @param notices receives a sentence for each description that was cut. */
export function projectProductDetail(raw: RawProduct, notices: Notices): ProductDetail {
    const attributes = new Map((raw.custom_attributes ?? []).map((a) => [a.attribute_code, a.value]));

    return {
        ...projectProductSummary(raw),
        weight: present(raw.weight),
        urlKey: text(attributes.get('url_key')),
        shortDescription: htmlField(
            attributes.get('short_description'),
            TEXT_LIMITS.shortDescription,
            'shortDescription',
            notices
        ),
        description: htmlField(attributes.get('description'), TEXT_LIMITS.description, 'description', notices),
        categoryIds: categoryIds(attributes.get('category_ids')),
        specialPrice: decimal(attributes.get('special_price')),
        specialFromDate: calendarDate(attributes.get('special_from_date')),
        specialToDate: calendarDate(attributes.get('special_to_date')),
        countryOfManufacture: text(attributes.get('country_of_manufacture')),
        createdAt: utcTimestamp(raw.created_at),
        updatedAt: utcTimestamp(raw.updated_at)
    };
}

/**
 * `category_ids` arrives as a list of strings, although each names a numeric
 * ID; as numbers they match `search_products`' `categoryId` input. Anything
 * else is dropped whole rather than in part, since a partial list would read as
 * complete.
 */
function categoryIds(value: unknown): number[] | undefined {
    if (!Array.isArray(value)) return undefined;
    const ids: number[] = [];
    for (const id of value as unknown[]) {
        if (typeof id === 'string' && CATEGORY_ID.test(id)) ids.push(Number(id));
        else if (typeof id === 'number' && Number.isSafeInteger(id)) ids.push(id);
        else return undefined;
    }
    return ids;
}
