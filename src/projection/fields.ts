/**
 * The allowlists: one strict zod schema per projection.
 *
 * A field reaches the model only if it is named here. Each schema is the one
 * source for a projection's keys, for its value types (`z.infer`) and for the
 * tool's `outputSchema`, so a field cannot be added in one
 * of those places and forgotten in another, and cannot leak in through a
 * spread. Every object is strict: the JSON Schema the model reads says
 * `additionalProperties: false`, and the SDK's output validation refuses a
 * stray key instead of passing it through.
 *
 * Nothing here names `entity_id`, `protect_code`, `confirmation`,
 * `custom_attributes` or an order address's `email`, so none of them can reach
 * the output.
 *
 * Descriptions are attached only where a value is not self-explanatory; they
 * reach the model through `outputSchema`, and every word of them is paid for.
 */
import * as z from 'zod';

/** Per-field limits, in characters, for the free text that can run long. */
export const TEXT_LIMITS = {
    shortDescription: 300,
    description: 1000,
    comment: 500
} as const;

/**
 * How many status-history entries `get_order` returns. Magento prepends each
 * new entry, so these are the most recent, which is all a retry check needs.
 */
export const MAX_ORDER_COMMENTS = 10;

export const ProductSummarySchema = z.strictObject({
    sku: z.string(),
    name: z.string(),
    price: z.number().optional().describe('Absent for a type priced by its children, such as grouped.'),
    status: z.enum(['enabled', 'disabled']),
    type: z.string().describe('The Magento product type, such as simple, configurable, grouped or bundle.')
});

export const ProductDetailSchema = ProductSummarySchema.extend({
    weight: z.number().optional(),
    urlKey: z.string().optional(),
    shortDescription: z.string().optional(),
    description: z.string().optional(),
    categoryIds: z.array(z.number().int()).optional(),
    specialPrice: z
        .number()
        .optional()
        .describe(
            "Applies while the store's date is within specialFromDate and specialToDate, where set; Magento then " +
                'charges the lower of this and price.'
        ),
    specialFromDate: z.string().optional().describe("YYYY-MM-DD in the store's time zone."),
    specialToDate: z.string().optional().describe("YYYY-MM-DD in the store's time zone."),
    countryOfManufacture: z.string().optional().describe('ISO 3166-1 alpha-2 code.'),
    createdAt: z.string(),
    updatedAt: z.string()
});

/**
 * Stock at the configured source and stock. Every field but `sourceCode` is
 * optional: each comes from its own upstream call, and one failing must not
 * take the others with it. The tool's notice says why a field is missing, so
 * an absent quantity is never read as zero.
 */
export const StockDetailSchema = z.strictObject({
    sourceCode: z.string(),
    sourceQuantity: z.number().optional().describe('On-hand quantity at sourceCode.'),
    sourceStatus: z.enum(['in_stock', 'out_of_stock']).optional(),
    salableQuantity: z
        .number()
        .optional()
        .describe('What the configured stock can still sell: on-hand minus open order reservations, never below 0.'),
    isSalable: z.boolean().optional(),
    manageStock: z
        .boolean()
        .optional()
        .describe('False means Magento does not track or enforce quantity for this product.')
});

/** `get_product`'s `outputSchema`. */
export const GetProductOutputSchema = z.strictObject({
    product: ProductDetailSchema,
    stock: StockDetailSchema,
    notice: z.string().optional()
});

export const AddressSchema = z.strictObject({
    firstname: z.string(),
    lastname: z.string(),
    company: z.string().optional(),
    street: z.array(z.string()),
    city: z.string(),
    region: z.string().optional(),
    postcode: z.string().optional(),
    countryId: z.string(),
    telephone: z.string().optional()
});

export const CustomerAddressSchema = AddressSchema.extend({
    defaultBilling: z.boolean().optional(),
    defaultShipping: z.boolean().optional()
});

export const OrderSummarySchema = z.strictObject({
    incrementId: z.string(),
    status: z.string(),
    state: z.string(),
    createdAt: z.string(),
    customerEmail: z.string(),
    customerName: z.string().optional(),
    grandTotal: z.number(),
    currency: z.string(),
    itemCount: z.number().int().describe('Order lines, not units: a line ordered with qty 3 counts once.')
});

export const OrderItemSchema = z.strictObject({
    sku: z.string(),
    name: z.string(),
    qty: z.number(),
    price: z.number(),
    rowTotal: z.number()
});

export const OrderCommentSchema = z.strictObject({
    createdAt: z.string(),
    comment: z.string().optional(),
    status: z.string().optional(),
    customerNotified: z.boolean().optional(),
    visibleOnFront: z.boolean()
});

export const OrderDetailSchema = OrderSummarySchema.extend({
    shippingMethod: z
        .strictObject({ code: z.string().optional(), title: z.string().optional() })
        .optional()
        .describe('Absent for an order with nothing to ship.'),
    paymentMethod: z.strictObject({ code: z.string(), title: z.string().optional() }).optional(),
    billingAddress: AddressSchema.optional(),
    shippingAddress: AddressSchema.optional(),
    items: z.array(OrderItemSchema),
    totals: z.strictObject({
        subtotal: z.number(),
        shipping: z.number().optional(),
        tax: z.number().optional(),
        discount: z.number().optional().describe("Zero or negative: Magento's own sign."),
        grandTotal: z.number()
    }),
    comments: z.array(OrderCommentSchema).describe('The status history, newest first.')
});

export const CustomerSchema = z.strictObject({
    id: z.number().int(),
    email: z.string(),
    firstname: z.string(),
    lastname: z.string(),
    createdAt: z.string(),
    groupId: z.number().int().describe("Magento's numeric customer group ID; group names are not resolved."),
    addresses: z.array(CustomerAddressSchema)
});

export type ProductSummary = z.infer<typeof ProductSummarySchema>;
export type ProductDetail = z.infer<typeof ProductDetailSchema>;
export type StockDetail = z.infer<typeof StockDetailSchema>;
export type GetProductOutput = z.infer<typeof GetProductOutputSchema>;
export type Address = z.infer<typeof AddressSchema>;
export type CustomerAddress = z.infer<typeof CustomerAddressSchema>;
export type OrderSummary = z.infer<typeof OrderSummarySchema>;
export type OrderItem = z.infer<typeof OrderItemSchema>;
export type OrderComment = z.infer<typeof OrderCommentSchema>;
export type OrderDetail = z.infer<typeof OrderDetailSchema>;
export type Customer = z.infer<typeof CustomerSchema>;
