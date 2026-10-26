import { test, expect } from 'bun:test';
import { validateConfig, safeName, routePatterns } from './../src/config';
import { datesInText, validatedDate, validatedSender, targetName, sanitizeStem } from '../src/naming';
import { baseJson, defaultConfig as config } from './helpers';

const route = (id: string) => config.routes.find(r => r.id === id)!;
test('default config validates and carries the Notion Tier-1 patterns', () => {
 expect(config.routes.length).toBe(5);
 expect(route('uni').patterns[0]).toBe('VO\\s+\\d{3}\\.\\d{3}|UE\\s+\\d{3}\\.\\d{3}|JKU');
 expect(route('invoices').patterns[0]).toBe('Rechnung|Invoice|IBAN|ATU\\d{8}|Betrag|Zahlungsziel');
 expect(route('contracts').patterns[0]).toBe('Vertrag|Polizze|Versicherung|Mietvertrag');
 expect(route('dev').patterns[0]).toBe('github\\.com|repository|architecture|schema');
 expect(config.daemon.apply).toBe(false);
 expect(config.naming.datePrefix).toBe(false);
 expect(routePatterns(route('invoices'))[0]!.test('Zahlungsziel: 14 Tage')).toBe(true);
});
for (const folder of ['../oops', '/tmp/oops', '_Archiv/anything', '01_Uni/../Shortcuts', '01_Uni/.secret', '01_Uni/a\\b', '01_Uni/a~b', 'Pages/x'])
 test(`reject route traversal or protected bucket: ${folder}`, () => expect(() => validateConfig({ ...baseJson, routes: [{ ...baseJson.routes[0], folder }] })).toThrow());
test('reject duplicate route IDs', () => expect(() => validateConfig({ ...baseJson, routes: [baseJson.routes[0], baseJson.routes[0]] })).toThrow());
test('reject rename outside invoices/contracts', () => expect(() => validateConfig({ ...baseJson, routes: [{ ...baseJson.routes[0], rename: true, docType: 'X' }] })).toThrow());
test('reject unknown keys, bad regex, bad numbers', () => {
 expect(() => validateConfig({ ...baseJson, daemonn: {} })).toThrow();
 expect(() => validateConfig({ ...baseJson, routes: [{ ...baseJson.routes[0], patterns: ['('] }] })).toThrow();
 expect(() => validateConfig({ ...baseJson, debounceMs: -1 })).toThrow();
 expect(() => validateConfig({ ...baseJson, daemon: { apply: 'yes' } })).toThrow();
});
for (const name of ['../evil.pdf', '.hidden.pdf', 'x/y.pdf', 'x\\y.pdf', 'x\u0000.pdf', 'x:evil.pdf', ' foo.pdf']) test(`reject unsafe filename ${JSON.stringify(name)}`, () => expect(safeName(name)).toBe(false));
test('allow Unicode filename', () => expect(safeName('ÖGK Rechnung.pdf')).toBe(true));

test('dates: DE/EN formats found in text', () => {
 const d = datesInText('Rechnungsdatum: 03.10.2026, fällig 17. Oktober 2026, issued October 20, 2026, 5 Nov 2026, ISO 2026-12-01, 25/12/2026, 3.4.26');
 for (const x of ['2026-10-03', '2026-10-17', '2026-10-20', '2026-11-05', '2026-12-01', '2026-12-25', '2026-04-03']) expect(d.has(x)).toBe(true);
});
test('dates: ambiguous slash dates and impossible dates are not accepted', () => {
 expect(datesInText('03/10/2026').size).toBe(0);
 expect(datesInText('31.02.2026 and 99.99.2026').size).toBe(0);
});
test('validatedDate requires the date to be in the text', () => {
 expect(validatedDate('2026-10-03', 'Datum 03.10.2026')).toBe('2026-10-03');
 expect(validatedDate('2026-10-04', 'Datum 03.10.2026')).toBeNull();
 expect(validatedDate('03.10.2026', 'Datum 03.10.2026')).toBeNull();
 expect(validatedDate(null, 'x')).toBeNull();
});
test('validatedSender requires verbatim presence and sanitizes', () => {
 expect(validatedSender('Drei', 'Hutchison Drei Austria\nRechnung')).toBe('Drei');
 expect(validatedSender('A1 Telekom Austria AG', 'A1  Telekom Austria AG, Lassallestraße')).toBe('A1-Telekom-Austria');
 expect(validatedSender('Magenta', 'Drei Rechnung')).toBeNull();
 expect(validatedSender('Dre', 'Drei Rechnung')).toBeNull(); // not word-bounded
 for (const bad of ['../../etc', 'a/b', 'x\u0000y', 'Drei; rm -rf', '']) expect(validatedSender(bad, `${bad} Drei`)).toBeNull();
});
const inv = { filename: 'scan0042.pdf', text: 'Drei Rechnung vom 03.10.2026', route: route('invoices'), documentDate: '2026-10-03', sender: 'Drei' };
test('naming: invoice with validated date + sender is standardized', () => expect(targetName(inv, config)).toEqual({ name: '2026-10-03_Drei-Rechnung.pdf', renamed: true, reason: 'naming_validated' }));
test('naming: contract uses the Vertrag doctype', () => expect(targetName({ ...inv, route: route('contracts'), filename: 'x.PDF' }, config).name).toBe('2026-10-03_Drei-Vertrag.PDF'));
test('naming fallback: invented date keeps the original name', () => expect(targetName({ ...inv, documentDate: '2026-10-05' }, config)).toMatchObject({ name: 'scan0042.pdf', renamed: false, reason: 'naming_date_unverified' }));
test('naming fallback: invented sender keeps the original name', () => expect(targetName({ ...inv, sender: 'Magenta' }, config)).toMatchObject({ name: 'scan0042.pdf', renamed: false, reason: 'naming_sender_unverified' }));
test('naming fallback: missing date/sender keeps the original name', () => {
 expect(targetName({ ...inv, documentDate: null }, config).renamed).toBe(false);
 expect(targetName({ ...inv, sender: null }, config).renamed).toBe(false);
});
for (const id of ['uni', 'dev', 'personal']) test(`naming: ${id} always keeps the original name`, () => expect(targetName({ ...inv, route: route(id) }, config).name).toBe('scan0042.pdf'));
test('naming: date-prefix option is off by default and only affects 04_Persönlich', () => {
 const on = { ...config, naming: { datePrefix: true } };
 expect(targetName({ ...inv, route: route('personal') }, config).renamed).toBe(false);
 expect(targetName({ ...inv, route: route('personal'), filename: 'Reisepass Scan.pdf' }, on).name).toBe('2026-10-03_Reisepass Scan.pdf');
 expect(targetName({ ...inv, route: route('personal'), filename: '2026-01-01_x.pdf' }, on).renamed).toBe(false);
 expect(targetName({ ...inv, route: route('uni') }, on).name).toBe('scan0042.pdf');
 expect(targetName({ ...inv, route: route('dev') }, on).name).toBe('scan0042.pdf');
});
test('naming: extension is always the original one; odd extensions are not renamed', () => {
 expect(targetName({ ...inv, filename: 'scan.pdf' }, config).name.endsWith('.pdf')).toBe(true);
 expect(targetName({ ...inv, filename: 'scan.p d f' }, config).renamed).toBe(false);
});
test('sanitizeStem: NFC, no separators/control chars, length cap', () => {
 expect(sanitizeStem('Cafe\u0301/\u0007x:y~')).toBe('Café-x-y-');
 expect(sanitizeStem('x'.repeat(500)).length).toBe(120);
 expect(sanitizeStem('...')).toBe('Dokument');
});
