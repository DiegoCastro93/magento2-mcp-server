/**
 * The pagination envelope of a search result, and the notice that says a page
 * is not the whole answer — the first of the two kinds of truncation the
 * projection layer announces.
 */
import * as z from 'zod';

/**
 * The paging every search tool accepts. The cap on `pageSize` is part of the
 * schema, so the model reads the bound instead of being silently clamped to it.
 */
export const PAGING_INPUT = {
    page: z.number().int().min(1).default(1),
    pageSize: z.number().int().min(1).max(50).default(20)
};

export const PaginationSchema = z.strictObject({
    page: z.number().int(),
    pageSize: z.number().int(),
    totalCount: z.number().int(),
    totalPages: z.number().int(),
    hasMore: z.boolean()
});

export type Pagination = z.infer<typeof PaginationSchema>;

/** What a search tool lists, in the plural. */
export type ListedNoun = 'products' | 'orders';

const SINGULAR = { products: 'product', orders: 'order' } as const satisfies Record<ListedNoun, string>;

/** @param totalCount the size of the full match, as Magento reports it, not of this page. */
export function paginate(input: {
    readonly totalCount: number;
    readonly page: number;
    readonly pageSize: number;
}): Pagination {
    const { totalCount, page, pageSize } = input;
    const totalPages = Math.ceil(totalCount / pageSize);
    return { page, pageSize, totalCount, totalPages, hasMore: page < totalPages };
}

/**
 * The sentence for a page that is not the whole answer, or `undefined` for the
 * last page and for no match at all, where the list itself is the answer.
 * Every page before the last one is full, so it shows `pageSize` results.
 */
export function paginationNotice(pagination: Pagination, noun: ListedNoun): string | undefined {
    const { page, pageSize, totalCount, totalPages, hasMore } = pagination;

    if (totalCount === 0) return undefined;
    if (page > totalPages) {
        const pages = totalPages === 1 ? '1 page' : `${totalPages} pages`;
        return `Page ${page} is past the end: ${matches(totalCount, noun)}, in ${pages}.`;
    }
    if (!hasMore) return undefined;

    return (
        `Showing ${pageSize} of ${totalCount} ${noun} (page ${page} of ${totalPages}). ` +
        `Narrow the filters or request page ${page + 1}.`
    );
}

/** A search tool's one-line summary: "No products match.", "1 product matches." or "6 products match." */
export function matchSummary(totalCount: number, noun: ListedNoun): string {
    return totalCount === 0 ? `No ${noun} match.` : `${matches(totalCount, noun)}.`;
}

function matches(totalCount: number, noun: ListedNoun): string {
    return totalCount === 1 ? `1 ${SINGULAR[noun]} matches` : `${totalCount} ${noun} match`;
}
