import { describe, expect, it } from 'vitest';
import { paginate, paginationNotice, PaginationSchema } from '../../src/shared/pagination.js';

describe('paginate', () => {
    it('derives the page count and whether more pages follow', () => {
        const pagination = paginate({ totalCount: 3412, page: 1, pageSize: 20 });

        expect(pagination).toEqual({ page: 1, pageSize: 20, totalCount: 3412, totalPages: 171, hasMore: true });
        expect(PaginationSchema.safeParse(pagination).success).toBe(true);
    });

    it('has no more pages at an exact multiple', () => {
        expect(paginate({ totalCount: 40, page: 2, pageSize: 20 })).toMatchObject({ totalPages: 2, hasMore: false });
        expect(paginate({ totalCount: 40, page: 1, pageSize: 20 })).toMatchObject({ totalPages: 2, hasMore: true });
    });

    it('counts no pages for no match', () => {
        expect(paginate({ totalCount: 0, page: 1, pageSize: 20 })).toMatchObject({ totalPages: 0, hasMore: false });
    });
});

describe('paginationNotice', () => {
    it('says how much is shown, and how to see more', () => {
        expect(paginationNotice(paginate({ totalCount: 3412, page: 1, pageSize: 20 }), 'products')).toBe(
            'Showing 20 of 3412 products (page 1 of 171). Narrow the filters or request page 2.'
        );
    });

    it('says nothing on the last page, full or not', () => {
        expect(paginationNotice(paginate({ totalCount: 45, page: 3, pageSize: 20 }), 'orders')).toBeUndefined();
        expect(paginationNotice(paginate({ totalCount: 40, page: 2, pageSize: 20 }), 'orders')).toBeUndefined();
        expect(paginationNotice(paginate({ totalCount: 5, page: 1, pageSize: 20 }), 'orders')).toBeUndefined();
    });

    it('says nothing when nothing matches: the empty list is the answer', () => {
        expect(paginationNotice(paginate({ totalCount: 0, page: 1, pageSize: 20 }), 'products')).toBeUndefined();
    });

    it('says when a page is past the end, and how far the match goes', () => {
        expect(paginationNotice(paginate({ totalCount: 3412, page: 200, pageSize: 20 }), 'products')).toBe(
            'Page 200 is past the end: 3412 products match, in 171 pages.'
        );
        expect(paginationNotice(paginate({ totalCount: 1, page: 2, pageSize: 20 }), 'orders')).toBe(
            'Page 2 is past the end: 1 order matches, in 1 page.'
        );
    });
});
