import { describe, expect, it } from 'vitest';
import type { RawProduct } from '../../src/magento/raw-types.js';
import { ProductDetailSchema, ProductSummarySchema, TEXT_LIMITS } from '../../src/projection/fields.js';
import { projectProductDetail, projectProductSummary } from '../../src/projection/product.js';
import { Notices, TRUNCATION_MARKER } from '../../src/projection/truncate.js';
import { loadProduct, wire } from './fixtures.js';

/**
 * The byte ceiling for one full page of `search_products`: 50 summaries
 * measured at 5,141 bytes when it was set, plus about 20% headroom. A field
 * added to the summary has to raise it on purpose.
 */
const SEARCH_PAGE_BYTE_CEILING = 6_200;

/**
 * The ceiling for the largest fixture's detail, measured at 1,641 bytes against
 * 6,852 raw. The two descriptions at their limits are most of it.
 */
const DETAIL_BYTE_CEILING = 2_000;

function withAttributes(raw: RawProduct, attributes: Record<string, unknown>): RawProduct {
    const kept = (raw.custom_attributes ?? []).filter((a) => !(a.attribute_code in attributes));
    const added = Object.entries(attributes).map(([attribute_code, value]) => ({ attribute_code, value }));
    return { ...raw, custom_attributes: [...kept, ...added] };
}

describe('projectProductSummary', () => {
    it('keeps exactly the summary allowlist', async () => {
        const summary = wire(projectProductSummary(await loadProduct('24-MB01')));

        expect(summary).toStrictEqual({
            sku: '24-MB01',
            name: 'Joust Duffle Bag',
            price: 34,
            status: 'enabled',
            type: 'simple'
        });
        expect(ProductSummarySchema.safeParse(summary).success).toBe(true);
    });

    it('leaves price absent for a grouped product, which Magento prices by its children', async () => {
        const summary = wire(projectProductSummary(await loadProduct('24-WG085_Group')));

        expect(summary).not.toHaveProperty('price');
        expect(summary.type).toBe('grouped');
        expect(ProductSummarySchema.safeParse(summary).success).toBe(true);
    });

    it('reads status 2 as disabled', async () => {
        const raw = await loadProduct('24-MB01');

        expect(projectProductSummary({ ...raw, status: 2 }).status).toBe('disabled');
    });

    it('keeps a full page of 50 results under the byte ceiling', async () => {
        const raw = await loadProduct('WS12-M-Orange');
        const page = Array.from({ length: 50 }, (_, i) => projectProductSummary({ ...raw, sku: `${raw.sku}-${i}` }));

        expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(SEARCH_PAGE_BYTE_CEILING);
    });
});

describe('projectProductDetail', () => {
    it('reduces the 32-attribute fixture to the allowlist', async () => {
        const raw = await loadProduct('WS12-M-Orange');
        const detail = wire(projectProductDetail(raw, new Notices()));

        expect(raw.custom_attributes).toHaveLength(32);
        expect(Object.keys(detail)).toEqual([
            'sku',
            'name',
            'price',
            'status',
            'type',
            'weight',
            'urlKey',
            'shortDescription',
            'description',
            'categoryIds',
            'countryOfManufacture',
            'createdAt',
            'updatedAt'
        ]);
        expect(ProductDetailSchema.safeParse(detail).success).toBe(true);
        expect(Buffer.byteLength(JSON.stringify(detail))).toBeLessThan(DETAIL_BYTE_CEILING);
    });

    it('drops select attributes, whose values are option IDs, and every other unlisted attribute', async () => {
        const json = JSON.stringify(projectProductDetail(await loadProduct('WS12-M-Orange'), new Notices()));

        for (const code of ['color', 'size', 'material', 'climate', 'pattern', 'swatch_image', 'news_from_date']) {
            expect(json).not.toContain(`"${code}"`);
        }
        expect(json).not.toMatch(/meta_|external_review_summary|acme-reviews/);
    });

    it('reads url_key, category_ids, weight and country_of_manufacture', async () => {
        const detail = projectProductDetail(await loadProduct('WS12-M-Orange'), new Notices());

        expect(detail).toMatchObject({
            urlKey: 'radiant-tee-m-orange',
            categoryIds: [25, 33, 35, 2],
            weight: 1,
            countryOfManufacture: 'US',
            createdAt: '2025-11-15T10:00:00Z',
            updatedAt: '2025-11-15T10:00:00Z'
        });
    });

    it('reads the special price as a number and its dates as calendar dates', async () => {
        const detail = projectProductDetail(await loadProduct('24-MB04'), new Notices());

        expect(detail.specialPrice).toBe(32);
        expect(detail.specialFromDate).toBe('2026-09-23');
        expect(detail.specialToDate).toBeUndefined();
    });

    it('drops a special price or date it cannot read', async () => {
        const raw = withAttributes(await loadProduct('24-MB04'), {
            special_price: 'n/a',
            special_from_date: '23/09/2026',
            special_to_date: null
        });
        const detail = wire(projectProductDetail(raw, new Notices()));

        expect(detail).not.toHaveProperty('specialPrice');
        expect(detail).not.toHaveProperty('specialFromDate');
        expect(detail).not.toHaveProperty('specialToDate');
    });

    it('drops category_ids whole when any element is not an ID', async () => {
        const raw = withAttributes(await loadProduct('24-MB01'), { category_ids: ['3', 'sale'] });

        expect(wire(projectProductDetail(raw, new Notices()))).not.toHaveProperty('categoryIds');
    });

    it('gives the descriptions as plain text, cut to their limits, and says so', async () => {
        const notices = new Notices();
        const detail = projectProductDetail(await loadProduct('WS12-M-Orange'), notices);

        expect(detail.description).not.toMatch(/<|data-|class=/);
        expect(Array.from(detail.description ?? '')).toHaveLength(TEXT_LIMITS.description + TRUNCATION_MARKER.length);
        expect(detail.description?.endsWith(TRUNCATION_MARKER)).toBe(true);
        expect(detail.shortDescription?.endsWith(TRUNCATION_MARKER)).toBe(true);
        expect(notices.toNotice()).toBe(
            'shortDescription was truncated to 300 characters. description was truncated to 1000 characters.'
        );
    });

    it('leaves a short description whole, with no notice', async () => {
        const notices = new Notices();
        const detail = wire(projectProductDetail(await loadProduct('24-MG03'), notices));

        expect(detail.description).not.toContain(TRUNCATION_MARKER);
        expect(detail).not.toHaveProperty('shortDescription');
        expect(notices.toNotice()).toBeUndefined();
    });

    it('leaves a description absent when no text remains without its markup', async () => {
        const raw = withAttributes(await loadProduct('24-MB01'), { description: '<p> </p><style>p{}</style>' });

        expect(wire(projectProductDetail(raw, new Notices()))).not.toHaveProperty('description');
    });
});
