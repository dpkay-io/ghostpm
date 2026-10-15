import { hasMarker, idempotencyMarker, stripMarkers, toHtmlMarkers } from '../../src/sync/vendor';

const NONCE = '0123456789abcdef';
const comment = idempotencyMarker(NONCE);
const span = `<span style="display:none">ghostpm:${NONCE}</span>`;
const sanitised = `<span style="display:none;">ghostpm:${NONCE}</span>`;

describe('idempotency markers', () => {
    it('keeps the comment form for GitHub', () => {
        expect(comment).toBe(`<!-- ghostpm:${NONCE} -->`);
    });

    it.each([comment, span, sanitised, `<SPAN style = "display: none ;">ghostpm:${NONCE} </span>`])('strips %s with the whitespace before it', form => {
        expect(stripMarkers(`body\n\n${form}`)).toBe('body');
        expect(stripMarkers(`a\n\n${form}b\n\n${form}`)).toBe('ab');
    });

    it('leaves look-alikes alone', () => {
        const other = '<span style="color:red">ghostpm:0123456789abcdef</span> <span style="display:none">ghostpm:xyz</span>';
        expect(stripMarkers(other)).toBe(other);
    });

    it('rewrites only comment-form markers to the span form', () => {
        expect(toHtmlMarkers(`x\n\n${comment}`)).toBe(`x\n\n${span}`);
        expect(toHtmlMarkers(`x ${sanitised}`)).toBe(`x ${sanitised}`);
        expect(toHtmlMarkers('plain')).toBe('plain');
    });

    it('matches a marker by nonce in either form', () => {
        for (const form of [comment, span, sanitised]) expect(hasMarker(`<div>x</div><div>${form}</div>`, comment)).toBe(true);
        expect(hasMarker(sanitised, idempotencyMarker('ffffffffffffffff'))).toBe(false);
        expect(hasMarker('nothing', comment)).toBe(false);
    });
});
