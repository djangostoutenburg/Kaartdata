/* Beplantingsplan (PDF) importeren.
 *
 * 1. PDF kiezen; de pagina wordt met PDF.js als afbeelding getoond.
 * 2. Plaatsen: twee herkenbare punten aanwijzen, eerst in de tekening en dan op de kaart.
 *    Daaruit volgt een gelijkvormigheidstransformatie (verschuiving, schaal, draaiing).
 * 3. Vlakken: gevulde vormen uit de PDF (vectortekening uit CAD) worden per kleur gegroepeerd.
 *    Namen komen uit de legenda (gekleurd blokje + tekst ernaast) of uit tekst in de vakken.
 * Bij een gescande PDF (geen vormen) blijft de tekening als doorzichtige achtergrond staan
 * om de vakken over te tekenen.
 */
(function (global) {
  'use strict';

  const PDFJS_SRC = 'vendor/pdfjs/pdf.min.js';
  const WORKER_SRC = 'vendor/pdfjs/pdf.worker.min.js';
  const MAX_PX = 3600;            // maximale lange zijde van de gerenderde tekening
  const PT_M = 0.0254 / 72;       // 1 PDF-punt in meter op papier

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let ctx = null;                 // { map, addFeatures, toast, isMobile, layersControl, defaultColor }
  let panel, state;

  // ------------------------------------------------------------------ PDF.js laden (alleen als nodig)
  let pdfjsPromise = null;
  function loadPdfjs() {
    if (global.pdfjsLib) return Promise.resolve(global.pdfjsLib);
    if (!pdfjsPromise) {
      pdfjsPromise = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = PDFJS_SRC;
        s.onload = () => {
          global.pdfjsLib.GlobalWorkerOptions.workerSrc = WORKER_SRC;
          resolve(global.pdfjsLib);
        };
        s.onerror = () => reject(new Error('De PDF-lezer kon niet worden geladen.'));
        document.head.appendChild(s);
      });
    }
    return pdfjsPromise;
  }

  // ------------------------------------------------------------------ Geometrie-hulpjes
  const mul = (m, n) => [   // m gevolgd door n (PDF-matrixvolgorde)
    m[0] * n[0] + m[1] * n[2], m[0] * n[1] + m[1] * n[3],
    m[2] * n[0] + m[3] * n[2], m[2] * n[1] + m[3] * n[3],
    m[4] * n[0] + m[5] * n[2] + n[4], m[4] * n[1] + m[5] * n[3] + n[5],
  ];
  const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
  function ringArea(r) {
    let a = 0;
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j][0] + r[i][0]) * (r[j][1] - r[i][1]);
    return Math.abs(a / 2);
  }
  function inRing(pt, r) {
    let inside = false;
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const [xi, yi] = r[i], [xj, yj] = r[j];
      if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < (xj - xi) * (pt[1] - yi) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }
  const bboxOf = (r) => r.reduce((b, [x, y]) => [Math.min(b[0], x), Math.min(b[1], y), Math.max(b[2], x), Math.max(b[3], y)], [Infinity, Infinity, -Infinity, -Infinity]);
  function hexOf(c) {
    if (typeof c === 'string') return c.toLowerCase();
    if (Array.isArray(c) || ArrayBuffer.isView(c)) {
      const [r, g, b] = c;
      const k = r <= 1 && g <= 1 && b <= 1 ? 255 : 1;
      return '#' + [r, g, b].map(v => Math.round(v * k).toString(16).padStart(2, '0')).join('');
    }
    return '#000000';
  }
  function saturation(hex) {
    const n = parseInt(hex.slice(1), 16), r = (n >> 16) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    return mx === 0 ? 0 : (mx - mn) / mx;
  }
  const lightness = (hex) => { const n = parseInt(hex.slice(1), 16); return (((n >> 16) & 255) + ((n >> 8) & 255) + (n & 255)) / 765; };

  // ------------------------------------------------------------------ Vormen uit de PDF halen
  // Geeft vormen in pixelcoördinaten van de gerenderde tekening (viewport).
  async function extractShapes(page, viewport) {
    const OPS = global.pdfjsLib.OPS;
    const ops = await page.getOperatorList();
    const shapes = [];
    const lines = [];               // alle getekende lijnen (voor automatisch plaatsen)
    let st = { ctm: [1, 0, 0, 1, 0, 0], fill: '#000000', stroke: '#000000' };
    const stack = [];
    let sub = [];                 // subpaden van het huidige pad (in pagina-coördinaten)

    const toPx = (x, y) => {
      const [ux, uy] = apply(st.ctm, x, y);
      return viewport.convertToViewportPoint(ux, uy);
    };

    function buildPath(opsArr, coords) {
      let cur = null, i = 0, last = [0, 0];
      const start = (pt, from) => { cur = { pts: [pt], closed: false, from }; sub.push(cur); };
      const curve = (p0, c1, c2, p3) => {
        for (let t = 0.25; t <= 1.0001; t += 0.25) {
          const u = 1 - t;
          const x = u * u * u * p0[0] + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t * t * t * p3[0];
          const y = u * u * u * p0[1] + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t * t * t * p3[1];
          cur.pts.push(toPx(x, y));
        }
      };
      for (const op of opsArr) {
        if (op === OPS.moveTo) { last = [coords[i], coords[i + 1]]; start(toPx(last[0], last[1]), last); i += 2; }
        else if (op === OPS.lineTo) { if (!cur) start(toPx(last[0], last[1]), last); last = [coords[i], coords[i + 1]]; cur.pts.push(toPx(last[0], last[1])); i += 2; }
        else if (op === OPS.curveTo) { if (!cur) start(toPx(last[0], last[1]), last); const c1 = [coords[i], coords[i + 1]], c2 = [coords[i + 2], coords[i + 3]], p3 = [coords[i + 4], coords[i + 5]]; curve(last, c1, c2, p3); last = p3; i += 6; }
        else if (op === OPS.curveTo2) { if (!cur) start(toPx(last[0], last[1]), last); const c2 = [coords[i], coords[i + 1]], p3 = [coords[i + 2], coords[i + 3]]; curve(last, last, c2, p3); last = p3; i += 4; }
        else if (op === OPS.curveTo3) { if (!cur) start(toPx(last[0], last[1]), last); const c1 = [coords[i], coords[i + 1]], p3 = [coords[i + 2], coords[i + 3]]; curve(last, c1, p3, p3); last = p3; i += 4; }
        else if (op === OPS.closePath) { if (cur) { cur.closed = true; if (cur.from) last = cur.from; cur = null; } }
        else if (op === OPS.rectangle) {
          const [x, y, w, h] = [coords[i], coords[i + 1], coords[i + 2], coords[i + 3]];
          sub.push({ pts: [toPx(x, y), toPx(x + w, y), toPx(x + w, y + h), toPx(x, y + h)], closed: true, rect: true });
          cur = null; i += 4;
        }
      }
    }

    function paint(kind) {
      sub.filter(s => s.pts.length === 2).forEach(s => lines.push(s.pts));
      const rings = sub.filter(s => s.pts.length >= 3).map(s => {
        const pts = s.pts.filter((p, k) => k === 0 || Math.hypot(p[0] - s.pts[k - 1][0], p[1] - s.pts[k - 1][1]) > 0.01);
        const f = pts[0], l = pts[pts.length - 1];
        const closedGeom = Math.hypot(f[0] - l[0], f[1] - l[1]) < 0.5;
        if (closedGeom && pts.length > 3) pts.pop();
        return { pts, closed: s.closed || closedGeom, rect: !!s.rect };
      }).filter(r => r.pts.length >= 3);
      sub = [];
      rings.forEach(r => lines.push(r.closed ? [...r.pts, r.pts[0]] : r.pts));
      if (!rings.length) return;
      const isFill = kind === 'fill';
      const use = isFill ? rings : rings.filter(r => r.closed);
      if (!use.length) return;
      // Buitenringen en gaten: een ring die binnen een andere ring ligt is een gat
      use.sort((a, b) => ringArea(b.pts) - ringArea(a.pts));
      const polys = [];
      use.forEach(r => {
        const host = isFill ? polys.find(p => inRing(r.pts[0], p.outer) && !p.holes.some(h => inRing(r.pts[0], h))) : null;
        if (host) host.holes.push(r.pts);
        else polys.push({ outer: r.pts, holes: [], rect: r.rect && r.pts.length === 4 });
      });
      polys.forEach(p => shapes.push({ ...p, kind: isFill ? 'fill' : 'outline', color: isFill ? st.fill : st.stroke, area: ringArea(p.outer) - p.holes.reduce((t, h) => t + ringArea(h), 0) }));
    }

    const FILL = new Set([OPS.fill, OPS.eoFill, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke]);
    const STROKE = new Set([OPS.stroke, OPS.closeStroke]);
    for (let k = 0; k < ops.fnArray.length; k++) {
      const fn = ops.fnArray[k], a = ops.argsArray[k];
      if (fn === OPS.save) stack.push({ ...st });
      else if (fn === OPS.restore) st = stack.pop() || st;
      else if (fn === OPS.transform) st.ctm = mul(a, st.ctm);
      else if (fn === OPS.paintFormXObjectBegin) { stack.push({ ...st }); if (a && a[0]) st.ctm = mul(a[0], st.ctm); }
      else if (fn === OPS.paintFormXObjectEnd) st = stack.pop() || st;
      else if (fn === OPS.setFillRGBColor) st.fill = hexOf(a.length === 1 ? a[0] : a);
      else if (fn === OPS.setStrokeRGBColor) st.stroke = hexOf(a.length === 1 ? a[0] : a);
      else if (fn === OPS.constructPath) buildPath(a[0], a[1]);
      else if (FILL.has(fn)) paint('fill');
      else if (STROKE.has(fn)) paint('outline');
      else if (fn === OPS.endPath) sub = [];
    }
    return { shapes, lines };
  }

  // Tekst met positie (pixels) — voor legenda en plantcodes in de vakken
  async function extractTexts(page, viewport) {
    const tc = await page.getTextContent();
    return tc.items.filter(it => it.str && it.str.trim()).map(it => {
      const [a, b, , , e, f] = it.transform;
      const len = Math.hypot(a, b) || 1;
      const w = it.width || 0;
      const x0 = viewport.convertToViewportPoint(e, f);
      const x1 = viewport.convertToViewportPoint(e + (a / len) * w, f + (b / len) * w);
      const h = Math.hypot(it.transform[2], it.transform[3]) * viewport.scale || 10;
      return { str: it.str.trim(), x: (x0[0] + x1[0]) / 2, y: (x0[1] + x1[1]) / 2 - h * 0.3, left: Math.min(x0[0], x1[0]), base: x0[1], h };
    });
  }

  async function getExtraction() {
    if (!state.extraction) {
      const [ex, texts] = await Promise.all([extractShapes(state.page, state.viewport), extractTexts(state.page, state.viewport)]);
      state.extraction = { shapes: ex.shapes, lines: ex.lines, texts };
    }
    return state.extraction;
  }

  // Vormen opschonen, groeperen per kleur, namen zoeken in legenda en vakken
  function analyse(shapes, texts, pageW, pageH) {
    const pageArea = pageW * pageH;
    const minArea = pageArea * 0.00002;
    const keep = shapes.filter(s =>
      s.area > minArea && s.area < pageArea * 0.6 &&
      !(s.kind === 'fill' && lightness(s.color) > 0.97));   // witte achtergronden
    // Legenda: klein gevuld rechthoekje met tekst er direct rechts naast
    const legend = {};
    keep.filter(s => s.kind === 'fill' && s.rect && s.area < pageArea * 0.002).forEach(s => {
      const [x0, y0, x1, y1] = bboxOf(s.outer);
      const hit = texts
        .filter(t => t.left >= x1 - 2 && t.left <= x1 + (x1 - x0) * 3 + 20 && t.y >= y0 - (y1 - y0) && t.y <= y1 + (y1 - y0))
        .sort((p, q) => p.left - q.left)[0];
      if (hit) { legend[s.color] = legend[s.color] || hit.str; s.legend = true; }
    });
    const streetNames = state.streetNames || new Set();
    const items = keep.filter(s => !s.legend).map(s => {
      const inside = texts.filter(t => !streetNames.has(norm(t.str)) && inRing([t.x, t.y], s.outer) && !s.holes.some(h => inRing([t.x, t.y], h)));
      return { ...s, label: inside.map(t => t.str).join(' ').trim() };
    });
    // Een tekst hoort bij het kleinste vak waarin hij valt
    items.forEach(s => { s.labelFor = s.label; });
    const groups = new Map();
    items.forEach(s => {
      const key = `${s.kind}:${s.color}`;
      if (!groups.has(key)) groups.set(key, { key, kind: s.kind, color: s.color, items: [] });
      groups.get(key).items.push(s);
    });
    return [...groups.values()].map(g => {
      const counts = {};
      g.items.forEach(s => { if (s.label) counts[s.label] = (counts[s.label] || 0) + 1; });
      const common = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
      g.legendName = legend[g.color] || '';
      g.name = g.legendName || (common ? common[0] : '');
      g.pxArea = g.items.reduce((t, s) => t + s.area, 0);
      // Standaard aanvinken: gevulde, gekleurde vlakken (geen grijs/zwart zoals gebouwen of kaders)
      g.checked = g.kind === 'fill' && saturation(g.color) > 0.12;
      return g;
    }).sort((a, b) => (b.checked - a.checked) || (b.pxArea - a.pxArea));
  }


  // ------------------------------------------------------------------ Automatisch plaatsen
  // Straatnamen + schaal uit de tekst, BGT rond die straten ophalen en de lijnen van de tekening
  // daarop laten vallen (draaiing via hoofdrichtingen, positie via een afstandskaart).
  const LS = 'https://api.pdok.nl/bzk/locatieserver/search/v3_1/free';
  const GEMEENTE = 'Amsterdam';     // alle plannen liggen in Amsterdam: alleen daar zoeken
  const BGT = 'https://api.pdok.nl/lv/bgt/ogc/v1/collections';
  const norm = (t) => String(t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
  const tick = () => new Promise(r => setTimeout(r, 0));

  function findScales(texts) {
    const counts = {};
    texts.forEach(t => {
      const re = /1\s*[:：]\s*([0-9][0-9.]{0,6})/g;
      let m;
      while ((m = re.exec(t.str))) {
        const n = parseInt(m[1].replace(/\./g, ''), 10);
        if (n >= 20 && n <= 10000) counts[n] = (counts[n] || 0) + 1;
      }
    });
    return Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([n]) => +n);
  }

  async function findStreets(texts, progress) {
    // Kandidaten: losse teksten met letters, zonder datum/codes; grootste letters eerst
    const seen = new Set();
    const cands = texts
      .filter(t => /[a-z]{3}/i.test(t.str) && t.str.length <= 50 && !/\d{2,}[-/.]\d/.test(t.str))
      .sort((a, b) => b.h - a.h)
      .filter(t => { const k = norm(t.str); if (!k || seen.has(k)) return false; seen.add(k); return true; })
      .slice(0, 40);
    const words = new Set(texts.flatMap(t => norm(t.str).split(' ')));
    const allText = ' ' + texts.map(t => norm(t.str)).join(' ') + ' ';
    const matches = [];
    let done = 0;
    const one = async (t) => {
      const q = norm(t.str);
      const url = `${LS}?rows=10&fq=type:weg&fq=gemeentenaam:${encodeURIComponent(GEMEENTE)}&fl=straatnaam,woonplaatsnaam,gemeentenaam,centroide_ll&q=${encodeURIComponent(t.str)}`;
      try {
        const d = await (await fetch(url)).json();
        (d.response?.docs || []).forEach(doc => {
          const sn = norm(doc.straatnaam);
          if (sn && (q === sn || q.startsWith(sn + ' ') && /^\d/.test(q.slice(sn.length + 1)))) {
            const m = /POINT\(([-\d.]+) ([-\d.]+)\)/.exec(doc.centroide_ll || '');
            if (m) matches.push({ street: doc.straatnaam, place: doc.woonplaatsnaam, gemeente: doc.gemeentenaam, ll: [+m[2], +m[1]] });
          }
        });
      } catch (e) { /* overslaan */ }
      progress(`Straatnamen zoeken (${++done}/${cands.length})`);
    };
    for (let i = 0; i < cands.length; i += 6) await Promise.all(cands.slice(i, i + 6).map(one));
    if (!matches.length) return null;
    // Plaats met de meeste gevonden straten (bonus als de plaats- of gemeentenaam ook op het plan staat)
    const byPlace = {};
    matches.forEach(m => {
      const k = m.place;
      byPlace[k] = byPlace[k] || { place: m.place, gemeente: m.gemeente, streets: new Map() };
      byPlace[k].streets.set(m.street, m.ll);
    });
    const scored = Object.values(byPlace).map(p => ({
      ...p,
      score: p.streets.size + (allText.includes(' ' + norm(p.place) + ' ') ? 3 : 0) + (allText.includes(' ' + norm(p.gemeente) + ' ') ? 2 : 0),
    })).sort((a, b) => b.score - a.score);
    const best = scored[0];
    const pts = [...best.streets.values()];
    // Straten die ver van de rest liggen niet meetellen voor het midden
    const med = (arr) => arr.slice().sort((a, b) => a - b)[Math.floor(arr.length / 2)];
    const c0 = [med(pts.map(p => p[0])), med(pts.map(p => p[1]))];
    const near = pts.filter(p => Math.hypot((p[0] - c0[0]) * 111, (p[1] - c0[1]) * 68) < 1.5);
    const center = [near.reduce((t, p) => t + p[0], 0) / near.length, near.reduce((t, p) => t + p[1], 0) / near.length];
    return { center, place: best.place, streets: [...best.streets.keys()] };
  }

  async function fetchTarget(center, radius, progress) {
    const kx = 111320 * Math.cos(center[0] * Math.PI / 180), ky = 110540;
    const dLat = radius / ky, dLng = radius / kx;
    const now = new Date().toISOString().slice(0, 19) + 'Z';
    const colls = ['pand', 'wegdeel', 'ondersteunendwegdeel', 'begroeidterreindeel', 'onbegroeidterreindeel', 'waterdeel'];
    // Gebied in 2×2 vakken, alles tegelijk ophalen (veel sneller dan één groot verzoek met pagina's)
    const tiles = [];
    for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) {
      tiles.push([center[1] - dLng + i * dLng, center[0] - dLat + j * dLat, center[1] - dLng + (i + 1) * dLng, center[0] - dLat + (j + 1) * dLat].map(v => v.toFixed(6)).join(','));
    }
    const rings = [];
    const seen = new Set();
    let n = 0;
    await Promise.all(colls.flatMap(c => tiles.map(async (bbox) => {
      let url = `${BGT}/${c}/items?f=json&limit=1000&bbox=${bbox}&datetime=${now}`;
      for (let page = 0; url && page < 6; page++) {
        const d = await (await fetch(url)).json();
        (d.features || []).forEach(f => {
          const id = f.properties?.lokaal_id || f.id;
          if (seen.has(id)) return;
          seen.add(id);
          const g = f.geometry;
          const polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
          polys.forEach(p => p.forEach(r => rings.push(r.map(([lng, lat]) => [(lng - center[1]) * kx, (lat - center[0]) * ky]))));
        });
        n += (d.features || []).length;
        progress(`Ondergrond (BGT) ophalen: ${n} objecten`);
        url = (d.links || []).find(l => l.rel === 'next')?.href;
      }
    })));
    return { rings, kx, ky };
  }

  // Afstandskaart (meter) tot de dichtstbijzijnde BGT-lijn, cel 1 m
  function distanceField(rings, R) {
    const size = Math.ceil(2 * R) + 1, off = R;
    const INF = 1e6;
    const d = new Float32Array(size * size).fill(INF);
    const mark = (x, y) => { const i = Math.round(x + off), j = Math.round(y + off); if (i >= 0 && j >= 0 && i < size && j < size) d[j * size + i] = 0; };
    rings.forEach(r => {
      for (let k = 1; k < r.length; k++) {
        const [x0, y0] = r[k - 1], [x1, y1] = r[k];
        const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / 0.5));
        for (let s = 0; s <= n; s++) mark(x0 + (x1 - x0) * s / n, y0 + (y1 - y0) * s / n);
      }
    });
    const D = Math.SQRT2;
    for (let j = 0; j < size; j++) for (let i = 0; i < size; i++) {
      const k = j * size + i; let v = d[k];
      if (i > 0) v = Math.min(v, d[k - 1] + 1);
      if (j > 0) { v = Math.min(v, d[k - size] + 1); if (i > 0) v = Math.min(v, d[k - size - 1] + D); if (i < size - 1) v = Math.min(v, d[k - size + 1] + D); }
      d[k] = v;
    }
    for (let j = size - 1; j >= 0; j--) for (let i = size - 1; i >= 0; i--) {
      const k = j * size + i; let v = d[k];
      if (i < size - 1) v = Math.min(v, d[k + 1] + 1);
      if (j < size - 1) { v = Math.min(v, d[k + size] + 1); if (i < size - 1) v = Math.min(v, d[k + size + 1] + D); if (i > 0) v = Math.min(v, d[k + size - 1] + D); }
      d[k] = v;
    }
    return { d, size, off, at(x, y) { const i = Math.round(x + off), j = Math.round(y + off); return (i < 0 || j < 0 || i >= size || j >= size) ? 50 : d[j * size + i]; } };
  }

  // Exacte afstand tot de dichtstbijzijnde BGT-lijn via een rooster van lijnstukken (voor de fijne passing)
  function segmentIndex(segs, cell = 4) {
    const grid = new Map();
    const key = (i, j) => i * 100003 + j;
    segs.forEach((sg, n) => {
      const [x0, y0, x1, y1] = sg;
      const i0 = Math.floor(Math.min(x0, x1) / cell), i1 = Math.floor(Math.max(x0, x1) / cell);
      const j0 = Math.floor(Math.min(y0, y1) / cell), j1 = Math.floor(Math.max(y0, y1) / cell);
      for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) { const k = key(i, j); (grid.get(k) || grid.set(k, []).get(k)).push(n); }
    });
    return (x, y, cap) => {
      const ci = Math.floor(x / cell), cj = Math.floor(y / cell);
      let best = cap;
      for (let i = ci - 1; i <= ci + 1; i++) for (let j = cj - 1; j <= cj + 1; j++) {
        const list = grid.get(key(i, j));
        if (!list) continue;
        for (const n of list) {
          const [x0, y0, x1, y1] = segs[n];
          const dx = x1 - x0, dy = y1 - y0, l2 = dx * dx + dy * dy;
          let t = l2 ? ((x - x0) * dx + (y - y0) * dy) / l2 : 0;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          const d = Math.hypot(x0 + t * dx - x, y0 + t * dy - y);
          if (d < best) best = d;
        }
      }
      return best;
    };
  }

  // Hoofdrichting (0-90°) van een verzameling lijnen, gewogen naar lengte
  function dominantAngle(segs) {
    const h = new Float64Array(90);
    segs.forEach(([x0, y0, x1, y1]) => {
      const len = Math.hypot(x1 - x0, y1 - y0);
      if (len < 0.5) return;
      let a = Math.atan2(y1 - y0, x1 - x0) * 180 / Math.PI;
      a = ((a % 90) + 90) % 90;
      h[Math.floor(a) % 90] += len;
    });
    let best = 0, bv = -1;
    for (let i = 0; i < 90; i++) { const v = h[(i + 89) % 90] + 2 * h[i] + h[(i + 1) % 90]; if (v > bv) { bv = v; best = i; } }
    return best + 0.5;
  }

  async function autoPlace(progress) {
    const { lines, texts } = await getExtraction();
    const W = state.canvas.width, H = state.canvas.height;
    const scales = findScales(texts);
    progress('Straatnamen zoeken');
    const loc = await findStreets(texts, progress);
    if (!loc) throw new Error('Er is geen straatnaam op het plan gevonden die bij PDOK bekend is.');
    state.streetNames = new Set(loc.streets.map(norm));
    const tryScales = scales.length ? scales.slice(0, 2) : [200, 250, 100, 500];
    const mpps = tryScales.map(n => n * PT_M / state.scale);
    const halfDiag = Math.hypot(W, H) / 2 * Math.max(...mpps);
    const R = Math.min(800, Math.round(halfDiag + 250));
    const target = await fetchTarget(loc.center, R, progress);
    if (target.rings.length < 20) throw new Error('Te weinig BGT-ondergrond gevonden rond ' + loc.streets[0] + '.');
    progress('Ondergrond voorbereiden');
    await tick();
    const field = distanceField(target.rings, R);
    const tSegs = [];
    target.rings.forEach(r => { for (let k = 1; k < r.length; k++) tSegs.push([r[k - 1][0], r[k - 1][1], r[k][0], r[k][1]]); });
    const tDom = dominantAngle(tSegs);

    let best = null;
    for (const [si, mpp] of mpps.entries()) {
      // Lijnen van de tekening in meters (y omhoog), rond het midden van het blad; kaders en tekst-krabbels eruit
      const pts = [], segs = [];
      lines.forEach(l => {
        const bb = bboxOf(l);
        const bw = (bb[2] - bb[0]) * mpp, bh = (bb[3] - bb[1]) * mpp;
        if (Math.hypot(bw, bh) < 1) return;                                    // tekst/arcering
        if (bb[2] - bb[0] > W * 0.6 || bb[3] - bb[1] > H * 0.6) return;        // kaders en titelblokranden
        for (let k = 1; k < l.length; k++) {
          const x0 = (l[k - 1][0] - W / 2) * mpp, y0 = -(l[k - 1][1] - H / 2) * mpp, x1 = (l[k][0] - W / 2) * mpp, y1 = -(l[k][1] - H / 2) * mpp;
          segs.push([x0, y0, x1, y1]);
          const n = Math.max(1, Math.floor(Math.hypot(x1 - x0, y1 - y0)));
          for (let s = 0; s < n; s++) pts.push([x0 + (x1 - x0) * s / n, y0 + (y1 - y0) * s / n]);
        }
      });
      if (pts.length < 50) continue;
      // vaste steekproef
      const pick = (n) => { const out = []; const step = pts.length / n; for (let i = 0; i < n && i * step < pts.length; i++) out.push(pts[Math.floor(i * step)]); return out; };
      const coarse = pick(260), fine = pick(1500);
      const sDom = dominantAngle(segs);
      const rots = [];
      for (let k = 0; k < 4; k++) for (const f of [-1, 0, 1]) rots.push(tDom - sDom + k * 90 + f);
      const span = Math.max(40, R - Math.min(R * 0.5, halfDiag * 0.3));
      const { d: F, size, off } = field;
      const n = coarse.length;
      const rx = new Float64Array(n), ry = new Float64Array(n);
      const cands = [];
      let floor = 0.2;
      for (const [ri, rot] of rots.entries()) {
        progress(`Tekening op de ondergrond passen (${Math.round(((si * rots.length + ri) / (mpps.length * rots.length)) * 100)}%)`);
        await tick();
        const c = Math.cos(rot * Math.PI / 180), s2 = Math.sin(rot * Math.PI / 180);
        for (let k = 0; k < n; k++) { const [x, y] = coarse[k]; rx[k] = c * x - s2 * y + off + 0.5; ry[k] = s2 * x + c * y + off + 0.5; }
        for (let ty = -span; ty <= span; ty += 4) for (let tx = -span; tx <= span; tx += 4) {
          let sc = 0;
          for (let k = 0; k < n; k++) {
            const i = (rx[k] + tx) | 0, j = (ry[k] + ty) | 0;
            if (i >= 0 && j >= 0 && i < size && j < size) { const dd = F[j * size + i]; if (dd < 4) sc += 1 - dd / 4; }
            if (k === 80 && sc < floor * 81 * 0.5) break;     // kansloos: vroeg stoppen
          }
          sc /= n;
          if (sc > floor) { cands.push({ rot, tx, ty, sc }); if (cands.length > 200) { cands.sort((a, b) => b.sc - a.sc); cands.length = 12; floor = Math.max(floor, cands[11].sc); } }
        }
      }
      cands.sort((a, b) => b.sc - a.sc);
      // Verfijnen met de exacte afstand tot de BGT-lijnen
      const exact = segmentIndex(tSegs);
      const scoreExact = (rot, tx, ty, tol) => {
        const c = Math.cos(rot * Math.PI / 180), s3 = Math.sin(rot * Math.PI / 180);
        let sc = 0;
        for (const [x, y] of fine) { const dd = exact(c * x - s3 * y + tx, s3 * x + c * y + ty, tol); if (dd < tol) sc += 1 - dd / tol; }
        return sc / fine.length;
      };
      const STAGES = [[2, 0.5, 3], [1, 0.25, 2], [0.5, 0.1, 1.2], [0.2, 0.04, 0.8], [0.08, 0.015, 0.5], [0.03, 0.006, 0.35]];
      const climb = (cur, [stepT, stepR, tol]) => {
        cur = { ...cur, sc: scoreExact(cur.rot, cur.tx, cur.ty, tol) };
        let improved = true, guard = 0;
        while (improved && guard++ < 40) {
          improved = false;
          for (const [dx, dy, dr] of [[stepT, 0, 0], [-stepT, 0, 0], [0, stepT, 0], [0, -stepT, 0], [0, 0, stepR], [0, 0, -stepR]]) {
            const sc = scoreExact(cur.rot + dr, cur.tx + dx, cur.ty + dy, tol);
            if (sc > cur.sc + 1e-6) { cur = { rot: cur.rot + dr, tx: cur.tx + dx, ty: cur.ty + dy, sc }; improved = true; }
          }
        }
        return cur;
      };
      const seenC = [];
      for (const c0 of cands) {
        if (seenC.some(q => Math.abs(q.rot - c0.rot) < 2 && Math.hypot(q.tx - c0.tx, q.ty - c0.ty) < 8)) continue;
        seenC.push(c0);
        if (seenC.length >= 4) break;
      }
      progress('Passing verfijnen');
      await tick();
      // eerste ronde voor alle kandidaten, de rest alleen voor de beste
      const ranked = seenC.map(c0 => climb({ rot: c0.rot, tx: c0.tx, ty: c0.ty }, STAGES[0])).sort((a, b) => b.sc - a.sc);
      let cur = ranked[0];
      if (!cur) continue;
      for (const st of STAGES.slice(1)) { cur = climb(cur, st); await tick(); }
      const c = Math.cos(cur.rot * Math.PI / 180), s4 = Math.sin(cur.rot * Math.PI / 180);
      const fit = fine.filter(([x, y]) => exact(c * x - s4 * y + cur.tx, s4 * x + c * y + cur.ty, 1) < 0.5).length / fine.length;
      if (!best || fit > best.fit) best = { ...cur, fit, mpp, scaleN: tryScales[si] };
    }
    if (!best) throw new Error('De lijnen van de tekening konden niet op de ondergrond worden gelegd.');
    const { kx, ky } = target;
    const c = Math.cos(best.rot * Math.PI / 180), s = Math.sin(best.rot * Math.PI / 180);
    const toLatLng = (x, y) => {
      const mx = (x - W / 2) * best.mpp, my = -(y - H / 2) * best.mpp;
      const X = c * mx - s * my + best.tx, Y = s * mx + c * my + best.ty;
      return L.latLng(loc.center[0] + Y / ky, loc.center[1] + X / kx);
    };
    const rotDeg = ((-best.rot % 360) + 360) % 360;
    return {
      transform: { toLatLng, metresPerPx: best.mpp },
      info: { place: loc.place, streets: loc.streets, scaleN: best.scaleN, scaleFromText: !!scales.length, rotation: rotDeg > 180 ? rotDeg - 360 : rotDeg, fit: best.fit },
    };
  }

  // ------------------------------------------------------------------ Transformatie tekening -> kaart
  // Pixel (x, y omlaag) -> Web Mercator meters via complexe gelijkvormigheid w = a·z + b
  function solveTransform(pairs) {
    const crs = L.CRS.EPSG3857;
    const z = pairs.map(p => ({ re: p.px[0], im: -p.px[1] }));
    const w = pairs.map(p => { const m = crs.project(p.ll); return { re: m.x, im: m.y }; });
    const dz = { re: z[1].re - z[0].re, im: z[1].im - z[0].im };
    const dw = { re: w[1].re - w[0].re, im: w[1].im - w[0].im };
    const den = dz.re * dz.re + dz.im * dz.im;
    if (den < 1e-9) return null;
    const a = { re: (dw.re * dz.re + dw.im * dz.im) / den, im: (dw.im * dz.re - dw.re * dz.im) / den };
    const b = { re: w[0].re - (a.re * z[0].re - a.im * z[0].im), im: w[0].im - (a.re * z[0].im + a.im * z[0].re) };
    const toMerc = (x, y) => L.point(a.re * x - a.im * (-y) + b.re, a.re * (-y) + a.im * x + b.im);
    // Mercator vergroot afstanden met 1/cos(φ); voor de echte schaal corrigeren
    const lat = pairs[0].ll.lat * Math.PI / 180;
    const metresPerPx = Math.hypot(a.re, a.im) * Math.cos(lat);
    return {
      toLatLng: (x, y) => crs.unproject(toMerc(x, y)),
      metresPerPx,
    };
  }

  // Tekening als (gedraaide) laag op de kaart
  const PlanOverlay = L.Layer.extend({
    initialize(img, w, h, toLatLng) { this._img = img; this._w = w; this._h = h; this._toLatLng = toLatLng; this._opacity = 0.6; },
    onAdd(map) {
      this._el = L.DomUtil.create('img', 'plan-overlay leaflet-zoom-hide');
      this._el.src = this._img;
      this._el.style.opacity = this._opacity;
      map.getPanes().overlayPane.appendChild(this._el);
      map.on('zoomend viewreset moveend', this._update, this);
      this._update();
    },
    onRemove(map) { map.off('zoomend viewreset moveend', this._update, this); this._el.remove(); },
    setOpacity(o) { this._opacity = o; if (this._el) this._el.style.opacity = o; return this; },
    getBounds() { return L.latLngBounds([this._toLatLng(0, 0), this._toLatLng(this._w, 0), this._toLatLng(this._w, this._h), this._toLatLng(0, this._h)]); },
    _update() {
      const m = this._map;
      const p0 = m.latLngToLayerPoint(this._toLatLng(0, 0));
      const p1 = m.latLngToLayerPoint(this._toLatLng(this._w, 0));
      const p3 = m.latLngToLayerPoint(this._toLatLng(0, this._h));
      const s = this._el.style;
      s.width = this._w + 'px'; s.height = this._h + 'px';
      s.transform = `matrix(${(p1.x - p0.x) / this._w},${(p1.y - p0.y) / this._w},${(p3.x - p0.x) / this._h},${(p3.y - p0.y) / this._h},${p0.x},${p0.y})`;
    },
  });

  // ------------------------------------------------------------------ Paneel
  function el(html) { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstChild; }

  function open(context) {
    ctx = context;
    if (!panel) {
      panel = el(`<aside id="planPanel" class="plan-panel" aria-label="Beplantingsplan importeren">
        <header class="plan-head">
          <div><span class="plan-step" id="planStep">Stap 1 van 3</span><h2>Beplantingsplan importeren</h2></div>
          <button type="button" class="icon-btn ghost" id="planClose" aria-label="Sluiten"><svg><use href="#i-x"/></svg></button>
        </header>
        <div class="plan-body" id="planBody"></div>
      </aside>`);
      document.getElementById('mapWrap').appendChild(panel);
      panel.querySelector('#planClose').addEventListener('click', close);
    }
    state = { pairs: [], waiting: null, overlay: state?.overlay || null };
    panel.hidden = false;
    document.body.classList.add('planning');
    stepFile();
  }

  function close() {
    if (state?.mapClick) ctx.map.off('click', state.mapClick);
    (state?.mapMarkers || []).forEach(m => m.remove());
    if (state?.preview) state.preview.remove();
    panel.hidden = true;
    document.body.classList.remove('planning');
  }

  function setStep(n, title) {
    panel.querySelector('#planStep').textContent = `Stap ${n} van 3 · ${title}`;
  }

  // Stap 1: bestand kiezen
  function stepFile() {
    setStep(1, 'PDF kiezen');
    const body = panel.querySelector('#planBody');
    body.innerHTML = `
      <label class="plan-drop" id="planDrop">
        <svg><use href="#i-upload"/></svg>
        <strong>Kies een beplantingsplan (PDF)</strong>
        <span>Of sleep het bestand hierheen. Het bestand blijft op je eigen apparaat.</span>
        <input type="file" id="planFile" accept="application/pdf,.pdf" hidden>
      </label>
      <p class="plan-hint">Het beste resultaat geeft een PDF die rechtstreeks uit AutoCAD, Vectorworks of een ander tekenprogramma komt. Bij een scan worden geen vakken herkend; de tekening komt dan als achtergrond op de kaart, zodat je de vakken kunt overtekenen.</p>
      <p class="plan-error" id="planError"></p>`;
    const input = body.querySelector('#planFile');
    input.addEventListener('change', () => input.files[0] && loadFile(input.files[0]));
    const drop = body.querySelector('#planDrop');
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); const f = e.dataTransfer.files[0]; if (f) loadFile(f); });
  }

  async function loadFile(file, pageNo = 1) {
    const body = panel.querySelector('#planBody');
    const err = body.querySelector('#planError');
    body.querySelector('#planDrop')?.classList.add('busy');
    try {
      const pdfjsLib = await loadPdfjs();
      const data = new Uint8Array(await file.arrayBuffer());
      const pdf = await pdfjsLib.getDocument({ data, isEvalSupported: false }).promise;
      state.file = file;
      state.pdf = pdf;
      await renderPage(pageNo);
      stepPlace();
    } catch (e) {
      console.error(e);
      if (err) err.textContent = 'Deze PDF kon niet worden gelezen: ' + (e.message || e);
      body.querySelector('#planDrop')?.classList.remove('busy');
    }
  }

  async function renderPage(pageNo) {
    const page = await state.pdf.getPage(pageNo);
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(6, MAX_PX / Math.max(base.width, base.height));
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    const c2d = canvas.getContext('2d');
    c2d.fillStyle = '#fff';
    c2d.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: c2d, viewport }).promise;
    state.page = page;
    state.pageNo = pageNo;
    state.viewport = viewport;
    state.scale = scale;
    state.canvas = canvas;
    state.image = canvas.toDataURL('image/jpeg', 0.85);
    state.extraction = null;
    state.groups = null;
  }

  // Stap 2: twee punten in tekening en kaart
  function stepPlace() {
    setStep(2, 'Op de kaart plaatsen');
    state.groups = null;
    state.pairs = [];
    (state.mapMarkers || []).forEach(m => m.remove());
    state.mapMarkers = [];
    if (state.preview) { state.preview.remove(); state.preview = null; }
    const pages = state.pdf.numPages;
    const body = panel.querySelector('#planBody');
    body.innerHTML = `
      ${pages > 1 ? `<div class="plan-row"><label for="planPage">Pagina</label><select id="planPage">${Array.from({ length: pages }, (_, i) => `<option value="${i + 1}" ${i + 1 === state.pageNo ? 'selected' : ''}>${i + 1} van ${pages}</option>`).join('')}</select></div>` : ''}
      <div class="plan-auto" id="planAuto"></div>
      <p class="plan-instr" id="planInstr" hidden></p>
      <div class="plan-viewer" id="planViewer"><div class="plan-canvas-wrap" id="planWrap"></div></div>
      <div class="plan-zoom">
        <button type="button" class="btn sm" data-z="-1">−</button>
        <button type="button" class="btn sm" data-z="0">Passend</button>
        <button type="button" class="btn sm" data-z="1">+</button>
        <span class="plan-scale" id="planScale"></span>
      </div>
      <div class="plan-opacity" id="planOpacityRow" hidden>
        <label for="planOpacity">Tekening op de kaart</label>
        <input type="range" id="planOpacity" min="0" max="100" value="60">
      </div>
      <div class="plan-actions">
        <button type="button" class="btn" id="planRedo" hidden>Punten opnieuw</button>
        <button type="button" class="btn" id="planManual" hidden>Handmatig plaatsen</button>
        <button type="button" class="btn primary" id="planNext" disabled>Vlakken zoeken</button>
      </div>`;
    const wrap = body.querySelector('#planWrap');
    const canvas = state.canvas;
    canvas.className = 'plan-canvas';
    wrap.appendChild(canvas);
    let zoom = 1;
    const viewer = body.querySelector('#planViewer');
    const fitWidth = () => viewer.clientWidth - 2;
    const applyZoom = () => { canvas.style.width = Math.round(fitWidth() * zoom) + 'px'; placeDots(); };
    requestAnimationFrame(applyZoom);
    body.querySelectorAll('[data-z]').forEach(b => b.addEventListener('click', () => {
      const z = +b.dataset.z;
      zoom = z === 0 ? 1 : Math.max(1, Math.min(12, zoom * (z > 0 ? 1.6 : 1 / 1.6)));
      applyZoom();
    }));
    body.querySelector('#planPage')?.addEventListener('change', async (e) => {
      await renderPage(+e.target.value);
      stepPlace();
    });

    canvas.addEventListener('click', (e) => {
      if (state.mode !== 'manual') return;
      if (state.pairs.length >= 2 && !state.waiting) return;
      if (state.waiting === 'map') return;
      const r = canvas.getBoundingClientRect();
      const px = [(e.clientX - r.left) * canvas.width / r.width, (e.clientY - r.top) * canvas.height / r.height];
      state.pairs.push({ px, ll: null });
      state.waiting = 'map';
      placeDots();
      instruct();
      if (ctx.isMobile()) ctx.toast('Tik nu op hetzelfde punt op de kaart');
    });

    state.mapClick = (e) => {
      if (state.mode !== 'manual' || state.waiting !== 'map') return;
      const pair = state.pairs[state.pairs.length - 1];
      pair.ll = e.latlng;
      const n = state.pairs.length;
      state.mapMarkers.push(L.marker(e.latlng, {
        icon: L.divIcon({ className: 'plan-pin', html: `<span>${n}</span>`, iconSize: [26, 26], iconAnchor: [13, 13] }),
        interactive: false,
      }).addTo(ctx.map));
      state.waiting = n < 2 ? 'plan' : null;
      if (n === 2) solve();
      instruct();
    };
    ctx.map.on('click', state.mapClick);

    body.querySelector('#planRedo').addEventListener('click', () => startManual());
    body.querySelector('#planManual').addEventListener('click', () => startManual());
    body.querySelector('#planNext').addEventListener('click', () => stepAreas());
    body.querySelector('#planOpacity').addEventListener('input', (e) => state.preview?.setOpacity(e.target.value / 100));

    function startManual() {
      state.mode = 'manual';
      state.pairs = [];
      (state.mapMarkers || []).forEach(m => m.remove());
      state.mapMarkers = [];
      if (state.preview) { state.preview.remove(); state.preview = null; }
      wrap.querySelectorAll('.plan-dot').forEach(d => d.remove());
      body.querySelector('#planAuto').innerHTML = '';
      body.querySelector('#planInstr').hidden = false;
      body.querySelector('#planRedo').hidden = false;
      body.querySelector('#planManual').hidden = true;
      body.querySelector('#planNext').disabled = true;
      body.querySelector('#planOpacityRow').hidden = true;
      state.waiting = 'plan';
      instruct();
    }

    // Eerst automatisch proberen (straatnaam + schaal + passen op de BGT-ondergrond)
    state.mode = 'auto';
    const autoBox = body.querySelector('#planAuto');
    const runId = (state.runId = (state.runId || 0) + 1);
    autoBox.innerHTML = '<div class="plan-auto-busy"><span class="plan-spin"></span><span id="planAutoMsg">Plan automatisch plaatsen…</span></div>';
    autoPlace((msg) => { const m = body.querySelector('#planAutoMsg'); if (m && state.runId === runId) m.textContent = msg; })
      .then(({ transform, info }) => {
        if (state.runId !== runId || state.mode !== 'auto') return;
        applyTransform(transform);
        const pct = Math.round(info.fit * 100);
        const good = info.fit >= 0.35;
        autoBox.innerHTML = `
          <div class="plan-auto-result ${good ? 'ok' : 'warn'}">
            <strong>${good ? 'Automatisch geplaatst' : 'Geplaatst, maar niet zeker'}</strong>
            <span>${esc(info.streets.slice(0, 3).join(', '))}${info.streets.length > 3 ? ' e.a.' : ''}, ${esc(info.place)}</span>
            <span>Schaal 1:${info.scaleN}${info.scaleFromText ? '' : ' (geschat)'} · draaiing ${Math.round(info.rotation)}° · ${pct}% van de lijnen valt op de BGT</span>
            <em>${good ? 'Controleer of de tekening goed op de kaart ligt.' : 'Controleer goed; ligt hij verkeerd, kies dan Handmatig plaatsen.'}</em>
          </div>`;
        body.querySelector('#planManual').hidden = false;
      })
      .catch((err) => {
        if (state.runId !== runId || state.mode !== 'auto') return;
        console.warn(err);
        autoBox.innerHTML = `<div class="plan-auto-result warn"><strong>Automatisch plaatsen lukte niet</strong><span>${esc(err.message)}</span><em>Plaats het plan met twee punten.</em></div>`;
        startManualKeepMsg();
      });
    function startManualKeepMsg() {
      const msg = autoBox.innerHTML;
      startManual();
      autoBox.innerHTML = msg;
    }

    function placeDots() {
      wrap.querySelectorAll('.plan-dot').forEach(d => d.remove());
      state.pairs.forEach((p, i) => {
        const d = document.createElement('span');
        d.className = 'plan-dot';
        d.textContent = i + 1;
        d.style.left = (p.px[0] / canvas.width * 100) + '%';
        d.style.top = (p.px[1] / canvas.height * 100) + '%';
        wrap.appendChild(d);
      });
    }
  }

  function instruct() {
    const instr = panel.querySelector('#planInstr');
    if (!instr) return;
    const n = state.pairs.length;
    const tap = ctx.isMobile() ? 'Tik' : 'Klik';
    let html;
    if (state.waiting === 'plan') {
      html = n === 0
        ? `<strong>Punt 1:</strong> ${tap} in de tekening op een herkenbaar punt, bijvoorbeeld een gebouwhoek of de hoek van een stoeprand. Zoom in de tekening in voor precisie.`
        : `<strong>Punt 2:</strong> ${tap} in de tekening op een tweede punt, zo ver mogelijk van punt 1.`;
    } else if (state.waiting === 'map') {
      html = `<strong>Punt ${n} op de kaart:</strong> ${tap} op de kaart op precies dezelfde plek. Tip: de luchtfoto (lagenknop rechtsboven) helpt.`;
    } else {
      html = '<strong>Geplaatst.</strong> Controleer of de tekening goed op de kaart ligt. Ligt hij scheef of verkeerd, kies <em>Punten opnieuw</em>.';
    }
    instr.innerHTML = html;
  }

  function applyTransform(t) {
    state.transform = t;
    const scaleN = t.metresPerPx * state.scale / PT_M;
    const sc = panel.querySelector('#planScale');
    if (sc) sc.textContent = `Schaal van de tekening ≈ 1:${Math.round(scaleN / (scaleN > 2000 ? 100 : 10)) * (scaleN > 2000 ? 100 : 10)}`;
    if (state.preview) state.preview.remove();
    state.preview = new PlanOverlay(state.image, state.canvas.width, state.canvas.height, t.toLatLng).addTo(ctx.map);
    fitBesidePanel(state.preview.getBounds());
    panel.querySelector('#planOpacityRow').hidden = false;
    panel.querySelector('#planNext').disabled = false;
  }

  // Inzoomen op een gebied naast (of onder) het paneel, zodat niets erachter valt
  function fitBesidePanel(bounds) {
    const r = panel.getBoundingClientRect(), m = ctx.map.getContainer().getBoundingClientRect();
    const mobile = ctx.isMobile();
    ctx.map.fitBounds(bounds, {
      paddingTopLeft: mobile ? [20, Math.max(0, r.bottom - m.top) + 20] : [Math.max(0, r.right - m.left) + 20, 20],
      paddingBottomRight: [20, 20],
    });
  }

  function solve() {
    const t = solveTransform(state.pairs);
    if (!t) { ctx.toast('Kies twee punten die verder uit elkaar liggen'); return; }
    applyTransform(t);
  }

  // Stap 3: vlakken kiezen en importeren
  async function stepAreas() {
    setStep(3, 'Vlakken kiezen');
    const body = panel.querySelector('#planBody');
    body.innerHTML = '<p class="plan-instr">Vlakken zoeken in de tekening…</p>';
    if (!state.groups) {
      try {
        const { shapes, texts } = await getExtraction();
        state.groups = analyse(shapes, texts, state.canvas.width, state.canvas.height);
      } catch (e) {
        console.error(e);
        state.groups = [];
      }
    }
    const t = state.transform;
    const toGeo = (ring) => {
      const out = ring.map(([x, y]) => { const ll = t.toLatLng(x, y); return [+ll.lng.toFixed(7), +ll.lat.toFixed(7)]; });
      out.push(out[0]);
      return out;
    };
    const m2PerPx2 = t.metresPerPx * t.metresPerPx;
    const groups = state.groups;
    let idx = 0;
    let idxO = 0, idxG = 0;
    groups.forEach(g => {
      if (g.kind === 'outline') g.name = g.name ? `Omtrek ${g.name}` : `Omtrek ${++idxO}`;
      else if (!g.name) g.name = saturation(g.color) > 0.12 ? `Beplanting ${++idx}` : `Overig vlak ${++idxG}`;
    });

    if (!groups.length) {
      body.innerHTML = `
        <div class="plan-empty">
          <strong>Geen vlakken gevonden in deze tekening</strong>
          <p>Waarschijnlijk is het een scan of een afbeelding in een PDF. De tekening blijft als achtergrond op de kaart staan (aan/uit via de lagenknop rechtsboven), zodat je de vakken kunt overtekenen met <em>Polygoon</em>.</p>
        </div>
        <div class="plan-actions"><button type="button" class="btn" id="planBack">Terug</button><button type="button" class="btn primary" id="planDone">Tekening als achtergrond houden</button></div>`;
      body.querySelector('#planBack').addEventListener('click', stepPlace);
      body.querySelector('#planDone').addEventListener('click', () => { keepOverlay(); close(); });
      return;
    }

    body.innerHTML = `
      <p class="plan-instr">Gevonden vlakken, gegroepeerd per kleur. Vink aan wat je wilt overnemen en geef elke groep de naam van de beplanting.${groups.some(g => g.legendName) ? ' Namen uit de legenda zijn al ingevuld.' : ''}</p>
      <ul class="plan-groups" id="planGroups">${groups.map((g, i) => g.kind === 'fill' ? groupHtml(g, i) : '').join('')}</ul>
      ${groups.some(g => g.kind === 'outline') ? `<details class="plan-more" ${groups.every(g => g.kind === 'outline') ? 'open' : ''}>
        <summary>Alleen omtrekken (${groups.filter(g => g.kind === 'outline').length} groepen)</summary>
        <p class="plan-hint">Lijnen zonder vulling, zoals randen van vakken, gebouwen en kaders. Meestal niet nodig als de vakken hierboven al gevuld zijn.</p>
        <ul class="plan-groups">${groups.map((g, i) => g.kind === 'outline' ? groupHtml(g, i) : '').join('')}</ul>
      </details>` : ''}
      <label class="plan-check"><input type="checkbox" id="planUseLabels" checked> Tekst in een vak (bijv. plantcode) als naam van dat vak gebruiken</label>
      <label class="plan-check"><input type="checkbox" id="planKeep" checked> Tekening als achtergrond op de kaart houden</label>
      <div class="plan-actions">
        <button type="button" class="btn" id="planBack">Terug</button>
        <button type="button" class="btn primary" id="planImport"></button>
      </div>`;
    const list = body;
    const btn = body.querySelector('#planImport');
    const count = () => groups.filter(g => g.checked).reduce((n, g) => n + g.items.length, 0);
    const refresh = () => { const n = count(); btn.textContent = `${n} ${n === 1 ? 'vak' : 'vakken'} importeren`; btn.disabled = !n; drawPreview(); };
    list.addEventListener('change', (e) => {
      const i = e.target.dataset.i;
      if (e.target.type === 'checkbox' && i !== undefined) { groups[i].checked = e.target.checked; e.target.closest('li').classList.toggle('on', e.target.checked); refresh(); }
    });
    list.addEventListener('input', (e) => { if (e.target.classList.contains('plan-g-name')) groups[e.target.dataset.i].name = e.target.value; });
    body.querySelector('#planBack').addEventListener('click', () => { clearShapes(); stepPlace(); });
    btn.addEventListener('click', () => {
      const useLabels = body.querySelector('#planUseLabels').checked;
      const feats = [];
      groups.filter(g => g.checked).forEach(g => g.items.forEach(s => {
        const geometry = { type: 'Polygon', coordinates: [toGeo(s.outer), ...s.holes.map(toGeo)] };
        feats.push({
          shape: 'Polygon',
          geometry,
          props: {
            name: (useLabels && s.label) ? s.label : (g.name || 'Beplanting'),
            kind: 'gebied',
            category: 'Beplanting',
            status: 'Gepland',
            ref: '',
            color: g.color,
            fill: g.kind === 'outline' ? 'geen' : 'effen',
            notes: `Uit beplantingsplan “${state.file.name}”${state.pdf.numPages > 1 ? `, pagina ${state.pageNo}` : ''}.${g.name && (useLabels && s.label) ? `\nGroep: ${g.name}.` : ''}`,
          },
        });
      }));
      clearShapes();
      if (body.querySelector('#planKeep').checked) keepOverlay();
      close();
      ctx.addFeatures(feats);
      ctx.toast(`${feats.length} ${feats.length === 1 ? 'vak' : 'vakken'} uit het plan overgenomen`);
    });

    function clearShapes() { if (state.shapeLayer) { state.shapeLayer.remove(); state.shapeLayer = null; } }
    function drawPreview() {
      clearShapes();
      state.shapeLayer = L.layerGroup().addTo(ctx.map);
      groups.filter(g => g.checked).forEach(g => g.items.forEach(s => {
        L.polygon([s.outer, ...s.holes].map(r => r.map(([x, y]) => t.toLatLng(x, y))), {
          color: g.color, weight: 2, fillColor: g.color, fillOpacity: g.kind === 'outline' ? 0 : 0.45, interactive: false, pmIgnore: true,
        }).addTo(state.shapeLayer);
      }));
    }
    refresh();
  }

  function groupHtml(g, i) {
    const m2 = g.pxArea * state.transform.metresPerPx * state.transform.metresPerPx;
    return `
        <li class="${g.checked ? 'on' : ''}">
          <input type="checkbox" id="pg${i}" data-i="${i}" ${g.checked ? 'checked' : ''}>
          <label for="pg${i}" class="plan-swatch ${g.kind}" style="--c:${esc(g.color)}"></label>
          <div class="plan-g-main">
            <input type="text" class="plan-g-name" data-i="${i}" value="${esc(g.name)}" aria-label="Naam groep ${i + 1}">
            <small>${g.items.length} ${g.items.length === 1 ? 'vak' : 'vakken'} · ${fmtArea(m2)}${g.kind === 'outline' ? ' · alleen omtrek' : ''}</small>
          </div>
        </li>`;
  }

  function keepOverlay() {
    if (!state.preview) return;
    if (state.overlay && state.overlay !== state.preview) { ctx.map.removeLayer(state.overlay); ctx.layersControl.removeLayer(state.overlay); }
    state.overlay = state.preview;
    state.preview = null;
    ctx.layersControl.addOverlay(state.overlay, 'Beplantingsplan (tekening)');
  }

  function fmtArea(m2) {
    const nf = (n, d) => n.toLocaleString('nl-NL', { maximumFractionDigits: d, minimumFractionDigits: d });
    return m2 >= 10000 ? `${nf(m2 / 10000, 2)} ha` : `${nf(m2, 0)} m²`;
  }

  global.PlanImport = { open, _internal: { solveTransform, analyse, extractShapes } };
})(window);
