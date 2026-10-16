import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderMarkdownToPdf } from '../generation/markdown-pdf';
import { getPDFReader, getProviderInfo } from '../shared/factory';
import { imagesToPdf } from './images-to-pdf';
import { PaddleOCRError } from './paddleocr';

// A scanned document (no text layer), three pages.
const scannedPdfPath = join(
  __dirname,
  '../../test/Signed-Meeting-Minutes-July-9-2024-Regular-Meeting-of-Council.pdf',
);
// A born-digital document with a real text layer.
const bornDigital = () =>
  renderMarkdownToPdf(
    `# Mill certificate\n\n${'Heat number 12345 grade A36. '.repeat(40)}`,
  );

const pageMarkdown = ['# Page one', '<table><tr><td>Heat</td></tr></table>'];
const envelope = (pages: string[]) => ({
  errorCode: 0,
  logId: 'request-1',
  result: {
    layoutParsingResults: pages.map((text) => ({
      markdown: { text, images: null },
      prunedResult: {},
    })),
  },
});

let server: Server;
let baseUrl: string;
let calls: { fileType: number; file: string }[];
let respond: (res: import('node:http').ServerResponse) => void;

function png(width = 40, height = 20): Uint8Array {
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, width, height);
  return canvas.toBuffer('image/png');
}

beforeEach(async () => {
  calls = [];
  respond = (res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(envelope(pageMarkdown)));
  };
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString());
    calls.push({ fileType: body.fileType, file: body.file });
    respond(res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as import('node:net').AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  vi.unstubAllEnvs();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("getPDFReader({ provider: 'paddleocr' })", () => {
  it('reads text through the service, joining pages and honouring page selection', async () => {
    const reader = await getPDFReader({
      provider: 'paddleocr',
      paddleocr: { baseUrl },
    });
    const pdf = await readFile(scannedPdfPath);

    expect(await reader.extractText(pdf)).toBe(pageMarkdown.join('\n\n'));
    expect(await reader.extractText(pdf, { pages: [2] })).toBe(pageMarkdown[1]);
    expect(calls.map((call) => call.fileType)).toEqual([0, 0]);
    expect(Buffer.from(calls[0].file, 'base64').equals(pdf)).toBe(true);
  });

  it('takes the service URL from HAVE_PDF_PADDLEOCR_URL and the provider from HAVE_PDF_PROVIDER', async () => {
    vi.stubEnv('HAVE_PDF_PADDLEOCR_URL', baseUrl);
    vi.stubEnv('HAVE_PDF_PROVIDER', 'paddleocr');
    const reader = await getPDFReader();

    expect(await reader.extractText(scannedPdfPath)).toBe(
      pageMarkdown.join('\n\n'),
    );
    expect(calls).toHaveLength(1);
  });

  it('fails at creation without a service URL', async () => {
    vi.stubEnv('HAVE_PDF_PADDLEOCR_URL', '');
    await expect(getPDFReader({ provider: 'paddleocr' })).rejects.toThrow(
      /HAVE_PDF_PADDLEOCR_URL/,
    );
    const info = await getProviderInfo('paddleocr');
    expect(info.available).toBe(false);
  });

  it('refuses a separate OCR provider', async () => {
    await expect(
      getPDFReader({
        provider: 'paddleocr',
        ocrProvider: 'onnx',
        paddleocr: { baseUrl },
      }),
    ).rejects.toThrow(/does not support OCR provider 'onnx'/);
  });

  it('is never chosen by auto, even when configured', async () => {
    vi.stubEnv('HAVE_PDF_PADDLEOCR_URL', baseUrl);
    const reader = await getPDFReader({ provider: 'auto' });
    await reader.extractText(scannedPdfPath, { skipOCRFallback: true });
    expect(calls).toHaveLength(0);
  });

  it('answers getInfo, metadata, images and page renders locally', async () => {
    const reader = await getPDFReader({
      provider: 'paddleocr',
      paddleocr: { baseUrl },
    });
    const info = await reader.getInfo(scannedPdfPath);
    const metadata = await reader.extractMetadata(scannedPdfPath);
    const rendered = await reader.renderPages(scannedPdfPath, { pages: [1] });
    await reader.extractImages(scannedPdfPath, { pages: [1] });

    expect(info.pageCount).toBeGreaterThan(0);
    expect(metadata.pageCount).toBe(info.pageCount);
    expect(rendered).toHaveLength(1);
    expect(calls).toHaveLength(0);

    const capabilities = await reader.checkCapabilities();
    expect(capabilities).toMatchObject({
      canExtractText: true,
      canPerformOCR: true,
      supportedFormats: ['pdf'],
    });
  });

  it('reads only the text layer with skipOCRFallback', async () => {
    const reader = await getPDFReader({
      provider: 'paddleocr',
      paddleocr: { baseUrl },
    });
    const text = await reader.extractText(await bornDigital(), {
      skipOCRFallback: true,
    });
    expect(text).toContain('Heat number 12345');
    const scanned = await reader.extractText(scannedPdfPath, {
      skipOCRFallback: true,
    });
    expect(scanned?.trim() ?? '').toBe('');
    expect(calls).toHaveLength(0);
  });

  it('with preferEmbeddedText, reads a text PDF locally and a scan through the service', async () => {
    const reader = await getPDFReader({
      provider: 'paddleocr',
      paddleocr: { baseUrl, preferEmbeddedText: true },
    });
    const local = await reader.extractText(await bornDigital());
    expect(local).toContain('Heat number 12345');
    expect(calls).toHaveLength(0);

    const scan = await imagesToPdf([png(400, 300)], { pageSize: 'letter' });
    expect(await reader.extractText(scan)).toBe(pageMarkdown.join('\n\n'));
    expect(await reader.extractText(scannedPdfPath)).toBe(
      pageMarkdown.join('\n\n'),
    );
    expect(calls).toHaveLength(2);
  });

  it('OCRs images one request each, in order, encoding raw pixels as PNG first', async () => {
    const reader = await getPDFReader({
      provider: 'paddleocr',
      paddleocr: { baseUrl },
    });
    let n = 0;
    respond = (res) => {
      n += 1;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(envelope([`image ${n}`])));
    };
    const encoded = png();
    const raw = new Uint8Array(4 * 2 * 3).fill(255);

    const result = await reader.performOCR([
      { data: encoded, format: 'image/png' },
      { data: raw, width: 4, height: 2, channels: 3, format: 'image/x-rgb' },
    ]);

    expect(result.text).toBe('image 1\n\nimage 2');
    expect(result.confidence).toBe(100);
    expect(result.metadata?.provider).toBe('paddleocr');
    expect(calls.map((call) => call.fileType)).toEqual([1, 1]);
    expect(Buffer.from(calls[0].file, 'base64').equals(encoded)).toBe(true);
    const second = Buffer.from(calls[1].file, 'base64');
    expect(second.subarray(1, 4).toString('ascii')).toBe('PNG');
  });

  it('surfaces a service failure without retrying or falling back', async () => {
    respond = (res) => {
      res.statusCode = 503;
      res.end('busy');
    };
    const reader = await getPDFReader({
      provider: 'paddleocr',
      paddleocr: { baseUrl },
    });

    const error = await reader.extractText(scannedPdfPath).catch((e) => e);
    expect(error).toBeInstanceOf(PaddleOCRError);
    expect(error.code).toBe('EPADDLEHTTP');
    expect(calls).toHaveLength(1);
  });

  it('refuses image formats the service cannot take before any request', async () => {
    const reader = await getPDFReader({
      provider: 'paddleocr',
      paddleocr: { baseUrl },
    });
    await expect(
      reader.performOCR([
        { data: new Uint8Array([1, 2, 3]), format: 'application/octet-stream' },
      ]),
    ).rejects.toThrow(/PNG or JPEG/);
    expect(calls).toHaveLength(0);
  });
});
