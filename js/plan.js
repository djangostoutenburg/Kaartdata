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
  // Vier punten met rechte hoeken, evenwijdig aan het blad (kaders van tekengebied, titelblok, legenda)
  function isRect(pts) {
    if (pts.length !== 4 && pts.length !== 5) return false;
    const q = pts.slice(0, 4);
    return q.every((p, i) => { const n = q[(i + 1) % 4]; return Math.abs(p[0] - n[0]) < 0.5 || Math.abs(p[1] - n[1]) < 0.5; });
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
      const start = (pt, from) => { cur = { pts: [pt], closed: false, from, curve: false }; sub.push(cur); };
      const curve = (p0, c1, c2, p3) => {
        cur.curve = true;
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
      const lc = kind === 'fill' ? st.fill : st.stroke;
      sub.filter(s => s.pts.length === 2).forEach(s => lines.push({ pts: s.pts, color: lc, curve: false, closed: false, rect: false }));
      const rings = sub.filter(s => s.pts.length >= 3).map(s => {
        const pts = s.pts.filter((p, k) => k === 0 || Math.hypot(p[0] - s.pts[k - 1][0], p[1] - s.pts[k - 1][1]) > 0.01);
        const f = pts[0], l = pts[pts.length - 1];
        const closedGeom = Math.hypot(f[0] - l[0], f[1] - l[1]) < 0.5;
        if (closedGeom && pts.length > 3) pts.pop();
        return { pts, closed: s.closed || closedGeom, rect: !!s.rect, curve: !!s.curve };
      }).filter(r => r.pts.length >= 3);
      sub = [];
      rings.forEach((r, k) => lines.push({ pts: r.closed ? [...r.pts, r.pts[0]] : r.pts, color: lc, curve: !!r.curve, closed: r.closed, rect: r.rect || isRect(r.pts) }));
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

  // Tekst met positie (pixels) — voor legenda, plantcodes en straatnamen.
  // CAD-PDF's zetten vaak elke letter apart; die worden hier weer tot woorden en regels samengevoegd
  // op basis van schrijfrichting, lettergrootte en positie (de breedte in de PDF is vaak onbetrouwbaar).
  async function extractTexts(page, viewport) {
    const tc = await page.getTextContent();
    const items = tc.items.filter(it => it.str && it.str.trim()).map(it => {
      const [a, b, c, d, e, f] = it.transform;
      const la = Math.hypot(a, b) || 1;
      const p0 = viewport.convertToViewportPoint(e, f);
      const p1 = viewport.convertToViewportPoint(e + a / la, f + b / la);
      let dx = p1[0] - p0[0], dy = p1[1] - p0[1];
      const dl = Math.hypot(dx, dy) || 1; dx /= dl; dy /= dl;
      const h = (Math.hypot(c, d) || 1) * viewport.scale;
      return { s: it.str.replace(/\s+/g, ' '), x: p0[0], y: p0[1], dx, dy, h, ang: Math.atan2(dy, dx) };
    });
    // index op een grof rooster voor snelle buren
    const cell = 60, grid = new Map();
    items.forEach((it, i) => { const k = Math.floor(it.x / cell) + ':' + Math.floor(it.y / cell); (grid.get(k) || grid.set(k, []).get(k)).push(i); });
    const near = (x, y, r) => {
      const out = [];
      for (let gx = Math.floor((x - r) / cell); gx <= Math.floor((x + r) / cell); gx++)
        for (let gy = Math.floor((y - r) / cell); gy <= Math.floor((y + r) / cell); gy++) (grid.get(gx + ':' + gy) || []).forEach(i => out.push(i));
      return out;
    };
    const used = new Uint8Array(items.length);
    const sameDir = (p, q) => Math.abs(Math.atan2(Math.sin(p.ang - q.ang), Math.cos(p.ang - q.ang))) < 0.08 && Math.abs(p.h - q.h) < p.h * 0.25;
    const lines = [];
    for (let i = 0; i < items.length; i++) {
      if (used[i]) continue;
      used[i] = 1;
      const chain = [items[i]];
      // vooruit en achteruit uitbreiden
      for (const dir of [1, -1]) {
        let grew = true;
        while (grew) {
          grew = false;
          const end = dir === 1 ? chain[chain.length - 1] : chain[0];
          const reach = end.h * (0.75 * end.s.length + 1.6);
          let bestJ = -1, bestAlong = Infinity;
          for (const j of near(end.x, end.y, reach + end.h)) {
            if (used[j]) continue;
            const it = items[j];
            if (!sameDir(end, it)) continue;
            const rx = (it.x - end.x) * dir, ry = (it.y - end.y) * dir;
            const along = rx * end.dx + ry * end.dy, perp = -rx * end.dy + ry * end.dx;
            const lim = dir === 1 ? end.h * (0.75 * end.s.length + 1.6) : it.h * (0.75 * it.s.length + 1.6);
            if (Math.abs(perp) < end.h * 0.4 && along > end.h * 0.1 && along < lim && along < bestAlong) { bestAlong = along; bestJ = j; }
          }
          if (bestJ >= 0) { used[bestJ] = 1; if (dir === 1) chain.push(items[bestJ]); else chain.unshift(items[bestJ]); grew = true; }
        }
      }
      // spaties: sprong duidelijk groter dan de gewone letterafstand in deze regel
      const steps = [];
      for (let k = 1; k < chain.length; k++) {
        const p = chain[k - 1], q = chain[k];
        steps.push(((q.x - p.x) * p.dx + (q.y - p.y) * p.dy) / Math.max(1, p.s.length));
      }
      const med = steps.length ? steps.slice().sort((a, b) => a - b)[Math.floor(steps.length / 2)] : 0;
      let str = chain[0].s;
      for (let k = 1; k < chain.length; k++) {
        const p = chain[k - 1], q = chain[k];
        const along = (q.x - p.x) * p.dx + (q.y - p.y) * p.dy;
        const expected = med * p.s.length;
        const space = p.s.endsWith(' ') || q.s.startsWith(' ') || (chain.length > 2 && along > expected + Math.max(med * 0.55, p.h * 0.28));
        str += (space ? ' ' : '') + q.s;
      }
      str = str.replace(/\s+/g, ' ').trim();
      const first = chain[0], last = chain[chain.length - 1];
      const endX = last.x + last.dx * last.h * 0.6 * last.s.length, endY = last.y + last.dy * last.h * 0.6 * last.s.length;
      const h = first.h;
      // midden van de regel, iets boven de basislijn
      const mx = (first.x + endX) / 2 - first.dy * -h * 0.3, my = (first.y + endY) / 2 + first.dx * -h * 0.3;
      lines.push({ str, x: mx, y: my, left: Math.min(first.x, endX), base: first.y, h, ang: first.ang });
    }
    return lines;
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
    // Dubbele vakken eruit (CAD tekent vlakken soms twee keer, bijv. op twee lagen)
    const uniq = [];
    keep.filter(s => !s.legend).forEach(s => {
      const bb = bboxOf(s.outer);
      if (uniq.some(u => u.color === s.color && u.kind === s.kind && Math.abs(u.area - s.area) < s.area * 0.002 &&
        Math.abs(u.bb[0] - bb[0]) < 1 && Math.abs(u.bb[1] - bb[1]) < 1 && Math.abs(u.bb[2] - bb[2]) < 1 && Math.abs(u.bb[3] - bb[3]) < 1)) return;
      uniq.push({ ...s, bb });
    });
    const items = uniq.map(s => ({ ...s, texts: [] }));
    // Teksten koppelen aan het dichtstbijzijnde gevulde vak (erin, of vlak ernaast: vaknummer, GIS-ID, instructies)
    const pageDiag = Math.hypot(pageW, pageH);
    const distTo = (pt, s) => {
      if (inRing(pt, s.outer) && !s.holes.some(h => inRing(pt, h))) return 0;
      let d = Infinity;
      const r = s.outer;
      for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
        const [x0, y0] = r[j], [x1, y1] = r[i], dx = x1 - x0, dy = y1 - y0, l2 = dx * dx + dy * dy;
        let t = l2 ? ((pt[0] - x0) * dx + (pt[1] - y0) * dy) / l2 : 0; t = t < 0 ? 0 : t > 1 ? 1 : t;
        d = Math.min(d, Math.hypot(x0 + t * dx - pt[0], y0 + t * dy - pt[1]));
      }
      return d;
    };
    const fills = items.filter(s => s.kind === 'fill' && saturation(s.color) > 0.12);
    const seenText = new Set();
    texts.forEach(t => {
      if (!/[a-z]{2}/i.test(t.str) && !/\d+\s*m2|m²/i.test(t.str)) return;
      if (streetNames.has(norm(t.str).replace(/ /g, ''))) return;
      let bestS = null, bestD = pageDiag * 0.04;
      fills.forEach(s => { const d = distTo([t.x, t.y], s); if (d < bestD) { bestD = d; bestS = s; } });
      // binnen een vak telt ook voor niet-gekleurde vakken
      if (!bestS) items.forEach(s => { if (distTo([t.x, t.y], s) === 0 && (!bestS || s.area < bestS.area)) bestS = s; });
      if (!bestS) return;
      const key = bestS.bb.join(',') + '|' + norm(t.str);
      if (seenText.has(key)) return;                     // dubbel getekende tekst
      seenText.add(key);
      bestS.texts.push(t.str.replace(/\s+/g, ' ').trim());
      if (distTo([t.x, t.y], bestS) === 0) (bestS.inside = bestS.inside || []).push(t.str.replace(/\s+/g, ' ').trim());
    });
    items.forEach(s => {
      const vak = s.texts.find(x => /^vak\s*\d+/i.test(x));
      const gis = s.texts.map(x => /GIS\s*ID\s*[:#]?\s*(\d+)/i.exec(x)).find(Boolean);
      const area = s.texts.map(x => /(\d[\d.,]*)\s*m(2|²)\b/i.exec(x)).find(Boolean);
      const rest = s.texts.filter(x => x !== vak && !/GIS\s*ID/i.test(x) && !/^\d[\d.,]*\s*m(2|²)$/i.test(x));
      s.vakName = vak ? vak.replace(/^vak\s*(\d+).*/i, 'Vak $1') : '';
      s.gis = gis ? gis[1] : '';
      s.areaText = area ? `${area[1]} m²` : '';
      s.extra = rest.filter(x => x.length >= 12);
      // naam: vaknummer, anders korte tekst ín het vak (plantcode); tekst ernaast alleen in de notities
      const insideShort = (s.inside || []).filter(x => x !== vak && x.length < 12 && /[a-z]/i.test(x) && !/GIS\s*ID/i.test(x) && !/^\d[\d.,]*\s*m(2|²)$/i.test(x));
      s.label = s.vakName || [...new Set(insideShort)].join(' ') || '';
      s.extra = [...new Set([...s.extra, ...rest.filter(x => x.length < 12 && /[a-z]/i.test(x) && !insideShort.includes(x)).map(x => `Bij het vak: ${x}`)])];
    });
    const groups = new Map();
    items.forEach(s => {
      const key = `${s.kind}:${s.color}`;
      if (!groups.has(key)) groups.set(key, { key, kind: s.kind, color: s.color, items: [] });
      groups.get(key).items.push(s);
    });
    return [...groups.values()].map(g => {
      const counts = {};
      g.items.forEach(s => { if (s.label && !s.vakName) counts[s.label] = (counts[s.label] || 0) + 1; });
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
  const BRK = 'https://api.pdok.nl/kadaster/brk-kadastrale-kaart/ogc/v1/collections';
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
    // Kandidaten: elke tekst (ook kleine, bijv. het adres in het titelblok) én de straatnaam binnen een
    // langere regel ("Locatie: Drusiushof 1 t/m 5, 1069 Amsterdam" → "Drusiushof").
    const SUFFIX = /(straat|weg|laan|plein|hof|kade|gracht|pad|dijk|singel|park|plantsoen|dreef|steeg|markt|baan|ring|boulevard|kanaal|plas|erf|veld|oord|haven|brug|sloot|wal|burgwal|dwarsstraat|polder|tuin|park|zijde|lei|dam|pier|bolwerk|bosch|bos|hoek|gaarde|hof)\b/i;
    const pieces = (str) => {
      const out = new Set();
      const s0 = str.replace(/^(locatie|adres|project(?:locatie)?|plaats|werk|object|straat)\s*[:\-–]\s*/i, '');
      out.add(s0);
      s0.split(/[,;|()\/]| - | – /).forEach(part => {
        let p = part.trim()
          .replace(/\b\d{4}\s?[a-z]{2}\b.*$/i, '')                         // postcode en daarna (plaats)
          .replace(/\s+(t\/m|tot en met|nr\.?|no\.?)?\s*\d+[a-z]?(\s*(-|t\/m|tot)\s*\d+[a-z]?)?\s*$/i, '')   // huisnummer(s)
          .replace(/\s+(amsterdam|amsterdam[- ]\w+)$/i, '')
          .trim();
        if (p.length >= 4) out.add(p);
        // straatnaam ergens in een zin: woorden tot en met het woord met een straat-uitgang
        const words = p.split(/\s+/);
        words.forEach((w, i) => {
          if (!SUFFIX.test(w)) return;
          for (let k = Math.max(0, i - 3); k <= i; k++) out.add(words.slice(k, i + 1).join(' '));
        });
      });
      return [...out].filter(x => /[a-z]{3}/i.test(x) && x.length <= 50 && !/\d{2,}[-/.]\d/.test(x));
    };
    const seen = new Set();
    const scoreOf = (t, piece) => (SUFFIX.test(piece) ? 1000 : 0) + (/\d/.test(t.str) ? 300 : 0) + (/^(locatie|adres|project)/i.test(t.str) ? 500 : 0) + t.h;
    const all = [];
    texts.forEach(t => pieces(t.str).forEach(piece => {
      const k = norm(piece).replace(/ /g, '');
      if (!k || seen.has(k)) return;
      seen.add(k);
      all.push({ t, piece, score: scoreOf(t, piece) });
    }));
    const cands = all.sort((a, b) => b.score - a.score).slice(0, 110);
    const words = new Set(texts.flatMap(t => norm(t.str).split(' ')));
    const allText = ' ' + texts.map(t => norm(t.str)).join(' ') + ' ';
    const matches = [];
    const labelTexts = [];          // teksten op het plan die een straatnaam zijn (met richting)
    let done = 0;
    // Vergelijken zonder spaties/leestekens: "Adrianus van W aertweg" = "Adrianus van Waertweg"
    const compact = (t) => norm(t).replace(/ /g, '');
    const one = async ({ t, piece }) => {
      const q = compact(piece);
      // zoeken op de hele tekst én op het langste woord (vangt verkeerde spaties op)
      const longest = piece.split(/[\s.]+/).sort((a, b) => b.length - a.length)[0] || piece;
      const queries = [...new Set([piece, longest.length >= 5 ? longest : null].filter(Boolean))];
      try {
        const docs = (await Promise.all(queries.map(async (qs) => {
          const url = `${LS}?rows=20&fq=type:weg&fq=gemeentenaam:${encodeURIComponent(GEMEENTE)}&fl=straatnaam,woonplaatsnaam,gemeentenaam,centroide_ll&q=${encodeURIComponent(qs)}`;
          return (await (await fetch(url)).json()).response?.docs || [];
        }))).flat();
        docs.forEach(doc => {
          const sn = compact(doc.straatnaam);
          if (sn && (q === sn || (q.startsWith(sn) && /^\d/.test(q.slice(sn.length))))) {
            const m = /POINT\(([-\d.]+) ([-\d.]+)\)/.exec(doc.centroide_ll || '');
            if (m) matches.push({ street: doc.straatnaam, place: doc.woonplaatsnaam, gemeente: doc.gemeentenaam, ll: [+m[2], +m[1]] });
            if (!labelTexts.includes(t)) { t.streetName = doc.straatnaam; t.streetLL = [+m[2], +m[1]]; labelTexts.push(t); }
          }
        });
      } catch (e) { /* overslaan */ }
      progress(`Straatnamen zoeken (${++done}/${cands.length})`);
    };
    for (let i = 0; i < cands.length; i += 8) await Promise.all(cands.slice(i, i + 8).map(one));
    if (!matches.length) return null;
    // ook herhalingen van dezelfde straatnaam elders op het blad (bijv. groot in de tekening én klein in het kaartje)
    texts.forEach(t => {
      if (labelTexts.includes(t)) return;
      const twin = labelTexts.find(l => compact(l.str) === compact(t.str));
      if (twin) { t.streetName = twin.streetName; t.streetLL = twin.streetLL; labelTexts.push(t); }
    });
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
    return { center, place: best.place, streets: [...best.streets.keys()], labelTexts: labelTexts.filter(t => best.streets.has(t.streetName)) };
  }

  // Situatiekaartje georefereren met de straatnamen erin. Eerst met het midden van elke straat; daarna
  // (als de BGT-straatlabels er zijn) met het dichtstbijzijnde BGT-label van dezelfde naam — veel nauwkeuriger.
  // Geeft { toLL, marker: [lat,lng] } of null.
  function insetGeoref(b, labelTexts, lines, bgtLabels, init) {
    const inB = (x, y) => x >= b[0] && x <= b[2] && y >= b[1] && y <= b[3];
    const texts = labelTexts.filter(t => inB(t.x, t.y));
    if (new Set(texts.map(t => t.streetName)).size < 2) return null;
    const cname = (n) => norm(n).replace(/ /g, '');
    const lat0 = texts[0].streetLL[0], lng0 = texts[0].streetLL[1];
    const kx = 111320 * Math.cos(lat0 * Math.PI / 180), ky = 110540;
    const toM = ([lat, lng]) => [(lng - lng0) * kx, (lat - lat0) * ky];
    const pairs = [];
    texts.forEach(t => {
      let geo = t.streetLL;
      if (bgtLabels && init) {
        const guess = init.toLL(t.x, t.y);
        let bestD = Infinity;
        bgtLabels.filter(l => cname(l.name) === cname(t.streetName) && l.ll).forEach(l => {
          const d = Math.hypot((l.ll[0] - guess[0]) * ky, (l.ll[1] - guess[1]) * kx);
          if (d < bestD) { bestD = d; geo = l.ll; }
        });
      }
      pairs.push({ z: [t.x, -t.y], w: toM(geo) });
    });
    const n = pairs.length;
    const zm = [pairs.reduce((a, p) => a + p.z[0], 0) / n, pairs.reduce((a, p) => a + p.z[1], 0) / n];
    const wm = [pairs.reduce((a, p) => a + p.w[0], 0) / n, pairs.reduce((a, p) => a + p.w[1], 0) / n];
    let nr = 0, ni = 0, den = 0;
    pairs.forEach(({ z, w }) => {
      const zr = z[0] - zm[0], zi = z[1] - zm[1], wr = w[0] - wm[0], wi = w[1] - wm[1];
      nr += wr * zr + wi * zi; ni += wi * zr - wr * zi; den += zr * zr + zi * zi;
    });
    if (den < 1e-6) return null;
    const a = [nr / den, ni / den];
    const toLL = (x, y) => {
      const zr = x - zm[0], zi = -y - zm[1];
      const X = a[0] * zr - a[1] * zi + wm[0], Y = a[0] * zi + a[1] * zr + wm[1];
      return [lat0 + Y / ky, lng0 + X / kx];
    };
    // markering: sterk gekleurde lijnen/vlakken in het kaartje (rood/oranje kader, stip, vlak)
    const mark = [];
    lines.forEach(l => {
      if (saturation(l.color) < 0.5) return;
      l.pts.forEach(([x, y]) => { if (inB(x, y)) mark.push([x, y]); });
    });
    let px;
    if (mark.length >= 3) {
      const bb = bboxOf(mark);
      if ((bb[2] - bb[0]) < (b[2] - b[0]) * 0.6 && (bb[3] - bb[1]) < (b[3] - b[1]) * 0.6) px = [(bb[0] + bb[2]) / 2, (bb[1] + bb[3]) / 2];
    }
    if (!px) px = [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
    return { toLL, marker: toLL(px[0], px[1]), hasMarker: mark.length >= 3, rot: Math.atan2(a[1], a[0]) * 180 / Math.PI };
  }
  const locateFromInset = (b, labelTexts, lines) => insetGeoref(b, labelTexts, lines)?.marker || null;

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
    // BGT-ondergrond plus kadastrale percelen (veel plannen tekenen de kavelgrenzen van woningen)
    const sources = [...colls.map(c => `${BGT}/${c}/items?f=json&limit=1000&datetime=${now}`), `${BRK}/perceel/items?f=json&limit=1000`];
    await Promise.all(sources.flatMap(base => tiles.map(async (bbox) => {
      let url = `${base}&bbox=${bbox}`;
      for (let page = 0; url && page < 6; page++) {
        const d = await (await fetch(url)).json();
        (d.features || []).forEach(f => {
          const id = f.properties?.lokaal_id || f.properties?.identificatie_lokaal_id || f.id;
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
    // straatlabels (richting in graden) voor de draaiing
    const labels = [];
    try {
      const bbox = [center[1] - dLng, center[0] - dLat, center[1] + dLng, center[0] + dLat].map(v => v.toFixed(6)).join(',');
      const d = await (await fetch(`${BGT}/openbareruimtelabel/items?f=json&limit=1000&bbox=${bbox}&datetime=${now}`)).json();
      (d.features || []).forEach(f => labels.push({ name: f.properties.openbareruimtenaam, hoek: +f.properties.hoek, ll: f.geometry ? [f.geometry.coordinates[1], f.geometry.coordinates[0]] : null }));
    } catch (e) { /* zonder labels verder */ }
    return { rings, kx, ky, labels };
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

  // Afstandskaarten per richting (8 klassen van 22,5°): een lijn op het plan telt alleen
  // als er in de buurt een BGT-lijn met ongeveer dezelfde richting ligt (scherper in drukke wijken)
  const NBIN = 8;
  const binOf = (deg) => Math.floor((((deg % 180) + 180) % 180) / (180 / NBIN)) % NBIN;
  function directionalFields(rings, R) {
    const size = Math.ceil(2 * R) + 1, off = R;
    const fields = Array.from({ length: NBIN }, () => new Float32Array(size * size).fill(1e6));
    rings.forEach(r => {
      for (let k = 1; k < r.length; k++) {
        const [x0, y0] = r[k - 1], [x1, y1] = r[k];
        const len = Math.hypot(x1 - x0, y1 - y0);
        if (len < 0.3) continue;
        const b = binOf(Math.atan2(y1 - y0, x1 - x0) * 180 / Math.PI);
        const n = Math.max(1, Math.ceil(len / 0.5));
        for (const bb of [(b + NBIN - 1) % NBIN, b, (b + 1) % NBIN]) {
          const d = fields[bb];
          for (let s = 0; s <= n; s++) {
            const i = Math.round(x0 + (x1 - x0) * s / n + off), j = Math.round(y0 + (y1 - y0) * s / n + off);
            if (i >= 0 && j >= 0 && i < size && j < size) d[j * size + i] = 0;
          }
        }
      }
    });
    const D = Math.SQRT2;
    fields.forEach(d => {
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
    });
    return { fields, size, off };
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
      const r = Math.ceil(cap / cell);
      const ci = Math.floor(x / cell), cj = Math.floor(y / cell);
      let best = cap;
      for (let i = ci - r; i <= ci + r; i++) for (let j = cj - r; j <= cj + r; j++) {
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

  // Zelf ingevulde straatnaam opzoeken (Amsterdam). Geeft { center, place, streets, labelTexts } of null.
  async function lookupStreet(name) {
    const url = `${LS}?rows=10&fq=type:weg&fq=gemeentenaam:${encodeURIComponent(GEMEENTE)}&fl=straatnaam,woonplaatsnaam,centroide_ll&q=${encodeURIComponent(name)}`;
    const docs = (await (await fetch(url)).json()).response?.docs || [];
    const want = norm(name).replace(/ /g, '');
    const doc = docs.find(d => norm(d.straatnaam).replace(/ /g, '') === want) || docs[0];
    const m = doc && /POINT\(([-\d.]+) ([-\d.]+)\)/.exec(doc.centroide_ll || '');
    if (!m) return null;
    return { center: [+m[2], +m[1]], place: doc.woonplaatsnaam, streets: [doc.straatnaam], labelTexts: [] };
  }

  async function autoPlace(progress, opts = {}) {
    const { lines, texts } = await getExtraction();
    const W = state.canvas.width, H = state.canvas.height;
    const scales = findScales(texts);
    progress('Straatnamen zoeken');
    let loc = texts.length ? await findStreets(texts, progress) : null;
    if (opts.street) {
      progress('Straat opzoeken');
      const own = await lookupStreet(opts.street);
      if (!own) throw new Error(`“${opts.street}” is niet gevonden als straat in Amsterdam. Controleer de spelling.`);
      // straatnamen uit de tekening van dezelfde straat blijven bruikbaar voor de draaiing
      const sameName = (t) => norm(t.streetName).replace(/ /g, '') === norm(own.streets[0]).replace(/ /g, '');
      own.labelTexts = loc ? loc.labelTexts.filter(sameName) : [];
      loc = own;
      loc.manual = true;
    }
    if (!loc) {
      const words = texts.filter(t => /[a-z]{4}/i.test(t.str)).length;
      throw new Error(words < 5
        ? 'In deze PDF staat (bijna) geen leesbare tekst: de letters zijn als lijnen getekend of het is een scan. Vul de straatnaam hieronder in.'
        : 'Er is geen straatnaam op het plan gevonden die bij PDOK in Amsterdam bekend is.');
    }
    state.streetNames = new Set(loc.streets.map(t => norm(t).replace(/ /g, '')));
    // De schaal op het plan klopt niet altijd ("Ntb", passend afgedrukt): een reeks schalen proberen en
    // daarna traploos bijstellen. Schalen uit de tekst gaan voorop.
    const series = [];
    for (let n = 150; n <= 1100; n *= 1.14) series.push(Math.round(n));
    let tryScales = [...new Set([...scales.slice(0, 2), ...series])];
    if (global.__planForce?.scales) tryScales = global.__planForce.scales;
    const mppOf = (n) => n * PT_M / state.scale;

    // Kaders op het blad: tekengebied, titelblok, legenda en eventueel een situatiekaartje
    const rects = lines.filter(l => l.rect).map(l => bboxOf(l.pts)).filter(b => (b[2] - b[0]) * (b[3] - b[1]) > W * H * 0.002);
    const inB = (b, x, y) => x >= b[0] && x <= b[2] && y >= b[1] && y <= b[3];
    const areaOf = (b) => (b[2] - b[0]) * (b[3] - b[1]);
    const titleTexts = texts.filter(t => /^(schaal|project|opdrachtgever|tekening|formaat|datum|bladnummer)\b/i.test(t.str));
    const streetsIn = (b) => new Set(loc.labelTexts.filter(t => inB(b, t.x, t.y)).map(t => t.streetName));
    // Situatiekaartje: klein kader (< 20% van het blad) met minstens twee verschillende straatnamen
    const insets = rects
      .filter(b => areaOf(b) < W * H * 0.2 && streetsIn(b).size >= 2 && !titleTexts.some(t => inB(b, t.x, t.y)))
      .filter((b, i, arr) => !arr.some((o, j) => j !== i && areaOf(o) < areaOf(b) && inB(b, o[0], o[1]) && inB(b, o[2], o[3])));   // kleinste kader
    const inInset = (x, y) => insets.some(b => inB(b, x, y));
    // Tekengebied: grootste kader met straatnamen (niet het kaartje) en zonder titelblok;
    // zonder straatnamen in de tekening: het grootste kader zonder titelblok
    const big = rects.filter(b => areaOf(b) > W * H * 0.04 && !insets.includes(b) && !titleTexts.some(t => inB(b, t.x, t.y)));
    const byArea = (a, b) => areaOf(b) - areaOf(a);
    const drawArea = big.filter(b => loc.labelTexts.some(t => !inInset(t.x, t.y) && inB(b, t.x, t.y))).sort(byArea)[0]
      || big.sort(byArea)[0] || [0, 0, W, H];

    // Waar ligt het plan? Straatnamen op het blad (tekening en titelblok, niet het kaartje); anders via het situatiekaartje
    const drawLabels = loc.labelTexts.filter(t => inB(drawArea, t.x, t.y) && !inInset(t.x, t.y));
    // Titelblok (kader met "Schaal", "Project" e.d.): daar staan adressen van het bureau, niet van het plan
    const titleBlocks = rects.filter(b => b !== drawArea && areaOf(b) < W * H * 0.4 && titleTexts.some(t => inB(b, t.x, t.y)));
    const inTitle = (t) => titleBlocks.some(b => inB(b, t.x, t.y));
    // straatnaam mét huisnummer in het titelblok = adres van het bureau → overslaan; zonder nummer = projectlocatie
    // adres van het bureau: straatnaam met postcode/postbus/bureaunaam vlak in de buurt
    const isOfficeAddress = (t) => texts.some(o => o !== t && Math.hypot(o.x - t.x, o.y - t.y) < Math.max(t.h, 4) * 8 &&
      /postbus|\b\d{4}\s?[a-z]{2}\b|ingenieursbureau|gemeente amsterdam|www\.|@/i.test(o.str));
    const sheetLabels = loc.labelTexts.filter(t => !inInset(t.x, t.y) && !isOfficeAddress(t));
    let locSource = 'straatnamen';
    if (sheetLabels.length && !loc.manual) {
      const pts = [...new Map(sheetLabels.map(t => [t.streetName, t.streetLL])).values()];
      const med = (arr) => arr.slice().sort((a, b) => a - b)[Math.floor(arr.length / 2)];
      const c0 = [med(pts.map(p => p[0])), med(pts.map(p => p[1]))];
      const near = pts.filter(p => Math.hypot((p[0] - c0[0]) * 111, (p[1] - c0[1]) * 68) < 0.8);
      loc.center = [near.reduce((a, p) => a + p[0], 0) / near.length, near.reduce((a, p) => a + p[1], 0) / near.length];
    }
    // Situatiekaartje met markering: nauwkeuriger startpunt dan de straatnamen (identieke hofjes e.d.)
    let insetRough = null;
    if (insets.length && !loc.manual) {
      insetRough = insetGeoref(insets[0], loc.labelTexts, lines);
      const far = insetRough && Math.hypot((insetRough.marker[0] - loc.center[0]) * 111, (insetRough.marker[1] - loc.center[1]) * 68) > 1.5;
      if (insetRough && (!sheetLabels.length || (insetRough.hasMarker && !far))) { loc.center = insetRough.marker; locSource = 'situatiekaartje'; }
    }
    loc.allLabels = loc.labelTexts;
    loc.labelTexts = drawLabels;     // richting alleen uit straatnamen in de tekening zelf (niet uit het kaartje)
    loc.source = locSource;
    loc.insets = insets;
    // Startpunten: eerst het berekende midden; past het plan daar niet goed, dan elke straat uit de tekening
    // zelf (en daarna van het blad) apart proberen — een lange straat of groot park ligt soms ver van het plan.
    const startPoints = [loc.center];
    const addStart = (ll) => { if (ll && !startPoints.some(c => Math.hypot((c[0] - ll[0]) * 111, (c[1] - ll[1]) * 68) < 0.15)) startPoints.push(ll); };
    if (loc.manual) {
      // straat zelf opgegeven: ook een stukje rond het midden van de straat proberen (lange straten)
      const [la, ln] = loc.center;
      [[0.0025, 0], [-0.0025, 0], [0, 0.004], [0, -0.004]].forEach(([dy, dx]) => addStart([la + dy, ln + dx]));
    } else if (loc.source !== 'situatiekaartje') {
      drawLabels.forEach(t => addStart(t.streetLL));
      sheetLabels.forEach(t => addStart(t.streetLL));
    }
    async function attemptAt() {
      const halfDiag = Math.hypot(W, H) / 2 * mppOf(Math.max(...tryScales));
      const R = Math.min(550, Math.round(halfDiag * 0.7 + 200));
      const target = await fetchTarget(loc.center, R, progress);
      if (target.rings.length < 20) throw new Error('Te weinig BGT-ondergrond gevonden rond ' + loc.streets[0] + '.');
      // Kaartje nauwkeuriger georefereren met de BGT-straatlabels → startpunt binnen enkele tientallen meters
      let prior = null;
      if (locSource === 'situatiekaartje' && insetRough) {
        let g = insetRough;
        global.__insetDbg = { rough: insetRough.marker, hasMarker: insetRough.hasMarker, inset: insets[0], insetTexts: loc.allLabels.filter(t => inB(insets[0], t.x, t.y)).map(t => [t.str, Math.round(t.x), Math.round(t.y)]), nLabels: target.labels.length, steps: [] };
        for (let it = 0; it < 3; it++) { g = insetGeoref(insets[0], loc.allLabels, lines, target.labels, g) || g; global.__insetDbg.steps.push(g.marker); }
        const kx0 = 111320 * Math.cos(loc.center[0] * Math.PI / 180);
        prior = [(g.marker[1] - loc.center[1]) * kx0, (g.marker[0] - loc.center[0]) * 110540];   // meters t.o.v. het opgehaalde midden
        loc.insetRot = g.rot;
      }
      progress('Ondergrond voorbereiden');
      await tick();
      const field = directionalFields(target.rings, R);
      const tSegs = [];
      target.rings.forEach(r => { for (let k = 1; k < r.length; k++) tSegs.push([r[k - 1][0], r[k - 1][1], r[k][0], r[k][1]]); });
      const tDom = dominantAngle(tSegs);

      // Ondergrond-lijnen van de tekening, in pixels rond het midden (y omhoog), met richting.
      // Zwart/grijs, binnen het tekengebied; geen kaders, kleine ronde symbolen (bomen) of tekstkrabbels.
      const refM = mppOf(400);                               // alleen voor drempels in meters
      const upts = [], usegs = [];
      lines.forEach(l => {
        if (saturation(l.color) > 0.3 || lightness(l.color) > 0.85) return;
        const bb = bboxOf(l.pts);
        const diag = Math.hypot(bb[2] - bb[0], bb[3] - bb[1]) * refM;
        if (diag < 1) return;
        if (l.curve && l.closed && diag < 10) return;
        if (l.rect && (bb[2] - bb[0] > (drawArea[2] - drawArea[0]) * 0.9 || bb[3] - bb[1] > (drawArea[3] - drawArea[1]) * 0.9)) return;
        const P = l.pts;
        for (let k = 1; k < P.length; k++) {
          if (!inB(drawArea, P[k - 1][0], P[k - 1][1]) || !inB(drawArea, P[k][0], P[k][1])) continue;
          const x0 = P[k - 1][0] - W / 2, y0 = -(P[k - 1][1] - H / 2), x1 = P[k][0] - W / 2, y1 = -(P[k][1] - H / 2);
          const len = Math.hypot(x1 - x0, y1 - y0);
          if (len * refM < 0.3) continue;
          usegs.push([x0, y0, x1, y1]);
          const ang = Math.atan2(y1 - y0, x1 - x0) * 180 / Math.PI;
          const n = Math.max(1, Math.floor(len * refM));
          for (let s5 = 0; s5 < n; s5++) upts.push([x0 + (x1 - x0) * s5 / n, y0 + (y1 - y0) * s5 / n, ang]);
        }
      });
      if (upts.length < 50) throw new Error('Er staat te weinig ondergrond in de tekening om hem automatisch te plaatsen.');
      const pick = (n) => { const out = []; const step = upts.length / n; for (let i = 0; i < n && i * step < upts.length; i++) out.push(upts[Math.floor(i * step)]); return out; };
      const coarse = pick(200), fine = pick(1500);

      // Draaiing: hoofdrichtingen (rooster van de wijk) en, als die er zijn, de richting van de straatnamen
      const labelRots = [];
      loc.labelTexts.forEach(t => {
        const pdfAng = -t.ang * 180 / Math.PI;
        target.labels.filter(l => norm(l.name).replace(/ /g, '') === norm(t.streetName).replace(/ /g, '')).forEach(l => {
          const r = (((l.hoek % 360) - pdfAng) % 180 + 180) % 180;
          labelRots.push(r, r + 180);
        });
      });
      const sDom = dominantAngle(usegs);
      const angDiff = (a, b) => Math.abs(((a - b) % 360 + 540) % 360 - 180);
      let rots = [];
      for (let k = 0; k < 4; k++) for (const f of [-1, 0, 1]) rots.push(tDom - sDom + k * 90 + f);
      if (labelRots.length) {
        // richtingen waar de meeste straatnamen het over eens zijn (per 180°), de beste twee
        const base = labelRots.filter((_, i) => i % 2 === 0);
        const clusters = [];
        base.forEach(r => {
          const c = clusters.find(q => Math.abs(((q.r - r) % 180 + 270) % 180 - 90) < 6);
          if (c) { c.n++; c.sum += r; } else clusters.push({ r, n: 1, sum: r });
        });
        clusters.sort((a, b) => b.n - a.n);
        const top = clusters.slice(0, 2).map(c => c.sum / c.n);
        // roosterrichting gebruiken als die dichtbij een straatnaam-richting ligt (nauwkeuriger)
        const grid = rots.filter(r => top.some(t => angDiff(r, t) < 8 || angDiff(r, t + 180) < 8));
        rots = grid.length ? grid : top.flatMap(t => [t, t + 180]).flatMap(r => [r - 2, r, r + 2]);
      }
      if (global.__planForce?.rots) rots = global.__planForce.rots;
      const dbg = (global.__planDebug = { prior, insetRot: loc.insetRot, streets: loc.streets, labels: loc.labelTexts.map(t => [t.str, t.streetName]), center: loc.center, source: loc.source, insets, drawArea, nPts: upts.length, labelRots, tDom, sDom, rots: rots.map(r => Math.round(r)), scales: tryScales });

      // Grof zoeken over schaal × draaiing × positie met de richtings-afstandskaarten
      const { fields, size, off } = field;
      const n = coarse.length;
      const rx = new Float64Array(n), ry = new Float64Array(n), rb = new Uint8Array(n);
      const span = prior ? 150 : Math.max(40, Math.min(R * 0.8, 300));
      const [ox, oy] = prior || [0, 0];
      const TOL = 4, STEP = 4;
      let cands = [], floor = 0.15, combo = 0;
      for (const scaleN of tryScales) {
        const m = mppOf(scaleN);
        for (const rot of rots) {
          if (combo++ % 6 === 0) { progress(`Tekening op de ondergrond passen (${Math.round(combo / (tryScales.length * rots.length) * 100)}%)`); await tick(); }
          const c = Math.cos(rot * Math.PI / 180), s2 = Math.sin(rot * Math.PI / 180);
          for (let k = 0; k < n; k++) { const [x, y, a] = coarse[k]; rx[k] = (c * x - s2 * y) * m + off + 0.5; ry[k] = (s2 * x + c * y) * m + off + 0.5; rb[k] = binOf(a + rot); }
          for (let ty = oy - span; ty <= oy + span; ty += STEP) for (let tx = ox - span; tx <= ox + span; tx += STEP) {
            let sc = 0;
            for (let k = 0; k < n; k++) {
              const i = (rx[k] + tx) | 0, j = (ry[k] + ty) | 0;
              if (i >= 0 && j >= 0 && i < size && j < size) { const dd = fields[rb[k]][j * size + i]; if (dd < TOL) sc += 1 - dd / TOL; }
              if (k === 40 && sc < floor * 41 * 0.6) break;     // kansloos: vroeg stoppen
            }
            sc /= n;
            if (sc > floor) { cands.push({ rot, tx, ty, m, scaleN, sc }); if (cands.length > 400) { cands.sort((a, b) => b.sc - a.sc); cands.length = 30; floor = Math.max(floor, cands[29].sc); } }
          }
        }
      }
      cands.sort((a, b) => b.sc - a.sc);
      dbg.cands = cands.slice(0, 8).map(c => [Math.round(c.rot), c.scaleN, Math.round(c.tx), Math.round(c.ty), +c.sc.toFixed(3)]);

      // Tweede, fijnere zoekronde rond de beste kandidaten: schaal ±12% (2%), draaiing ±2° (0,5°), positie ±12 m (1,5 m)
      progress('Passing nauwkeuriger zoeken');
      await tick();
      const fineCands = [];
      const seen0 = [];
      for (const c0 of cands) {
        if (seen0.some(q => Math.abs(q.rot - c0.rot) < 3 && Math.abs(q.m / c0.m - 1) < 0.1 && Math.hypot(q.tx - c0.tx, q.ty - c0.ty) < 15)) continue;
        seen0.push(c0);
        if (seen0.length > 5) break;
        let bestL = { ...c0, sc: 0 };
        for (let ds = -0.12; ds <= 0.1201; ds += 0.02) for (let dr = -2; dr <= 2.01; dr += 0.5) {
          const m = c0.m * (1 + ds), rot = c0.rot + dr;
          const c = Math.cos(rot * Math.PI / 180), s2 = Math.sin(rot * Math.PI / 180);
          for (let k = 0; k < n; k++) { const [x, y, a] = coarse[k]; rx[k] = (c * x - s2 * y) * m + off + 0.5; ry[k] = (s2 * x + c * y) * m + off + 0.5; rb[k] = binOf(a + rot); }
          for (let ty = c0.ty - 12; ty <= c0.ty + 12; ty += 1.5) for (let tx = c0.tx - 12; tx <= c0.tx + 12; tx += 1.5) {
            let sc = 0;
            for (let k = 0; k < n; k++) {
              const i = (rx[k] + tx) | 0, j = (ry[k] + ty) | 0;
              if (i >= 0 && j >= 0 && i < size && j < size) { const dd = fields[rb[k]][j * size + i]; if (dd < 2) sc += 1 - dd / 2; }
            }
            sc /= n;
            if (sc > bestL.sc) bestL = { rot, tx, ty, m, sc };
          }
        }
        fineCands.push(bestL);
      }
      fineCands.sort((a, b) => b.sc - a.sc);
      cands = fineCands;
      dbg.fineCands = fineCands.map(c => [+c.rot.toFixed(1), Math.round(c.m / PT_M * state.scale), Math.round(c.tx), Math.round(c.ty), +c.sc.toFixed(3)]);

      // Verfijnen met de exacte afstand (per richting), inclusief traploze schaal
      const segsByBin = Array.from({ length: NBIN }, () => []);
      tSegs.forEach(sg => { const b = binOf(Math.atan2(sg[3] - sg[1], sg[2] - sg[0]) * 180 / Math.PI); for (const bb of [(b + NBIN - 1) % NBIN, b, (b + 1) % NBIN]) segsByBin[bb].push(sg); });
      const exactBin = segsByBin.map(list => segmentIndex(list, 1.5));
      const scoreExact = (p, tol) => {
        const c = Math.cos(p.rot * Math.PI / 180), s3 = Math.sin(p.rot * Math.PI / 180);
        let sc = 0;
        for (const [x, y, a] of fine) {
          const dd = exactBin[binOf(a + p.rot)]((c * x - s3 * y) * p.m + p.tx, (s3 * x + c * y) * p.m + p.ty, tol);
          if (dd < tol) sc += 1 - dd / tol;
        }
        return sc / fine.length;
      };
      // Snelle score op de afstandskaarten (1 m) voor de grove rondes
      const mid = pick(600);
      const scoreField = (p, tol) => {
        const c = Math.cos(p.rot * Math.PI / 180), s3 = Math.sin(p.rot * Math.PI / 180);
        let sc = 0;
        for (const [x, y, a] of mid) {
          const i = ((c * x - s3 * y) * p.m + p.tx + off + 0.5) | 0, j = ((s3 * x + c * y) * p.m + p.ty + off + 0.5) | 0;
          if (i < 0 || j < 0 || i >= size || j >= size) continue;
          const dd = fields[binOf(a + p.rot)][j * size + i];
          if (dd < tol) sc += 1 - dd / tol;
        }
        return sc / mid.length;
      };
      const STAGES = [[2, 0.5, 0.02, 3, scoreExact], [1, 0.25, 0.01, 2, scoreExact], [0.5, 0.1, 0.005, 1.2, scoreExact], [0.2, 0.04, 0.002, 0.8, scoreExact], [0.08, 0.015, 0.001, 0.5, scoreExact], [0.03, 0.006, 0.0005, 0.35, scoreExact]];
      const climb = (cur, [stepT, stepR, stepS, tol, score]) => {
        cur = { ...cur, sc: score(cur, tol) };
        let improved = true, guard = 0;
        while (improved && guard++ < 40) {
          improved = false;
          for (const [dx, dy, dr, ds] of [[stepT, 0, 0, 0], [-stepT, 0, 0, 0], [0, stepT, 0, 0], [0, -stepT, 0, 0], [0, 0, stepR, 0], [0, 0, -stepR, 0], [0, 0, 0, stepS], [0, 0, 0, -stepS]]) {
            // schaal rond het midden van de tekening aanpassen: verschuiving blijft gelijk
            const nx = { ...cur, tx: cur.tx + dx, ty: cur.ty + dy, rot: cur.rot + dr, m: cur.m * (1 + ds) };
            const sc = score(nx, tol);
            if (sc > cur.sc + 1e-6) { cur = { ...nx, sc }; improved = true; }
          }
        }
        return cur;
      };
      const seenC = [];
      for (const c0 of cands) {
        if (seenC.some(q => Math.abs(q.rot - c0.rot) < 2 && Math.abs(q.m / c0.m - 1) < 0.06 && Math.hypot(q.tx - c0.tx, q.ty - c0.ty) < 8)) continue;
        seenC.push(c0);
        if (seenC.length >= 6) break;
      }
      progress('Passing verfijnen');
      await tick();
      const ranked = seenC.map(c0 => climb(c0, STAGES[0])).sort((a, b) => b.sc - a.sc);
      // Bijna gelijkspel (symmetrische wijk)? Dan de draaiing die het best past bij de stand van het situatiekaartje
      if (loc.insetRot != null && ranked.length > 1) {
        const close = ranked.filter(c => c.sc >= ranked[0].sc * 0.95);
        if (close.length > 1) {
          close.sort((a, b) => angDiff(a.rot, loc.insetRot) - angDiff(b.rot, loc.insetRot));
          const pickC = close[0];
          ranked.splice(ranked.indexOf(pickC), 1);
          ranked.unshift(pickC);
        }
      }
      let best = null;
      if (ranked[0]) {
        let cur = ranked[0];
        for (const st of STAGES.slice(1)) { cur = climb(cur, st); await tick(); }
        const c = Math.cos(cur.rot * Math.PI / 180), s4 = Math.sin(cur.rot * Math.PI / 180);
        const fit = fine.filter(([x, y, a]) => exactBin[binOf(a + cur.rot)]((c * x - s4 * y) * cur.m + cur.tx, (s4 * x + c * y) * cur.m + cur.ty, 1) < 0.5).length / fine.length;
        best = { ...cur, fit, mpp: cur.m, scaleN: Math.round(cur.m / PT_M * state.scale) };
        dbg.ranked = ranked.map(c => [+c.rot.toFixed(1), Math.round(c.m / PT_M * state.scale), Math.round(c.tx), Math.round(c.ty), +c.sc.toFixed(3)]);
      }
      return { best, target };
    }
    let best = null, target = null, bestCenter = null, lastErr = null;
    const nTry = Math.min(startPoints.length, 5);
    for (let i = 0; i < nTry; i++) {
      loc.center = startPoints[i];
      if (i > 0) progress(`Andere plek proberen (${i + 1}/${nTry})`);
      let res;
      try { res = await attemptAt(); } catch (err) { lastErr = err; continue; }
      if (res.best && (!best || res.best.fit > best.fit)) { best = res.best; target = res.target; bestCenter = loc.center; }
      if (best && best.fit >= 0.55) break;
    }
    if (bestCenter) loc.center = bestCenter;
    if (!best) throw lastErr || new Error('De lijnen van de tekening konden niet op de ondergrond worden gelegd.');
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
      info: { place: loc.place, streets: loc.streets, source: loc.source, scaleN: best.scaleN, scaleFromText: scales.some(n => Math.abs(n / best.scaleN - 1) < 0.02), rotation: rotDeg > 180 ? rotDeg - 360 : rotDeg, fit: best.fit },
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
    const autoBox = body.querySelector('#planAuto');
    // Zelf een straatnaam opgeven (als de tekst in de PDF niet leesbaar is of de verkeerde plek gevonden werd)
    const streetForm = (val) => `
      <form class="plan-street" id="planStreetForm">
        <label for="planStreet">Straatnaam bij het plan</label>
        <div class="plan-street-row">
          <input id="planStreet" type="text" placeholder="bijv. Hoekenes" autocomplete="off" value="${esc(val || '')}">
          <button type="submit" class="btn primary">Zoek hier</button>
        </div>
      </form>`;
    autoBox.addEventListener('submit', (e) => {
      if (e.target.id !== 'planStreetForm') return;
      e.preventDefault();
      const v = body.querySelector('#planStreet').value.trim();
      if (v.length >= 3) runAuto({ street: v });
    });
    function runAuto(opts = {}) {
      state.mode = 'auto';
      (state.mapMarkers || []).forEach(m => m.remove());
      state.mapMarkers = [];
      state.pairs = [];
      wrap.querySelectorAll('.plan-dot').forEach(d => d.remove());
      body.querySelector('#planInstr').hidden = true;
      body.querySelector('#planRedo').hidden = true;
      const runId = (state.runId = (state.runId || 0) + 1);
      autoBox.innerHTML = `<div class="plan-auto-busy"><span class="plan-spin"></span><span id="planAutoMsg">${opts.street ? 'Plan plaatsen bij ' + esc(opts.street) + '…' : 'Plan automatisch plaatsen…'}</span></div>`;
      autoPlace((msg) => { const m = body.querySelector('#planAutoMsg'); if (m && state.runId === runId) m.textContent = msg; }, opts)
        .then(({ transform, info }) => {
          if (state.runId !== runId || state.mode !== 'auto') return;
          applyTransform(transform);
          const pct = Math.round(info.fit * 100);
          const good = info.fit >= 0.35;
          autoBox.innerHTML = `
            <div class="plan-auto-result ${good ? 'ok' : 'warn'}">
              <strong>${good ? 'Automatisch geplaatst' : 'Geplaatst, maar niet zeker'}</strong>
              <span>${info.source === 'situatiekaartje' ? 'Via het situatiekaartje: ' : ''}${esc(info.streets.slice(0, 3).join(', '))}${info.streets.length > 3 ? ' e.a.' : ''}, ${esc(info.place)}</span>
              <span>Schaal 1:${info.scaleN}${info.scaleFromText ? '' : ' (geschat)'} · draaiing ${Math.round(info.rotation)}° · ${pct}% van de lijnen valt op de BGT</span>
              <em>${good ? 'Controleer of de tekening goed op de kaart ligt. Verkeerde plek? Vul hieronder de straat in.' : 'Controleer goed; ligt hij verkeerd, vul dan de straat in of kies Handmatig plaatsen.'}</em>
            </div>${streetForm(opts.street)}`;
          body.querySelector('#planManual').hidden = false;
        })
        .catch((err) => {
          if (state.runId !== runId || state.mode !== 'auto') return;
          console.warn(err);
          autoBox.innerHTML = `<div class="plan-auto-result warn"><strong>Automatisch plaatsen lukte niet</strong><span>${esc(err.message)}</span><em>Vul de straatnaam in en probeer opnieuw, of plaats het plan met twee punten.</em></div>${streetForm(opts.street)}`;
          startManualKeepMsg();
        });
    }
    runAuto();
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
        global.__planGroups = state.groups;
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
    // groepen met alleen piepkleine vlakjes (getekende letters, pijlpunten) standaard uit
    groups.forEach(g => { if (g.checked && g.pxArea * m2PerPx2 / g.items.length < 1) g.checked = false; });
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
      // alle vakken uit dit plan horen bij één groep (één regel in de objectenlijst)
      const planGroupId = 'plan-' + Date.now().toString(36);
      const planGroupName = state.file.name.replace(/\.pdf$/i, '').replace(/^\d{6,8}[_ -]*/, '').replace(/[_]+/g, ' ').trim() || 'Beplantingsplan';
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
            ref: s.gis ? `GIS ${s.gis}` : '',
            groupId: planGroupId,
            group: planGroupName,
            color: g.color,
            fill: g.kind === 'outline' ? 'geen' : 'effen',
            notes: [
              ...(s.extra || []),
              s.areaText ? `Oppervlakte volgens tekening: ${s.areaText}.` : '',
              `Uit beplantingsplan “${state.file.name}”${state.pdf.numPages > 1 ? `, pagina ${state.pageNo}` : ''}.`,
              g.name && (useLabels && s.label) ? `Groep: ${g.name}.` : '',
            ].filter(Boolean).join('\n'),
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

  global.PlanImport = { open, _internal: { solveTransform, analyse, extractShapes, extractTexts, findScales } };
})(window);
