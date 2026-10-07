/**
 * Which product types carry stock of their own, shared by the fixture adapter
 * and the tools so the two cannot disagree.
 */

/**
 * Types declared `isQty="true"` in Magento's `product_types.xml`. Only these
 * have source items and a salable quantity; a grouped, configurable or bundle
 * product sells through its children, and Magento refuses a salable-quantity
 * lookup for it with a 400.
 */
const OWN_STOCK_TYPES: ReadonlySet<string> = new Set(['simple', 'virtual', 'downloadable']);

export function hasOwnStock(typeId: string): boolean {
    return OWN_STOCK_TYPES.has(typeId);
}
