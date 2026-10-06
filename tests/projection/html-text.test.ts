import { describe, expect, it } from 'vitest';
import { htmlToText } from '../../src/projection/html-text.js';
import { loadProduct } from './fixtures.js';

/** Content as Page Builder saves it: a `<style>` block keyed by `data-pb-style`, then nested rows. */
const PAGE_BUILDER =
    '<style>#html-body [data-pb-style=K8ATB2A]{justify-content:flex-start;display:flex;flex-direction:column;' +
    'background-position:left top;background-size:cover}</style>' +
    '<div data-content-type="row" data-appearance="contained" data-element="main">' +
    '<div data-enable-parallax="0" data-parallax-speed="0.5" data-element="inner" data-pb-style="K8ATB2A">' +
    '<div data-content-type="text" data-appearance="default" data-element="main">' +
    '<p>Soft organic cotton.</p><p>Machine wash cold.</p></div></div></div>';

describe('htmlToText', () => {
    it("drops Page Builder's style block with its CSS, keeping only the text", () => {
        expect(htmlToText(PAGE_BUILDER)).toBe('Soft organic cotton.\nMachine wash cold.');
    });

    it('drops scripts and comments with their contents', () => {
        const html = '<p>Before</p><script type="text/x-magento-init">{"*": {}}</script><!-- note --><p>After</p>';

        expect(htmlToText(html)).toBe('Before\nAfter');
    });

    it('turns list items into dash lines', () => {
        expect(htmlToText('<p>Features:</p><ul><li>Crew neckline.</li><li>Semi-fitted.</li></ul>')).toBe(
            'Features:\n- Crew neckline.\n- Semi-fitted.'
        );
    });

    it('starts a list item on its own line even when nothing closes the text before it', () => {
        expect(htmlToText('Features:<ul><li>Light</li></ul>')).toBe('Features:\n- Light');
    });

    it('breaks lines at <br> and at the end of headings and table rows', () => {
        const html = '<h3>Care</h3>Wash cold<br>Dry flat<br/>Iron low<table><tr><td>L</td><td>29"</td></tr></table>';

        expect(htmlToText(html)).toBe('Care\nWash cold\nDry flat\nIron low\nL 29"');
    });

    it('decodes entities once, so an escaped entity stays escaped', () => {
        expect(htmlToText('5 &lt; 6 &amp; 7 &gt; 3 &quot;ok&quot; &#39;x&#39; &#x2014; caf&#233;')).toBe(
            '5 < 6 & 7 > 3 "ok" \'x\' — café'
        );
        expect(htmlToText('&amp;lt;b&amp;gt;')).toBe('&lt;b&gt;');
    });

    it('keeps escaped markup as text instead of stripping it', () => {
        expect(htmlToText('Use &lt;b&gt; for bold')).toBe('Use <b> for bold');
    });

    it('leaves an unknown entity and an invalid code point as written', () => {
        expect(htmlToText('&bogus; &#0; &#xD800; &#x110000;')).toBe('&bogus; &#0; &#xD800; &#x110000;');
    });

    it('keeps a literal < that does not open a tag', () => {
        expect(htmlToText('<p>a < b and c<d</p>')).toBe('a < b and c<d');
    });

    it('collapses spaces, tabs, non-breaking spaces and blank lines', () => {
        expect(htmlToText('  <p>  One \t two&nbsp;&nbsp;three </p>\r\n\r\n\n<p>Four</p>  ')).toBe(
            'One two three\nFour'
        );
    });

    it("renders 24-MB01's description, whose closing </p> is a second <p>", async () => {
        const product = await loadProduct('24-MB01');
        const html = product.custom_attributes?.find((a) => a.attribute_code === 'description')?.value as string;

        expect(htmlToText(html)).toBe(
            "The sporty Joust Duffle Bag can't be beat - not in the gym, not on the luggage carousel, not anywhere. " +
                'Big enough to haul a basketball or soccer ball and some sneakers with plenty of room to spare, ' +
                "it's ideal for athletes with places to go.\n" +
                '- Dual top handles.\n- Adjustable shoulder strap.\n- Full-length zipper.\n- L 29" x W 13" x H 11".'
        );
    });
});
