import { inflateRawSync } from 'node:zlib';

/**
 * Reads the cells of an Excel workbook (.xlsx) or a CSV file as text.
 * Built on Node's own zlib so the API needs no spreadsheet library.
 * Formulas give their last saved value; formatting is ignored.
 */
export interface Sheet {
  name: string;
  rows: string[][];
}

const MAX_PART_BYTES = 20 * 1024 * 1024;
const MAX_ROWS = 5000;

export class SpreadsheetError extends Error {}

export function readSpreadsheet(file: Buffer, fileName: string): Sheet[] {
  const zip = file.length > 4 && file.readUInt32LE(0) === 0x04034b50;
  if (zip) return readXlsx(file);
  if (/\.(xls|xlsb|ods|numbers)$/i.test(fileName)) {
    throw new SpreadsheetError('Please save the file as an Excel workbook (.xlsx) or CSV, then upload it again.');
  }
  return [{ name: fileName.replace(/\.[^.]+$/, '') || 'Sheet1', rows: readCsv(file.toString('utf8')) }];
}

// ---------------------------------------------------------------- xlsx

/** The parts of the zip a workbook needs. Everything else (styles, pictures) is skipped. */
function unzip(buf: Buffer): Map<string, Buffer> {
  let end = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new SpreadsheetError('This file is damaged or is not an Excel workbook.');
  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  const parts = new Map<string, Buffer>();
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new SpreadsheetError('This file is damaged or is not an Excel workbook.');
    const method = buf.readUInt16LE(p + 10);
    const packed = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const noteLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + noteLen;
    if (!/^xl\/(sharedStrings\.xml|workbook\.xml|_rels\/workbook\.xml\.rels|worksheets\/[^/]+\.xml)$/.test(name)) continue;
    if (size > MAX_PART_BYTES) throw new SpreadsheetError('This workbook is too large. Please upload a smaller file.');
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + packed);
    if (method === 0) parts.set(name, data);
    else if (method === 8) parts.set(name, inflateRawSync(data, { maxOutputLength: MAX_PART_BYTES }));
    else throw new SpreadsheetError('This workbook uses a format we cannot read. Please save it again in Excel and retry.');
  }
  return parts;
}

const XML_ENTITIES: Record<string, string> = { lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' };
function xmlText(s: string) {
  return s.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (all, e: string) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return XML_ENTITIES[e] ?? all;
  });
}
const runs = (xml: string) => [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => xmlText(m[1])).join('');

function columnIndex(ref: string) {
  let n = 0;
  for (const ch of ref) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function readXlsx(buf: Buffer): Sheet[] {
  const parts = unzip(buf);
  const text = (name: string) => parts.get(name)?.toString('utf8') ?? '';
  const shared = [...text('xl/sharedStrings.xml').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => runs(m[1]));
  const targets = new Map(
    [...text('xl/_rels/workbook.xml.rels').matchAll(/<Relationship\s[^>]*>/g)].map((m) => [
      m[0].match(/Id="([^"]+)"/)?.[1] ?? '',
      (m[0].match(/Target="([^"]+)"/)?.[1] ?? '').replace(/^\/?xl\//, ''),
    ]),
  );
  const sheets: Sheet[] = [];
  for (const m of text('xl/workbook.xml').matchAll(/<sheet\s[^>]*>/g)) {
    const name = xmlText(m[0].match(/name="([^"]*)"/)?.[1] ?? `Sheet${sheets.length + 1}`);
    const target = targets.get(m[0].match(/r:id="([^"]+)"/)?.[1] ?? '');
    const xml = target ? text(`xl/${target}`) : '';
    if (!xml) continue;
    const rows: string[][] = [];
    for (const r of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      if (rows.length >= MAX_ROWS) throw new SpreadsheetError(`A sheet has more than ${MAX_ROWS} rows. Please split the file.`);
      const row: string[] = [];
      for (const c of r[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const ref = c[1].match(/r="([A-Z]+)[0-9]+"/)?.[1];
        const type = c[1].match(/t="([^"]+)"/)?.[1];
        const body = c[2] ?? '';
        const v = body.match(/<v>([\s\S]*?)<\/v>/)?.[1];
        const value = type === 's' ? shared[Number(v)] ?? '' : type === 'inlineStr' ? runs(body) : v !== undefined ? xmlText(v) : '';
        row[ref ? columnIndex(ref) : row.length] = value.trim();
      }
      rows.push(Array.from(row, (x) => x ?? ''));
    }
    sheets.push({ name, rows });
  }
  if (!sheets.length) throw new SpreadsheetError('No sheets were found in this workbook.');
  return sheets;
}

// ---------------------------------------------------------------- csv

/** Comma, semicolon or tab separated, with quoted fields. */
export function readCsv(input: string): string[][] {
  const text = input.replace(/^﻿/, '');
  const first = text.split(/\r?\n/, 1)[0] ?? '';
  const counts = [',', ';', '\t'].map((d) => [d, first.split(d).length] as const);
  const sep = counts.sort((a, b) => b[1] - a[1])[0][0];
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === sep) {
      row.push(field.trim());
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field.trim());
      rows.push(row);
      if (rows.length > MAX_ROWS) throw new SpreadsheetError(`The file has more than ${MAX_ROWS} rows. Please split it.`);
      row = [];
      field = '';
    } else field += ch;
  }
  if (field || row.length) {
    row.push(field.trim());
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c !== ''));
}
