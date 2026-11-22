/* Deelbare kijklinks zonder server: de vorm en gegevens van een object zitten in de link zelf.
 *
 * Formaat:  <pagina>#d=<payload>   (oude links met #deel= blijven werken)
 *   payload = 'b' + base64url(deflate-raw(BINAIR))  (huidig, compact)
 *           | 'B' + base64url(BINAIR)               (terugval zonder CompressionStream)
 *           | 'z'/'j' = oudere JSON-variant, alleen nog om te openen
 * BINAIR = varint(aantal) + per object: varint(len) + JSON-gegevens, varint(type), coördinaten
 *   als zigzag-varints (graden × 1e6, verschil t.o.v. vorig punt). Lijnen en vlakken worden
 *   vooraf vereenvoudigd: punten die < 10 cm afwijken vallen weg (oppervlakte verandert ~0,1%).
 * JSON = { v: 1, f: [ { n, r, c, s, k, col, fill, sh, rad, g } ] }
 *   g = geometrie met coördinaten als gehele getallen (graden × 1e6, ca. 10 cm) en
 *       per lijn/ring als verschillen t.o.v. het vorige punt (comprimeert veel beter).
 * Alles staat na het #-teken en wordt dus nooit naar een server gestuurd.
 */
(function (global) {
  'use strict';

  const PREFIX = '#d=';
  const OLD_PREFIX = '#deel=';
  const SCALE = 1e6;
  const DEPTH = { Point: 0, LineString: 1, MultiPoint: 1, Polygon: 2, MultiLineString: 2, MultiPolygon: 3 };

  // Lijst met posities -> platte lijst met verschillen in gehele getallen
  function packLine(positions) {
    const out = [];
    let px = 0, py = 0;
    positions.forEach(([x, y]) => {
      const ix = Math.round(x * SCALE), iy = Math.round(y * SCALE);
      out.push(ix - px, iy - py);
      px = ix; py = iy;
    });
    return out;
  }
  function unpackLine(flat) {
    const out = [];
    let x = 0, y = 0;
    for (let i = 0; i + 1 < flat.length; i += 2) {
      x += flat[i]; y += flat[i + 1];
      out.push([x / SCALE, y / SCALE]);
    }
    return out;
  }
  function packCoords(c, depth) {
    if (depth === 0) return [Math.round(c[0] * SCALE), Math.round(c[1] * SCALE)];
    if (depth === 1) return packLine(c);
    return c.map(part => packCoords(part, depth - 1));
  }
  function unpackCoords(c, depth) {
    if (depth === 0) return [c[0] / SCALE, c[1] / SCALE];
    if (depth === 1) return unpackLine(c);
    return c.map(part => unpackCoords(part, depth - 1));
  }

  function packGeometry(g) {
    const d = DEPTH[g.type];
    if (d === undefined) throw new Error(`Geometrietype ${g.type} kan niet gedeeld worden`);
    return { t: g.type, c: packCoords(g.coordinates, d) };
  }
  function unpackGeometry(p) {
    const d = DEPTH[p.t];
    if (d === undefined) throw new Error('Onbekende geometrie in de link');
    return { type: p.t, coordinates: unpackCoords(p.c, d) };
  }

  // ---- Compact binair formaat (v2)
  const TYPES = ['Point', 'LineString', 'Polygon', 'MultiPoint', 'MultiLineString', 'MultiPolygon'];
  const SIMPLIFY_DEG = 0.1 / 111320;   // 10 cm

  function simplify(g) {
    if (g.type === 'Point' || g.type === 'MultiPoint' || !global.turf) return g;
    try {
      const sg = global.turf.simplify(global.turf.feature(g), { tolerance: SIMPLIFY_DEG, highQuality: true }).geometry;
      return sg && sg.coordinates && sg.coordinates.length ? sg : g;
    } catch (e) { return g; }
  }

  function writer() {
    const bytes = [];
    const uint = (n) => { while (n >= 128) { bytes.push((n % 128) | 128); n = Math.floor(n / 128); } bytes.push(n); };
    const int = (n) => uint(n < 0 ? -n * 2 - 1 : n * 2);
    return { bytes, uint, int };
  }
  function reader(bytes) {
    let i = 0;
    const uint = () => { let n = 0, m = 1, b; do { b = bytes[i++]; if (b === undefined) throw new Error('kapot'); n += (b & 127) * m; m *= 128; } while (b & 128); return n; };
    const int = () => { const n = uint(); return n % 2 ? -(n + 1) / 2 : n / 2; };
    const take = (len) => { const out = bytes.subarray(i, i + len); i += len; return out; };
    return { uint, int, take };
  }

  function writeGeometry(w, g) {
    w.uint(TYPES.indexOf(g.type));
    let px = 0, py = 0;
    const pt = ([x, y]) => { const ix = Math.round(x * SCALE), iy = Math.round(y * SCALE); w.int(ix - px); w.int(iy - py); px = ix; py = iy; };
    const line = (c) => { w.uint(c.length); c.forEach(pt); };
    const ring = (c) => {   // sluitpunt weglaten
      const open = c.length > 1 && c[0][0] === c[c.length - 1][0] && c[0][1] === c[c.length - 1][1] ? c.slice(0, -1) : c;
      line(open);
    };
    const poly = (rings) => { w.uint(rings.length); rings.forEach(ring); };
    const c = g.coordinates;
    if (g.type === 'Point') pt(c);
    else if (g.type === 'LineString' || g.type === 'MultiPoint') line(c);
    else if (g.type === 'Polygon') poly(c);
    else if (g.type === 'MultiLineString') { w.uint(c.length); c.forEach(line); }
    else if (g.type === 'MultiPolygon') { w.uint(c.length); c.forEach(poly); }
  }
  function readGeometry(r) {
    const type = TYPES[r.uint()];
    if (!type) throw new Error('kapot');
    let x = 0, y = 0;
    const pt = () => { x += r.int(); y += r.int(); return [x / SCALE, y / SCALE]; };
    const line = () => { const n = r.uint(), out = []; for (let k = 0; k < n; k++) out.push(pt()); return out; };
    const ring = () => { const l = line(); if (l.length) l.push([l[0][0], l[0][1]]); return l; };
    const poly = () => { const n = r.uint(), out = []; for (let k = 0; k < n; k++) out.push(ring()); return out; };
    const list = (fn) => { const n = r.uint(), out = []; for (let k = 0; k < n; k++) out.push(fn()); return out; };
    let coordinates;
    if (type === 'Point') coordinates = pt();
    else if (type === 'LineString' || type === 'MultiPoint') coordinates = line();
    else if (type === 'Polygon') coordinates = poly();
    else if (type === 'MultiLineString') coordinates = list(line);
    else coordinates = list(poly);
    return { type, coordinates };
  }

  function metaOf(f) {
    const p = f.props || {};
    const o = {};
    if (p.name) o.n = p.name;
    if (f.shape && f.shape !== 'Polygon') o.sh = f.shape;
    if (p.ref) o.r = p.ref;
    if (p.category) o.c = p.category;
    if (p.status) o.s = p.status;
    if (p.kind && p.kind !== 'gebied') o.k = p.kind;
    if (p.color) o.col = p.color.replace('#', '');
    if (p.fill && p.fill !== 'effen') o.fill = p.fill;
    if (f.radius) o.rad = Math.round(f.radius * 10) / 10;
    return o;
  }

  function toFeature(o, geometry, i) {
    return {
      id: `shared-${i}`,
      shape: o.sh || (geometry.type.includes('Polygon') ? 'Polygon' : geometry.type.includes('Line') ? 'Line' : 'Marker'),
      geometry,
      ...(o.rad ? { radius: o.rad } : {}),
      props: {
        name: o.n || '', ref: o.r || '', category: o.c || '', status: o.s || '',
        kind: o.k || 'gebied', color: o.col ? (o.col.startsWith('#') ? o.col : '#' + o.col) : '#0a6c8f', fill: o.fill || 'effen', notes: '',
      },
    };
  }

  function encodeBinary(features) {
    const w = writer();
    w.uint(features.length);
    features.forEach(f => {
      const meta = new TextEncoder().encode(JSON.stringify(metaOf(f)));
      w.uint(meta.length);
      meta.forEach(b => w.bytes.push(b));
      writeGeometry(w, f.shape === 'Circle' ? f.geometry : simplify(f.geometry));
    });
    return new Uint8Array(w.bytes);
  }
  function decodeBinary(bytes) {
    const r = reader(bytes);
    const n = r.uint();
    const out = [];
    for (let i = 0; i < n; i++) {
      const meta = JSON.parse(new TextDecoder().decode(r.take(r.uint())));
      out.push(toFeature(meta, readGeometry(r), i));
    }
    return out;
  }

  // ---- base64url
  function toB64url(bytes) {
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function fromB64url(s) {
    const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  async function pipe(bytes, stream) {
    const res = new Response(new Blob([bytes]).stream().pipeThrough(stream));
    return new Uint8Array(await res.arrayBuffer());
  }

  // Object(en) uit de tool -> payload-tekst
  async function encode(features) {
    const bin = encodeBinary(features);
    if ('CompressionStream' in global) {
      try { return 'b' + toB64url(await pipe(bin, new CompressionStream('deflate-raw'))); } catch (e) { /* terugval */ }
    }
    return 'B' + toB64url(bin);
  }

  // Payload-tekst -> lijst objecten in het formaat van de tool
  async function decode(payload) {
    const kind = payload.charAt(0);
    let bytes;
    try { bytes = fromB64url(payload.slice(1)); } catch (e) { throw new Error('Deze link is ongeldig of onvolledig.'); }
    if (kind === 'b' || kind === 'B') {
      try {
        if (kind === 'b') {
          if (!('DecompressionStream' in global)) throw new Error('Deze browser is te oud om de link te openen. Werk je browser bij.');
          bytes = await pipe(bytes, new DecompressionStream('deflate-raw'));
        }
        return decodeBinary(bytes);
      } catch (e) {
        throw new Error(/^Deze /.test(e.message) ? e.message : 'Deze link is ongeldig of onvolledig.');
      }
    }
    if (kind === 'z') {
      if (!('DecompressionStream' in global)) throw new Error('Deze browser is te oud om de link te openen. Werk je browser bij.');
      bytes = await pipe(bytes, new DecompressionStream('deflate-raw'));
    } else if (kind !== 'j') {
      throw new Error('Deze link is ongeldig of onvolledig.');
    }
    const data = JSON.parse(new TextDecoder().decode(bytes));
    if (!data || data.v !== 1 || !Array.isArray(data.f)) throw new Error('Deze link is ongeldig of onvolledig.');
    return data.f.map((o, i) => ({
      id: `shared-${i}`,
      shape: o.sh || '',
      geometry: unpackGeometry(o.g),
      ...(o.rad ? { radius: o.rad } : {}),
      props: {
        name: o.n || '', ref: o.r || '', category: o.c || '', status: o.s || '',
        kind: o.k || 'gebied', color: o.col || '#0a6c8f', fill: o.fill || 'effen', notes: '',
      },
    }));
  }

  async function linkFor(features) {
    const base = location.href.split('#')[0].replace(/index\.html$/, '');
    return base + PREFIX + await encode(features);
  }

  const payloadFromHash = () => {
    const h = location.hash;
    if (h.startsWith(PREFIX)) return h.slice(PREFIX.length);
    if (h.startsWith(OLD_PREFIX)) return h.slice(OLD_PREFIX.length);
    return null;
  };

  global.Share = { PREFIX, encode, decode, linkFor, payloadFromHash };
})(window);
