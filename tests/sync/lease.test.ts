import { tempLedger, TempLedger } from '../ledger/helpers';
import { acquireLease, releaseLease, leaseHolder, leaseHolderId, LEASE_TTL_MS } from '../../src/sync/lease';

const T0 = Date.parse('2026-09-29T12:00:00.000Z');
const SECOND_MS = 1000;
const iso = (ms: number): string => new Date(ms).toISOString();

describe('the sync lease', () => {
    let ledger: TempLedger;

    beforeEach(() => { ledger = tempLedger(); });
    afterEach(() => ledger.cleanup());

    it('lets exactly one holder in until its lease runs out', () => {
        expect(acquireLease(ledger.db, 'pid:1', T0)).toBe(true);
        expect(acquireLease(ledger.db, 'pid:2', T0 + SECOND_MS)).toBe(false);
        expect(leaseHolder(ledger.db, T0 + SECOND_MS)).toEqual({ holder: 'pid:1', expiresAt: iso(T0 + LEASE_TTL_MS) });
        expect(acquireLease(ledger.db, 'pid:2', T0 + LEASE_TTL_MS + SECOND_MS)).toBe(true);
        expect(leaseHolder(ledger.db, T0 + LEASE_TTL_MS + SECOND_MS)?.holder).toBe('pid:2');
    });

    it('renews for the holder', () => {
        acquireLease(ledger.db, 'pid:1', T0);
        expect(acquireLease(ledger.db, 'pid:1', T0 + 30 * SECOND_MS)).toBe(true);
        expect(leaseHolder(ledger.db, T0 + 30 * SECOND_MS)?.expiresAt).toBe(iso(T0 + 30 * SECOND_MS + LEASE_TTL_MS));
    });

    it('releases only its own lease', () => {
        acquireLease(ledger.db, 'pid:1', T0);
        releaseLease(ledger.db, 'pid:2');
        expect(leaseHolder(ledger.db, T0)?.holder).toBe('pid:1');
        releaseLease(ledger.db, 'pid:1');
        expect(leaseHolder(ledger.db, T0)).toBeUndefined();
    });

    it('reports nobody once the lease has run out', () => {
        acquireLease(ledger.db, 'pid:1', T0);
        expect(leaseHolder(ledger.db, T0 + LEASE_TTL_MS + SECOND_MS)).toBeUndefined();
    });

    it('names a holder by process id and a start nonce, so a reused pid is a different holder', () => {
        expect(leaseHolderId(1234)).toMatch(/^pid:1234:[0-9a-f]{8}$/);
        expect(leaseHolderId(1234)).toBe(leaseHolderId(1234));
    });
});
