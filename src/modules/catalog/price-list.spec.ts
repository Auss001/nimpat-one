import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { readCsv, readSpreadsheet } from '../../common/utils/spreadsheet';
import { findColumns, listRows, moneyToMinor, nameScore, nameWords } from './price-list';

describe('price list', () => {
  it('reads money in the usual ways', () => {
    expect(moneyToMinor('2400')).toBe(240_000);
    expect(moneyToMinor('₦2,400.50')).toBe(240_050);
    expect(moneyToMinor('0')).toBeNull();
    expect(moneyToMinor('call')).toBeNull();
  });

  it('finds the columns under different headings', () => {
    expect(findColumns([['BARCODE', 'PRODUCT DESCRIPTION', 'SALES PRICE', 'COST PRICE', 'QUANTITY']])?.cols).toEqual({ code: 0, name: 1, sale: 2, cost: 3, qty: 4 });
    expect(findColumns([['STOCK CODE', 'PRODUCT', 'SALES PRICE', 'COST PRICE', 'QUANTITY']])?.cols).toEqual({ code: 0, name: 1, sale: 2, cost: 3, qty: 4 });
    expect(findColumns([['PRODUCT ITEM', 'COST PRICE', 'SALES PRICE', 'QUANTITY']])?.cols).toEqual({ code: -1, name: 0, sale: 2, cost: 1, qty: 3 });
  });

  it('matches spelling variants but never a different strength', () => {
    const s = (a: string, b: string) => nameScore(nameWords(a), nameWords(b));
    expect(s('ABIDEC DROP', 'ABIDEC drops')).toBe(1);
    expect(s('Paracetamol 500mg tabs', 'PARACETAMOL 500 MG TABLET')).toBe(1);
    expect(s('Paracetamol 500mg', 'Paracetamol 1000mg')).toBe(0);
    expect(s('COFEX COUGH SYRUP', 'COFEX CHILD SYRUP')).toBeLessThan(0.75);
  });

  it('reads CSV with quotes and semicolons', () => {
    expect(readCsv('Name;Price\n"Water, 50cl";"2,400"\n')).toEqual([['Name', 'Price'], ['Water, 50cl', '2,400']]);
  });

  // The pharmacy's own files, when they are present on this machine.
  const dir = process.env.PRICE_LIST_SAMPLES;
  (dir ? it : it.skip)('reads the supplied workbooks', () => {
    for (const f of readdirSync(dir!).filter((x) => x.endsWith('.xlsx'))) {
      const { rows } = listRows(readSpreadsheet(readFileSync(join(dir!, f)), f));
      expect(rows.length).toBeGreaterThan(10);
      expect(rows.every((r) => r.name)).toBe(true);
    }
  });
});
