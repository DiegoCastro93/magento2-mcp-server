/**
 * `get_product`'s stock, assembled from three independent upstream answers.
 *
 * Each answer may have failed on its own, so every field is optional, and
 * every missing field is explained in the notice: a model that sees no
 * `salableQuantity` and no reason will read it as zero.
 */
import type { ToolError } from '../errors/tool-error.js';
import { SOURCE_ITEM_STATUS } from '../magento/client.js';
import { hasOwnStock } from '../magento/product-types.js';
import type { RawProduct, RawSourceItem } from '../magento/raw-types.js';
import type { StockDetail } from './fields.js';
import type { Notices } from './truncate.js';

/** What one upstream call came to: its answer, or the error the agent would be shown for it. */
export type Outcome<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: ToolError };

export interface StockInputs {
    /** The product as the single GET returned it, `stock_item` included when the ACL allows. */
    readonly product: RawProduct;
    readonly sourceCode: string;
    readonly sourceItem: Outcome<RawSourceItem | undefined>;
    readonly salableQuantity: Outcome<number | undefined>;
    readonly isSalable: Outcome<boolean>;
}

/**
 * Magento's default source (`DefaultSourceProvider::getCode()`). The legacy
 * stock item mirrors this source alone: the sync plugins skip every other.
 */
const DEFAULT_SOURCE_CODE = 'default';

const LIST = new Intl.ListFormat('en', { style: 'long', type: 'conjunction' });

/** @param notices receives one sentence for each field that is missing, and why. */
export function projectStock(inputs: StockInputs, notices: Notices): StockDetail {
    const { product, sourceCode } = inputs;
    // Read in output order, so a notice names lost fields in that order too.
    const failures = new Failures();

    // Its quantities live on its children. Magento answers no source item and
    // refuses salable quantity for it, which is not a failure to report.
    if (!hasOwnStock(product.type_id)) {
        notices.add(
            `A ${product.type_id} product has no stock of its own: quantities are tracked on its children, ` +
                'so only isSalable applies.'
        );
        const isSalable = valueOf(inputs.isSalable, ['isSalable'], failures);
        failures.reportTo(notices);
        return { sourceCode, isSalable };
    }

    const stockItem = product.extension_attributes?.stock_item;
    let sourceQuantity: number | undefined;
    let sourceStatus: StockDetail['sourceStatus'];

    if (inputs.sourceItem.ok) {
        const item = inputs.sourceItem.value;
        if (item === undefined) {
            notices.add(
                `The product is not assigned to source "${sourceCode}", so sourceQuantity and sourceStatus are absent.`
            );
        } else {
            sourceQuantity = item.quantity;
            sourceStatus = item.status === SOURCE_ITEM_STATUS.in_stock ? 'in_stock' : 'out_of_stock';
        }
    } else if (sourceCode === DEFAULT_SOURCE_CODE && stockItem !== undefined) {
        sourceQuantity = stockItem.qty;
        notices.add(
            `${cause('The source item could not be read', inputs.sourceItem.error)} sourceQuantity comes from the ` +
                'legacy stock item instead, and sourceStatus is unknown.'
        );
    } else {
        failures.add(['sourceQuantity', 'sourceStatus'], inputs.sourceItem.error);
    }

    const salableQuantity = valueOf(inputs.salableQuantity, ['salableQuantity'], failures);
    if (inputs.salableQuantity.ok && salableQuantity === undefined) {
        notices.add('salableQuantity is unavailable: Magento reported none for this SKU.');
    }
    const isSalable = valueOf(inputs.isSalable, ['isSalable'], failures);

    if (stockItem === undefined) {
        notices.add(
            "manageStock is unknown: Magento omitted the product's stock item, as it does when the integration " +
                'lacks the Magento_CatalogInventory::cataloginventory resource.'
        );
    }

    failures.reportTo(notices);
    return {
        sourceCode,
        sourceQuantity,
        sourceStatus,
        salableQuantity,
        isSalable,
        manageStock: stockItem?.manage_stock
    };
}

function valueOf<T>(outcome: Outcome<T>, fields: readonly string[], failures: Failures): T | undefined {
    if (outcome.ok) return outcome.value;
    failures.add(fields, outcome.error);
    return undefined;
}

/**
 * Fields lost to a failed call, grouped by error, so three fields lost to one
 * timeout read as one sentence rather than three.
 */
class Failures {
    readonly #groups = new Map<string, { readonly error: ToolError; readonly fields: string[] }>();

    add(fields: readonly string[], error: ToolError): void {
        const key = `${error.code}\u0000${error.message}`;
        const group = this.#groups.get(key);
        if (group === undefined) {
            this.#groups.set(key, { error, fields: [...fields] });
        } else {
            group.fields.push(...fields);
        }
    }

    reportTo(notices: Notices): void {
        for (const { error, fields } of this.#groups.values()) {
            const verb = fields.length === 1 ? 'is' : 'are';
            notices.add(cause(`${LIST.format(fields)} ${verb} unavailable`, error));
        }
    }
}

/** "<what> (<CODE>): <message>", ending as a sentence. */
function cause(what: string, error: ToolError): string {
    const text = `${what} (${error.code}): ${error.message}`;
    return /[.!?]$/.test(text) ? text : `${text}.`;
}
