/* Deelbare kijklinks zonder server: de vorm en gegevens van een object zitten in de link zelf.
 *
 * Formaat:  <pagina>#deel=<payload>
 *   payload = 'z' + base64url(deflate-raw(JSON))   (gecomprimeerd, moderne browsers)
 *           | 'j' + base64url(JSON)                (terugval zonder CompressionStream)
 * JSON = { v: 1, f: [ { n, r, c, s, k, col, fill, sh, rad, g } ] }
 *   g = geometrie met coördinaten als gehele getallen (graden × 1e6, ca. 10 cm) en
 *       per lijn/ring als verschillen t.o.v. het vorige punt (comprimeert veel beter).
 * Alles staat na het #-teken en wordt dus nooit naar een server gestuurd.
 */
(function (global) {
  'use strict';

  const PREFIX = '#deel=';
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
    const data = {
      v: 1,
      f: features.map(f => {
        const p = f.props || {};
        const o = { n: p.name || '', g: packGeometry(f.geometry), sh: f.shape || '' };
        if (p.ref) o.r = p.ref;
        if (p.category) o.c = p.category;
        if (p.status) o.s = p.status;
        if (p.kind) o.k = p.kind;
        if (p.color) o.col = p.color;
        if (p.fill && p.fill !== 'effen') o.fill = p.fill;
        if (f.radius) o.rad = Math.round(f.radius * 100) / 100;
        return o;
      }),
    };
    const json = new TextEncoder().encode(JSON.stringify(data));
    if ('CompressionStream' in global) {
      try { return 'z' + toB64url(await pipe(json, new CompressionStream('deflate-raw'))); } catch (e) { /* terugval */ }
    }
    return 'j' + toB64url(json);
  }

  // Payload-tekst -> lijst objecten in het formaat van de tool
  async function decode(payload) {
    const kind = payload.charAt(0);
    let bytes = fromB64url(payload.slice(1));
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
    const base = location.href.split('#')[0];
    return base + PREFIX + await encode(features);
  }

  const payloadFromHash = () => location.hash.startsWith(PREFIX) ? location.hash.slice(PREFIX.length) : null;

  global.Share = { PREFIX, encode, decode, linkFor, payloadFromHash };
})(window);
