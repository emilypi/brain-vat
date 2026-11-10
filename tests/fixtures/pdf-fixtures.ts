import { createHash } from 'node:crypto';

interface FixtureOptions {
  cropped?: boolean;
  rotated?: boolean;
  imageOnly?: boolean;
  encrypted?: boolean;
}

function md5(bytes: Uint8Array): Buffer {
  return createHash('md5').update(bytes).digest();
}

// Legacy PDF encryption exists only to produce a password-protected test input.
function rc4(key: Uint8Array, input: Uint8Array): Buffer {
  const state = Array.from({ length: 256 }, (_, index) => index);
  let j = 0;
  for (let i = 0; i < 256; i += 1) {
    j = (j + (state[i] ?? 0) + (key[i % key.length] ?? 0)) % 256;
    [state[i], state[j]] = [state[j] ?? 0, state[i] ?? 0];
  }
  let i = 0;
  j = 0;
  return Buffer.from(
    input.map((value) => {
      i = (i + 1) % 256;
      j = (j + (state[i] ?? 0)) % 256;
      [state[i], state[j]] = [state[j] ?? 0, state[i] ?? 0];
      return value ^ (state[((state[i] ?? 0) + (state[j] ?? 0)) % 256] ?? 0);
    }),
  );
}

function stream(bytes: Buffer, dictionary = ''): Buffer {
  return Buffer.concat([
    Buffer.from(`<< /Length ${bytes.length} ${dictionary} >>\nstream\n`),
    bytes,
    Buffer.from('\nendstream'),
  ]);
}

function serialize(objects: Buffer[], trailer = ''): Buffer {
  const pieces = [Buffer.from('%PDF-1.4\n')];
  const offsets = [0];
  let size = pieces[0]?.length ?? 0;
  objects.forEach((object, index) => {
    offsets.push(size);
    const piece = Buffer.concat([
      Buffer.from(`${index + 1} 0 obj\n`),
      object,
      Buffer.from('\nendobj\n'),
    ]);
    pieces.push(piece);
    size += piece.length;
  });
  const xref = offsets
    .map((offset, index) =>
      index === 0
        ? '0000000000 65535 f '
        : `${String(offset).padStart(10, '0')} 00000 n `,
    )
    .join('\n');
  pieces.push(
    Buffer.from(
      `xref\n0 ${objects.length + 1}\n${xref}\ntrailer\n` +
        `<< /Size ${objects.length + 1} /Root 1 0 R ${trailer} >>\n` +
        `startxref\n${size}\n%%EOF\n`,
    ),
  );
  return Buffer.concat(pieces);
}

export function makePdfFixture(options: FixtureOptions = {}): Buffer {
  const content = options.imageOnly
    ? 'q 260 0 0 180 90 260 cm /Im0 Do Q'
    : 'BT /F1 18 Tf 80 520 Td (Rotated crop evidence) Tj ' +
      '0 -55 Td (https://example.org/evidence) Tj ' +
      '0 -45 Td (A cited statement [7].) Tj ET';
  let contentBytes: Buffer = Buffer.from(content);
  let encryption: Buffer | null = null;
  let trailer = '';
  if (options.encrypted) {
    const padding = Buffer.from(
      '28bf4e5e4e758a4164004e56fffa01082e2e00b6d0683e802f0ca9fe6453697a',
      'hex',
    );
    const padded = (password: string): Buffer =>
      Buffer.concat([Buffer.from(password), padding]).subarray(0, 32);
    const owner = rc4(md5(padded('owner-password')).subarray(0, 5), padded('secret'));
    const permission = Buffer.alloc(4);
    permission.writeInt32LE(-4);
    const identifier = md5(Buffer.from('brain-vat-encrypted-test'));
    const fileKey = md5(
      Buffer.concat([padded('secret'), owner, permission, identifier]),
    ).subarray(0, 5);
    const user = rc4(fileKey, padding);
    const objectKey = md5(
      Buffer.concat([fileKey, Buffer.from([5, 0, 0, 0, 0])]),
    ).subarray(0, 10);
    contentBytes = rc4(objectKey, contentBytes);
    encryption = Buffer.from(
      '<< /Filter /Standard /V 1 /R 2 /Length 40 ' +
        `/O <${owner.toString('hex')}> /U <${user.toString('hex')}> /P -4 >>`,
    );
    trailer =
      `/Encrypt 8 0 R /ID [<${identifier.toString('hex')}> ` +
      `<${identifier.toString('hex')}>]`;
  }
  const crop = options.cropped ? '/CropBox [40 50 440 590]' : '';
  const rotation = options.rotated ? '/Rotate 90' : '';
  const annotations = options.imageOnly || options.encrypted ? '' : '/Annots [6 0 R]';
  const objects: Buffer[] = [
    Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'),
    Buffer.from('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
    Buffer.from(
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 480 640] ' +
        `${crop} ${rotation} ${annotations} /Resources << /Font << /F1 4 0 R >> ` +
        '/XObject << /Im0 7 0 R >> >> /Contents 5 0 R >>',
    ),
    Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'),
    stream(contentBytes),
    Buffer.from(
      '<< /Type /Annot /Subtype /Link /Rect [80 460 330 484] /Border [0 0 0] ' +
        '/A << /S /URI /URI (https://example.org/evidence) >> >>',
    ),
    stream(
      Buffer.from('ff000000ff000000ffffffff>'),
      '/Type /XObject /Subtype /Image /Width 2 /Height 2 ' +
        '/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /ASCIIHexDecode',
    ),
  ];
  if (encryption) objects.push(encryption);
  return serialize(objects, trailer);
}

export function makeScrollingPdfFixture(): Buffer {
  const pageCount = 12;
  const pageId = (index: number): number => 4 + index * 3;
  const kids = Array.from({ length: pageCount }, (_, index) => `${pageId(index)} 0 R`);
  const objects: Buffer[] = [
    Buffer.from(
      '<< /Type /Catalog /Pages 2 0 R /Outlines 40 0 R ' +
        `/Names << /Dests << /Names [(proof) [${pageId(8)} 0 R /Fit]] >> >> >>`,
    ),
    Buffer.from(`<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pageCount} >>`),
    Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'),
  ];
  for (let index = 0; index < pageCount; index += 1) {
    const id = pageId(index);
    const box = index % 2 ? '[0 0 500 700]' : '[0 0 480 640]';
    const rotation = index === 2 ? '/Rotate 90' : '';
    objects.push(
      Buffer.from(
        `<< /Type /Page /Parent 2 0 R /MediaBox ${box} ${rotation} ` +
          `/Resources << /Font << /F1 3 0 R >> >> /Contents ${id + 1} 0 R ` +
          `/Annots [${id + 2} 0 R] >>`,
      ),
      stream(
        Buffer.from(
          `BT /F1 18 Tf 80 520 Td (Reading page ${index + 1}) Tj ` +
            '0 -55 Td (Go to the last page) Tj ' +
            '0 -45 Td (A definition with supporting evidence.) Tj ET',
        ),
      ),
      Buffer.from(
        '<< /Type /Annot /Subtype /Link /Rect [80 460 260 484] ' +
          `/Border [0 0 0] /Dest [${pageId(pageCount - 1)} 0 R /Fit] >>`,
      ),
    );
  }
  objects.push(
    Buffer.from('<< /Type /Outlines /First 41 0 R /Last 43 0 R /Count 3 >>'),
    Buffer.from(
      '<< /Title (Introduction) /Parent 40 0 R /Next 43 0 R ' +
        '/First 42 0 R /Last 42 0 R /Count 1 /Dest [4 0 R /Fit] >>',
    ),
    Buffer.from('<< /Title (Proof details) /Parent 41 0 R /Dest (proof) >>'),
    Buffer.from(
      '<< /Title (Conclusion) /Parent 40 0 R /Prev 41 0 R ' +
        `/Dest [${pageId(11)} 0 R /Fit] >>`,
    ),
  );
  return serialize(objects);
}
