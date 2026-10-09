/**
 * `search_products`: a page of product summaries matching the filters.
 *
 * The price range is checked here rather than with a zod `.refine`: a refine
 * is absent from the JSON Schema the model reads, and when it fails the SDK
 * answers with its own text, outside the error envelope and unlogged.
 */
import * as z from 'zod';
import { ToolError } from '../../errors/tool-error.js';
import { SearchProductsOutputSchema, type SearchProductsOutput } from '../../projection/fields.js';
import { projectProductSummary } from '../../projection/product.js';
import { matchSummary, PAGING_INPUT, paginate, paginationNotice } from '../../shared/pagination.js';
import { answerText, READ_ANNOTATIONS, READ_RETRY, type ToolDefinition, type ToolDeps } from '../definition.js';

const DESCRIPTION =
    'Search the Magento catalog and return a compact page of matching products. Every result is reduced to an ' +
    'allowlisted set of fields — call get_product for full detail and live stock on a single SKU. Combine filters ' +
    'to narrow the result set; with no filters this returns the most recently created products, not the whole ' +
    'catalog. Capped at 50 results per call.';

const NO_PRICE = 'A product priced by its children, such as a grouped product, never matches a price filter.';

const SearchProductsInputSchema = z.object({
    name: z.string().min(2).optional().describe('Case-insensitive substring of the product name.'),
    sku: z
        .string()
        .min(1)
        .optional()
        .describe('Case-insensitive substring of the SKU. For one exact SKU, call get_product.'),
    categoryId: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('Products assigned directly to this category; those only in its subcategories are not included.'),
    priceMin: z
        .number()
        .nonnegative()
        .optional()
        .describe(`Inclusive. Must not be greater than priceMax. ${NO_PRICE}`),
    priceMax: z.number().nonnegative().optional().describe(`Inclusive. ${NO_PRICE}`),
    ...PAGING_INPUT
});

export function defineSearchProducts(
    deps: ToolDeps
): ToolDefinition<typeof SearchProductsInputSchema, typeof SearchProductsOutputSchema> {
    const { client } = deps;

    return {
        name: 'search_products',
        description: DESCRIPTION,
        inputSchema: SearchProductsInputSchema,
        outputSchema: SearchProductsOutputSchema,
        annotations: READ_ANNOTATIONS,
        retry: READ_RETRY,

        async handler(input) {
            const { priceMin, priceMax, page, pageSize } = input;
            // Presence is `!== undefined`: a truthiness test would let { priceMin: 5, priceMax: 0 } through.
            if (priceMin !== undefined && priceMax !== undefined && priceMin > priceMax) {
                throw new ToolError('INVALID_INPUT', `priceMin (${priceMin}) is greater than priceMax (${priceMax}).`, {
                    suggestion: 'Swap the two values, or drop one of them to leave that end of the range open.'
                });
            }

            const result = await client.searchProducts(input);
            const pagination = paginate({ totalCount: result.total_count, page, pageSize });
            const notice = paginationNotice(pagination, 'products');

            const structuredContent: SearchProductsOutput = {
                products: result.items.map((raw) => projectProductSummary(raw)),
                pagination,
                notice
            };
            return { structuredContent, text: answerText(matchSummary(result.total_count, 'products'), notice) };
        }
    };
}
