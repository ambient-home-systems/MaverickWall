"""Crop a PNG's top-left region. Headless Chrome screenshots the whole window,
and the viewport is 87px shorter than the window it was asked for."""
import struct, sys, zlib

def chunks(d):
    i = 8
    while i < len(d):
        n = struct.unpack('>I', d[i:i + 4])[0]
        yield d[i + 4:i + 8], d[i + 8:i + 8 + n]
        i += 12 + n

def crop(src, dst, cw, ch):
    d = open(src, 'rb').read()
    idat = b''
    for name, body in chunks(d):
        if name == b'IHDR':
            w, h, depth, ctype = struct.unpack('>IIBB', body[:10])
        elif name == b'IDAT':
            idat += body
    assert depth == 8 and ctype in (2, 6), (depth, ctype)
    bpp = 3 if ctype == 2 else 4
    raw = zlib.decompress(idat)
    stride = w * bpp
    prev = bytearray(stride)
    rows = []
    pos = 0
    for _ in range(h):
        f = raw[pos]; pos += 1
        line = bytearray(raw[pos:pos + stride]); pos += stride
        for x in range(stride):
            a = line[x - bpp] if x >= bpp else 0
            b = prev[x]
            c = prev[x - bpp] if x >= bpp else 0
            if f == 1: line[x] = (line[x] + a) & 255
            elif f == 2: line[x] = (line[x] + b) & 255
            elif f == 3: line[x] = (line[x] + (a + b) // 2) & 255
            elif f == 4:
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                line[x] = (line[x] + pr) & 255
        rows.append(line)
        prev = line
    out = bytearray()
    for y in range(ch):
        out.append(0)
        out += rows[y][:cw * bpp]
    body = struct.pack('>IIBBBBB', cw, ch, 8, ctype, 0, 0, 0)
    def chunk(name, data):
        return struct.pack('>I', len(data)) + name + data + struct.pack(
            '>I', zlib.crc32(name + data) & 0xFFFFFFFF)
    open(dst, 'wb').write(
        b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', body)
        + chunk(b'IDAT', zlib.compress(bytes(out), 9)) + chunk(b'IEND', b''))
    print(dst, cw, 'x', ch, 'from', w, 'x', h)

crop(sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4]))
