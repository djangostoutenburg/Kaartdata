/* Deelbare kijklinks zonder server: de vorm en gegevens van een object zitten in de link zelf.
 *
 * Formaat:  <pagina>#d=<payload>   (oude links met #deel= blijven werken)
 *   payload = 'c' + base64url(deflate-raw(BINAIR v3)) | 'C' + base64url(BINAIR v3)   (huidig)
 *           | 'b'/'B' (v2) en 'z'/'j' (v1): oudere varianten, alleen nog om te openen
 * De hele link blijft binnen MAX_LEN (255) tekens:
 *   - een ongewijzigd BGT-vak gaat mee als BGT-nummer (+ grove reservevorm als die past);
 *     de kijkweergave haalt de exacte vorm bij PDOK op
 *   - anders wordt de vorm stap voor stap vereenvoudigd tot de link past
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
  const MAX_LEN = 255;
  // BGT-collecties, op volgorde (index gaat in de link)
  const COLLS = ['begroeidterreindeel', 'ondersteunendwegdeel', 'vegetatieobject_vlak', 'vegetatieobject_lijn', 'vegetatieobject_punt',
    'onbegroeidterreindeel', 'wegdeel', 'waterdeel', 'ondersteunendwaterdeel', 'pand', 'overbruggingsdeel'];
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

  function simplify(g, metres = 0.1) {
    if (g.type === 'Point' || g.type === 'MultiPoint' || !global.turf) return g;
    try {
      const sg = global.turf.simplify(global.turf.feature(g), { tolerance: metres * SIMPLIFY_DEG / 0.1, highQuality: true }).geometry;
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

  function writeGeometry(w, g, scale = SCALE) {
    w.uint(TYPES.indexOf(g.type));
    let px = 0, py = 0;
    const pt = ([x, y]) => { const ix = Math.round(x * scale), iy = Math.round(y * scale); w.int(ix - px); w.int(iy - py); px = ix; py = iy; };
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
  function readGeometry(r, scale = SCALE) {
    const type = TYPES[r.uint()];
    if (!type) throw new Error('kapot');
    let x = 0, y = 0;
    const pt = () => { x += r.int(); y += r.int(); return [x / scale, y / scale]; };
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

  function metaOf(f, level = 0) {
    const p = f.props || {};
    const o = {};
    if (p.name) o.n = level >= 2 && p.name.length > 32 ? p.name.slice(0, 31) + '…' : p.name;
    if (level >= 1) {   // ingekort: alleen naam, kenmerk, kleur, opvulling, vorm
      if (f.shape && f.shape !== 'Polygon') o.sh = f.shape;
      if (p.ref) o.r = p.ref;
      if (p.color) o.col = p.color.replace('#', '');
      if (p.fill && p.fill !== 'effen') o.fill = p.fill;
      if (f.radius) o.rad = Math.round(f.radius);
      return o;
    }
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

  // ---- v3: BGT-verwijzingen en/of (vereenvoudigde) vorm, binnen MAX_LEN
  // BGT lokaal_id 'G0363.13002b99…' (letter + 4 cijfers + 32 hex) -> 1 + 2 + 16 bytes
  function writeRef(w, ref) {
    const [coll, id] = ref.split(':');
    w.uint(Math.max(0, COLLS.indexOf(coll)));
    const m = /^([A-Z])(\d{4})\.([0-9a-f]{32})$/i.exec(id || '');
    if (m) {
      w.uint(0);
      w.bytes.push(m[1].toUpperCase().charCodeAt(0));
      w.uint(+m[2]);
      for (let i = 0; i < 32; i += 2) w.bytes.push(parseInt(m[3].slice(i, i + 2), 16));
    } else {
      const b = new TextEncoder().encode(id || '');
      w.uint(1); w.uint(b.length); b.forEach(x => w.bytes.push(x));
    }
  }
  function readRef(r) {
    const coll = COLLS[r.uint()];
    if (r.uint() === 0) {
      const letter = String.fromCharCode(r.take(1)[0]);
      const num = String(r.uint()).padStart(4, '0');
      const hex = [...r.take(16)].map(b => b.toString(16).padStart(2, '0')).join('');
      return `${coll}:${letter}${num}.${hex}`;
    }
    return `${coll}:${new TextDecoder().decode(r.take(r.uint()))}`;
  }

  // Eén poging: object(en) met deze instellingen -> bytes
  function encodeV3(features, opt) {
    const w = writer();
    w.uint(features.length);
    features.forEach(f => {
      const meta = new TextEncoder().encode(JSON.stringify(metaOf(f, opt.meta)));
      w.uint(meta.length);
      meta.forEach(b => w.bytes.push(b));
      const refs = opt.refs && f.refs ? f.refs : [];
      const geom = opt.geom !== false;
      w.uint((refs.length ? 1 : 0) | (geom ? 2 : 0));
      if (refs.length) { w.uint(refs.length); refs.forEach(ref => writeRef(w, ref)); }
      if (geom) {
        w.uint(opt.scale === 1e5 ? 5 : 6);
        writeGeometry(w, f.shape === 'Circle' || f.geometry.type === 'Point' ? f.geometry : simplify(f.geometry, opt.tol), opt.scale);
      }
    });
    return new Uint8Array(w.bytes);
  }
  function decodeV3(bytes) {
    const r = reader(bytes);
    const n = r.uint();
    const out = [];
    for (let i = 0; i < n; i++) {
      const meta = JSON.parse(new TextDecoder().decode(r.take(r.uint())));
      const flags = r.uint();
      const refs = [];
      if (flags & 1) { const k = r.uint(); for (let j = 0; j < k; j++) refs.push(readRef(r)); }
      let geometry = null;
      if (flags & 2) { const sc = r.uint() === 5 ? 1e5 : 1e6; geometry = readGeometry(r, sc); }
      const f = toFeature(meta, geometry || { type: 'Point', coordinates: [0, 0] }, i);
      if (!geometry) f.geometry = null;
      if (refs.length) f.refs = refs;
      out.push(f);
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

  async function pack(bytes) {
    let best = 'C' + toB64url(bytes);
    if ('CompressionStream' in global) {
      try {
        const z = 'c' + toB64url(await pipe(bytes, new CompressionStream('deflate-raw')));
        if (z.length < best.length) best = z;
      } catch (e) { /* terugval */ }
    }
    return best;
  }

  // Object(en) -> payload die samen met `base` binnen MAX_LEN past.
  // Geeft { payload, tol, usedRefs, withGeom, meta } of gooit een fout als het echt niet past.
  async function encodeWithin(features, base, maxLen = MAX_LEN) {
    const budget = maxLen - base.length - PREFIX.length;
    const hasRefs = features.every(f => f.refs && f.refs.length);
    const tols = [0.1, 0.25, 0.5, 1, 2, 3, 5, 8, 12, 20, 35];
    const tries = [];
    if (hasRefs) {
      // exacte BGT-vorm via nummer, met een grove reservevorm als die nog past
      [0, 1].forEach(meta => [0.5, 1, 2, 3, 5].forEach(tol => tries.push({ refs: true, geom: true, meta, tol, scale: tol >= 1 ? 1e5 : 1e6 })));
      [0, 1, 2].forEach(meta => tries.push({ refs: true, geom: false, meta }));
    }
    [0, 1].forEach(meta => tols.filter(t => t <= (meta ? 3 : 0.5)).forEach(tol => tries.push({ geom: true, meta, tol, scale: tol >= 1 ? 1e5 : 1e6 })));
    tols.filter(t => t > 0.5).forEach(tol => tries.push({ geom: true, meta: 2, tol, scale: 1e5 }));
    for (const opt of tries) {
      const payload = await pack(encodeV3(features, opt));
      if (payload.length <= budget) return { payload, ...opt };
    }
    throw new Error('Dit vak is te groot of te gedetailleerd voor een link van ' + maxLen + ' tekens.');
  }

  // Simpele variant (zonder limiet), o.a. voor export
  async function encode(features) {
    return pack(encodeV3(features, { geom: true, meta: 0, tol: 0.1, scale: 1e6, refs: true }));
  }

  // Payload-tekst -> lijst objecten in het formaat van de tool
  async function decode(payload) {
    const kind = payload.charAt(0);
    let bytes;
    try { bytes = fromB64url(payload.slice(1)); } catch (e) { throw new Error('Deze link is ongeldig of onvolledig.'); }
    if (kind === 'c' || kind === 'C') {
      try {
        if (kind === 'c') {
          if (!('DecompressionStream' in global)) throw new Error('Deze browser is te oud om de link te openen. Werk je browser bij.');
          bytes = await pipe(bytes, new DecompressionStream('deflate-raw'));
        }
        return decodeV3(bytes);
      } catch (e) {
        throw new Error(/^Deze /.test(e.message) ? e.message : 'Deze link is ongeldig of onvolledig.');
      }
    }
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

  // Deellink binnen MAX_LEN tekens. Geeft { url, tol, usedRefs, withGeom, meta }.
  async function linkFor(features, maxLen = MAX_LEN) {
    const base = location.href.split('#')[0].replace(/index\.html$/, '');
    const r = await encodeWithin(features, base, maxLen);
    return { url: base + PREFIX + r.payload, tol: r.tol, usedRefs: !!r.refs, withGeom: r.geom !== false, meta: r.meta };
  }

  const payloadFromHash = () => {
    const h = location.hash;
    if (h.startsWith(PREFIX)) return h.slice(PREFIX.length);
    if (h.startsWith(OLD_PREFIX)) return h.slice(OLD_PREFIX.length);
    return null;
  };

  global.Share = { PREFIX, MAX_LEN, COLLS, encode, decode, linkFor, payloadFromHash, simplify };
})(window);
