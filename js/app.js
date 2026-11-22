/* Kaartdata – kaarten maken voor projecten en assets. */
(function () {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const DEFAULT_CATEGORIES = [
    'Projectgebied', 'Perceel', 'Bouwvlak', 'Werkterrein', 'Gebouw', 'Groen', 'Verharding', 'Water',
    'Kabel', 'Leiding', 'Riolering', 'Weg', 'Route', 'Hek',
    'Gras', 'Beplanting', 'Bos', 'Berm', 'Haag',
    'Lantaarnpaal', 'Boom', 'Put', 'Kast', 'Bord', 'Meetpunt', 'Overig',
  ];

  const SHAPE_LABEL = { Polygon: 'Polygoon', Rectangle: 'Rechthoek', Line: 'Lijn', Marker: 'Punt', Circle: 'Cirkel' };
  const SHAPE_ICON = { Polygon: 'i-polygon', Rectangle: 'i-rect', Line: 'i-line', Marker: 'i-point', Circle: 'i-circle' };
  const DRAW_HINT = {
    Polygon: 'Klik om hoekpunten te plaatsen · klik op het eerste punt om te sluiten',
    Rectangle: 'Klik op twee tegenoverliggende hoeken',
    Line: 'Klik om punten te plaatsen · klik op het laatste punt om af te ronden',
    Marker: 'Klik op de kaart om het punt te plaatsen',
    Circle: 'Klik op het middelpunt en daarna op de rand',
  };
  const DRAW_HINT_TOUCH = {
    Polygon: 'Tik op de kaart om hoekpunten te zetten',
    Rectangle: 'Tik op twee tegenoverliggende hoeken',
    Line: 'Tik op de kaart om punten te zetten',
    Marker: 'Tik op de kaart of gebruik je GPS-locatie',
    Circle: 'Tik op het middelpunt en daarna op de rand',
  };
  const STATUS_CLASS = {
    'Gepland': 'st-gepland', 'In uitvoering': 'st-uitvoering', 'Gereed': 'st-gereed',
    'In beheer': 'st-beheer', 'Buiten gebruik': 'st-buiten',
  };
  const PROJECT_COLORS = ['#0a6c8f', '#2f6fd6', '#6a4fc2', '#c2417a', '#d0532a', '#c28a12', '#3f8f3a', '#1f8a7a', '#5b6778'];
  const shapeOf = (f) => SHAPE_ICON[f.shape] ? f.shape : (f.geometry.type.includes('Polygon') ? 'Polygon' : f.geometry.type.includes('Line') ? 'Line' : 'Marker');
  const icon = (id) => `<svg><use href="#${id}"/></svg>`;
  const isMobile = () => window.matchMedia('(max-width: 820px)').matches;

  // Kijkmodus: geopend via een deelbare link (#deel=…) — alleen de kaart met het gedeelde vak
  const viewerMode = !!(window.Share && Share.payloadFromHash());

  // ---------------------------------------------------------------- Kaart
  // Eén vaste SVG-laag voor alle vlakken; hierin staan ook de opvulpatronen (werkt zo ook in Safari)
  const svgRenderer = L.svg({ padding: 0.5 });
  const MAX_ZOOM = 22;   // tot 21 scherpe PDOK-tegels, 22 uitvergroot voor precies tekenen
  const map = L.map('map', { zoomControl: true, doubleClickZoom: false, renderer: svgRenderer, maxZoom: MAX_ZOOM }).setView([52.1, 5.3], 8);
  map.addLayer(svgRenderer);

  const pdok = (layer) => L.tileLayer(
    `https://service.pdok.nl/brt/achtergrondkaart/wmts/v2_0/${layer}/EPSG:3857/{z}/{x}/{y}.png`,
    { maxZoom: MAX_ZOOM, maxNativeZoom: 21, attribution: 'Kaartgegevens &copy; <a href="https://www.kadaster.nl">Kadaster</a> / PDOK' });

  const baseLayers = {
    'PDOK Standaard': pdok('standaard'),
    'PDOK Grijs': pdok('grijs'),
    'PDOK Pastel': pdok('pastel'),
    'Luchtfoto (PDOK)': L.tileLayer(
      'https://service.pdok.nl/hwh/luchtfotorgb/wmts/v1_0/Actueel_orthoHR/EPSG:3857/{z}/{x}/{y}.jpeg',
      { maxZoom: MAX_ZOOM, maxNativeZoom: 21, attribution: 'Luchtfoto &copy; Beeldmateriaal.nl / PDOK' }),
    'OpenStreetMap': L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
      { maxZoom: MAX_ZOOM, maxNativeZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' }),
  };
  const overlays = {
    'Kadastrale percelen': L.tileLayer.wms('https://service.pdok.nl/kadaster/kadastralekaart/wms/v5_0', {
      layers: 'Kadastralekaart', format: 'image/png', transparent: true, minZoom: 16, maxZoom: MAX_ZOOM,
      attribution: 'Kadastrale kaart &copy; Kadaster',
    }),
  };

  const savedBase = Store.state.baseLayer && baseLayers[Store.state.baseLayer] ? Store.state.baseLayer : 'PDOK Standaard';
  baseLayers[savedBase].addTo(map);
  L.control.layers(baseLayers, overlays, { position: 'topright' }).addTo(map);
  L.control.scale({ imperial: false, position: 'bottomright' }).addTo(map);
  map.on('baselayerchange', (e) => { if (viewerMode) return; Store.state.baseLayer = e.name; Store.save(); });

  if (Store.state.view && !viewerMode) map.setView(Store.state.view.center, Store.state.view.zoom);
  map.on('moveend', () => {
    if (viewerMode) return;   // een kijklink verandert niets aan je eigen kaart
    Store.state.view = { center: map.getCenter(), zoom: map.getZoom() };
    Store.save();
  });

  // Geoman: alleen de bewerk-knoppen op de kaart; tekenen gaat via de zijbalk.
  map.pm.setLang('nl');
  if (!viewerMode) map.pm.addControls({
    position: 'topleft',
    drawMarker: false, drawCircleMarker: false, drawPolyline: false, drawRectangle: false,
    drawPolygon: false, drawCircle: false, drawText: false,
    editMode: true, dragMode: true, cutPolygon: true, removalMode: true, rotateMode: true,
  });
  map.pm.setGlobalOptions({ snappable: true, snapDistance: 15, allowSelfIntersection: false });

  const featureLayers = new Map(); // featureId -> Leaflet-laag
  const group = L.featureGroup().addTo(map);
  let selectedId = null;
  let showLabels = true;

  // ---------------------------------------------------------------- Stijlen
  function colorOf(f) {
    return f.props.color || Store.project(f.projectId)?.color || '#2563eb';
  }

  function pinIcon(color, selected) {
    const size = selected ? 36 : 30;
    return L.divIcon({
      className: 'asset-pin',
      iconSize: [size, size],
      iconAnchor: [size / 2, size],
      tooltipAnchor: [0, -size],
      html: `<svg viewBox="0 0 24 24"><path style="fill:${esc(color)};stroke:#fff;stroke-width:1.6" d="M12 1.5a7.5 7.5 0 0 0-7.5 7.5c0 5.6 7.5 13.5 7.5 13.5s7.5-7.9 7.5-13.5A7.5 7.5 0 0 0 12 1.5z"/><circle cx="12" cy="9" r="2.8" style="fill:#fff"/></svg>`,
    });
  }

  // Bomen als rond boomsymbool, andere punten als speld
  function treeIcon(color, selected) {
    const size = selected ? 26 : 20;
    return L.divIcon({
      className: 'asset-pin',
      iconSize: [size, size],
      iconAnchor: [size / 2, size / 2],
      tooltipAnchor: [0, -size / 2],
      html: `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" style="fill:${esc(color)};stroke:#fff;stroke-width:2"/><path d="M12 6.5l-4 5h2.2l-2.7 3.5H11v2.5h2V15h3.5l-2.7-3.5H16z" style="fill:#fff"/></svg>`,
    });
  }
  const iconFor = (f, selected) => f.props.category === 'Boom' ? treeIcon(colorOf(f), selected) : pinIcon(colorOf(f), selected);

  // ---------------------------------------------------------------- Opvulpatronen (arcering, geruit, stippen…)
  // Patronen worden één keer per type+kleur aangemaakt in de SVG-defs van de pagina.
  const SVGNS = 'http://www.w3.org/2000/svg';
  function svgEl(tag, attrs) {
    const el = document.createElementNS(SVGNS, tag);
    Object.entries(attrs).forEach(([k, v]) => el.setAttribute(k, v));
    return el;
  }
  // <defs> binnen een bepaalde <svg> (Safari tekent patronen alleen betrouwbaar vanuit dezelfde svg)
  function defsIn(svg) {
    let defs = svg.querySelector(':scope > defs');
    if (!defs) { defs = svgEl('defs', {}); svg.insertBefore(defs, svg.firstChild); }
    return defs;
  }
  const mapDefs = () => defsIn(svgRenderer._container);
  function patternUrl(type, color, tint, defs = mapDefs(), prefix = 'fp') {
    const id = `${prefix}-${type}-${color.replace(/[^a-z0-9]/gi, '')}-${tint ? 1 : 0}`;
    if (!defs.querySelector(`#${id}`)) {
      const size = { dambord: 16, raster: 10, stippen: 10 }[type] || 8;
      const pat = svgEl('pattern', { id, patternUnits: 'userSpaceOnUse', width: size, height: size });
      if (type === 'diagonaal' || type === 'kruis') pat.setAttribute('patternTransform', 'rotate(45)');
      pat.appendChild(svgEl('rect', { width: size, height: size, fill: color, 'fill-opacity': tint ? 0.22 : 0.1 }));
      const line = (d, w) => pat.appendChild(svgEl('path', { d, stroke: color, 'stroke-width': w, fill: 'none' }));
      if (type === 'diagonaal') line('M1 0V8', 2);
      if (type === 'kruis') line('M1 0V8M0 1H8', 1.6);
      if (type === 'raster') line('M0.5 0V10M0 0.5H10', 1.3);
      if (type === 'horizontaal') line('M0 1H8', 2);
      if (type === 'verticaal') line('M1 0V8', 2);
      if (type === 'stippen') pat.appendChild(svgEl('circle', { cx: 5, cy: 5, r: 1.9, fill: color }));
      if (type === 'dambord') {
        pat.appendChild(svgEl('rect', { x: 0, y: 0, width: 8, height: 8, fill: color, 'fill-opacity': 0.5 }));
        pat.appendChild(svgEl('rect', { x: 8, y: 8, width: 8, height: 8, fill: color, 'fill-opacity': 0.5 }));
      }
      defs.appendChild(pat);
    }
    return `url(#${id})`;
  }
  // Vulling voor een object: { fillColor, fillOpacity }
  function fillFor(fill, color, isAsset, defs, prefix) {
    if (fill === 'geen') return { fillColor: color, fillOpacity: 0 };
    if (!fill || fill === 'effen') return { fillColor: color, fillOpacity: isAsset ? 0.45 : 0.2 };
    return { fillColor: patternUrl(fill, color, isAsset, defs, prefix), fillOpacity: 1 };
  }

  function styleFor(f, selected) {
    const color = colorOf(f);
    const isLine = f.geometry.type.includes('LineString');
    return {
      color,
      weight: selected ? 5 : (isLine ? 4 : 2),
      opacity: 1,
      ...fillFor(isLine ? 'effen' : f.props.fill, color, f.props.kind === 'asset'),
      dashArray: f.props.status === 'Gepland' && !isLine ? '6 4' : null,
    };
  }

  function applyStyle(f) {
    const layer = featureLayers.get(f.id);
    if (!layer) return;
    const selected = f.id === selectedId;
    if (layer instanceof L.Marker) layer.setIcon(iconFor(f, selected));
    else layer.setStyle(styleFor(f, selected));
    layer.unbindTooltip();
    if (showLabels && f.props.name) {
      layer.bindTooltip(esc(f.props.name), {
        permanent: true, direction: layer instanceof L.Marker ? 'top' : 'center', className: 'feature-label',
      });
    } else {
      layer.bindTooltip(esc(f.props.name || ''), { direction: 'top', sticky: true });
    }
  }

  // ---------------------------------------------------------------- Geometrie
  function layerToGeometry(layer, shape) {
    if (layer instanceof L.Circle) {
      const c = layer.getLatLng();
      return { geometry: { type: 'Point', coordinates: [c.lng, c.lat] }, radius: layer.getRadius() };
    }
    return { geometry: layer.toGeoJSON().geometry };
  }

  function featureToLayer(f) {
    if (f.shape === 'Circle' && f.radius) {
      const [lng, lat] = f.geometry.coordinates;
      return L.circle([lat, lng], { radius: f.radius });
    }
    if (f.geometry.type === 'Point') {
      const [lng, lat] = f.geometry.coordinates;
      return L.marker([lat, lng], { icon: f.props ? iconFor(f) : pinIcon(colorOf(f)) });
    }
    return L.GeoJSON.geometryToLayer({ type: 'Feature', geometry: f.geometry, properties: {} });
  }

  function measure(f) {
    const g = f.geometry;
    const out = {};
    try {
      if (f.shape === 'Circle' && f.radius) {
        out.area = Math.PI * f.radius ** 2;
        out.perimeter = 2 * Math.PI * f.radius;
        out.radius = f.radius;
      } else if (g.type === 'Polygon' || g.type === 'MultiPolygon') {
        out.area = turf.area(g);
        out.perimeter = turf.length(turf.polygonToLine(g), { units: 'meters' });
      } else if (g.type === 'LineString' || g.type === 'MultiLineString') {
        out.length = turf.length(g, { units: 'meters' });
      }
    } catch (e) { /* ongeldige geometrie */ }
    return out;
  }

  const nf = (n, d = 0) => n.toLocaleString('nl-NL', { maximumFractionDigits: d, minimumFractionDigits: d });
  const fmtArea = (m2) => m2 >= 10000 ? `${nf(m2 / 10000, 2)} ha (${nf(m2)} m²)` : `${nf(m2, 1)} m²`;
  const fmtLen = (m) => m >= 1000 ? `${nf(m / 1000, 2)} km` : `${nf(m, 1)} m`;

  // Waarde + eenheid los, voor nette meetwaarden
  const areaParts = (m2) => m2 >= 10000 ? [nf(m2 / 10000, 2), 'ha', `${nf(m2)} m²`] : [nf(m2, 1), 'm²', ''];
  const lenParts = (m) => m >= 1000 ? [nf(m / 1000, 2), 'km', `${nf(m)} m`] : [nf(m, 1), 'm', ''];

  function measureText(f, short) {
    const m = measure(f);
    if (short) {
      if (m.area != null) return areaParts(m.area).slice(0, 2).join(' ');
      if (m.length != null) return lenParts(m.length).slice(0, 2).join(' ');
      return '';
    }
    const tile = (label, [v, u, extra]) =>
      `<div><div class="m-label">${label}</div><div class="m-value">${v}<span class="m-unit">${u}</span></div>${extra ? `<div class="m-extra">${extra}</div>` : ''}</div>`;
    const rows = [];
    if (m.area != null) rows.push(tile('Oppervlakte', areaParts(m.area)));
    if (m.perimeter != null) rows.push(tile('Omtrek', lenParts(m.perimeter)));
    if (m.radius != null) rows.push(tile('Straal', lenParts(m.radius)));
    if (m.length != null) rows.push(tile('Lengte', lenParts(m.length)));
    return rows.join('');
  }

  // ---------------------------------------------------------------- BGT-vakken opvragen (voor kijklinks)
  const BGT_API = 'https://api.pdok.nl/lv/bgt/ogc/v1/collections';
  async function fetchBgtRef(ref) {
    const [coll, id] = ref.split(':');
    const now = new Date().toISOString().slice(0, 19) + 'Z';
    const res = await fetch(`${BGT_API}/${coll}/items?f=json&lokaal_id=${encodeURIComponent(id)}&datetime=${now}`);
    if (!res.ok) throw new Error(`PDOK ${res.status}`);
    const data = await res.json();
    const f = (data.features || [])[0];
    if (!f) throw new Error('niet gevonden');
    let g = f.geometry;
    if (g.type === 'MultiPolygon' && g.coordinates.length === 1) g = { type: 'Polygon', coordinates: g.coordinates[0] };
    if (g.type === 'MultiLineString' && g.coordinates.length === 1) g = { type: 'LineString', coordinates: g.coordinates[0] };
    return g;
  }
  // Eén of meer BGT-vakken -> één geometrie (samengevoegd als het er meer zijn)
  async function geometryFromRefs(refs) {
    const geoms = await Promise.all(refs.map(fetchBgtRef));
    if (geoms.length === 1) return geoms[0];
    const merged = turf.union(turf.featureCollection(geoms.map(g => turf.feature(g))));
    if (!merged) throw new Error('samenvoegen mislukt');
    return merged.geometry;
  }

  // ---------------------------------------------------------------- Kijkmodus (deelbare link)
  async function startViewer() {
    document.body.classList.add('viewer');
    const card = document.createElement('div');
    card.className = 'viewer-card';
    card.innerHTML = '<div class="vc-loading">Vak laden…</div>';
    $('#mapWrap').appendChild(card);

    let feats;
    try {
      feats = await Share.decode(Share.payloadFromHash());
    } catch (err) {
      card.innerHTML = `<div class="vc-error"><strong>Deze link kan niet worden geopend</strong><span>${esc(/^Deze /.test(err.message || '') ? err.message : 'De link is ongeldig of onvolledig. Vraag de afzender om hem opnieuw te sturen.')}</span></div>`;
      return;
    }

    // Vakken met een BGT-nummer: exacte vorm bij PDOK ophalen (reservevorm uit de link als dat niet lukt)
    let notice = '';
    await Promise.all(feats.map(async (f) => {
      if (!f.refs) return;
      try {
        f.geometry = await geometryFromRefs(f.refs);
      } catch (err) {
        if (f.geometry) notice = 'De exacte vorm kon niet bij de BGT worden opgehaald; er wordt een vereenvoudigde vorm getoond.';
      }
    }));
    const sharedTitle = feats.title || '';
    feats = feats.filter(f => f.geometry);
    feats.title = sharedTitle;
    if (!feats.length) {
      card.innerHTML = '<div class="vc-error"><strong>Dit vak kon niet worden geladen</strong><span>Het vak is niet (meer) gevonden in de BGT, of PDOK is niet bereikbaar. Probeer het later opnieuw.</span></div>';
      return;
    }

    const shared = L.featureGroup().addTo(map);
    const layerOf = new Map();
    feats.forEach(f => {
      const layer = featureToLayer(f);
      layer.addTo(shared);
      layerOf.set(f, layer);
      if (layer instanceof L.Marker) layer.setIcon(iconFor(f));
      else layer.setStyle(styleFor(f, false));
      layer.on('click', (e) => { L.DomEvent.stop(e); show(f, true); });
    });

    const multi = feats.length > 1;
    // Namen op de kaart: altijd bij weinig vakken, anders pas vanaf straatniveau (anders overlappen ze)
    const labelAll = feats.length <= 5;
    function updateLabels() {
      const on = labelAll || map.getZoom() >= 18;
      feats.forEach(f => {
        const l = layerOf.get(f);
        l.unbindTooltip();
        if (!f.props.name) return;
        l.bindTooltip(esc(f.props.name), on
          ? { permanent: true, direction: l instanceof L.Marker ? 'top' : 'center', className: 'feature-label' }
          : { direction: 'top', sticky: true });
      });
    }
    updateLabels();
    map.on('zoomend', updateLabels);
    const projectTitle = feats.title || (multi ? `${feats.length} vakken` : '');
    document.title = `${projectTitle || feats[0].props.name || 'Gedeeld vak'} – Kaartdata`;
    let current = null;
    let pos = null;

    const boundsOf = (list) => {
      const b = L.latLngBounds([]);
      list.forEach(f => { const l = layerOf.get(f); if (l.getBounds) b.extend(l.getBounds()); else b.extend(l.getLatLng()); });
      return b;
    };
    const fitTo = (b) => {
      if (!b.isValid()) return;
      const pad = isMobile() ? card.getBoundingClientRect().height : 0;
      map.fitBounds(b, { paddingTopLeft: [40, 60], paddingBottomRight: [40, pad + 40], maxZoom: 20 });
    };
    const measureTiles = (m) => {
      const tiles = [];
      if (m.area) tiles.push(['Oppervlakte', areaParts(m.area)]);
      if (m.perimeter) tiles.push(['Omtrek', lenParts(m.perimeter)]);
      if (m.length) tiles.push(['Lengte', lenParts(m.length)]);
      return tiles.length ? `<div class="vc-measure">${tiles.map(([l, [v, u]]) => `<div><span>${l}</span><strong class="mono">${v} <small>${u}</small></strong></div>`).join('')}</div>` : '';
    };
    const locateBtn = '<button type="button" class="btn" data-vc="locate"><svg><use href="#i-gps"/></svg>Mijn locatie</button>';
    const foot = `${notice ? `<p class="vc-notice">${esc(notice)}</p>` : ''}<p class="vc-foot">Kijklink · gemaakt met Kaartdata</p>`;

    function highlight(f) {
      feats.forEach(x => {
        const l = layerOf.get(x);
        if (l instanceof L.Marker) l.setIcon(iconFor(x, x === f));
        else l.setStyle(styleFor(x, x === f));
      });
    }

    // Overzicht van alle vakken (bij een projectlink)
    function showAll(zoom) {
      current = null;
      highlight(null);
      const total = feats.reduce((t, f) => { const m = measure(f); return { area: t.area + (m.area || 0), length: t.length + (m.length || 0) }; }, { area: 0, length: 0 });
      card.innerHTML = `
        <div class="vc-head">
          <span class="vc-icon">${icon('i-layers')}</span>
          <div class="vc-titles">
            <span class="vc-name">${esc(projectTitle)}</span>
            <span class="vc-meta">${feats.length} ${feats.length === 1 ? 'vak' : 'vakken'} · tik op een vak voor details</span>
          </div>
        </div>
        ${measureTiles({ area: total.area, length: total.length })}
        <ul class="vc-list">${feats.map((f, i) => {
          const c = f.props.color || '#0a6c8f';
          const m = measureText(f, true);
          return `<li data-i="${i}"><span class="vc-dot" style="color:${esc(c)};background:${esc(c)}1f">${icon(SHAPE_ICON[shapeOf(f)])}</span><span class="vc-li-main"><span>${f.props.ref ? `<span class="mono vc-ref">${esc(f.props.ref)}</span> ` : ''}${esc(f.props.name || SHAPE_LABEL[shapeOf(f)])}</span>${f.props.category ? `<small>${esc(f.props.category)}</small>` : ''}</span><span class="mono vc-li-m">${esc(m)}</span></li>`;
        }).join('')}</ul>
        <div class="vc-actions">
          <button type="button" class="btn" data-vc="fit"><svg><use href="#i-target"/></svg>Toon alles</button>
          ${locateBtn}
        </div>
        ${foot}`;
      sync();
      if (zoom) fitTo(shared.getBounds());
    }

    // Eén vak in detail
    function show(f, zoom) {
      current = f;
      highlight(multi ? f : null);
      const color = f.props.color || '#0a6c8f';
      let c = null;
      try { c = turf.centroid(f.geometry).geometry.coordinates; } catch (e) { /* */ }
      card.innerHTML = `
        ${multi ? `<button type="button" class="vc-back" data-vc="all"><svg><use href="#i-chevron"/></svg>Alle vakken (${feats.length})</button>` : ''}
        <div class="vc-head">
          <span class="vc-icon" style="color:${esc(color)};background:${esc(color)}1f">${icon(SHAPE_ICON[shapeOf(f)])}</span>
          <div class="vc-titles">
            <span class="vc-name">${esc(f.props.name || SHAPE_LABEL[shapeOf(f)] || 'Gedeeld vak')}</span>
            <span class="vc-meta">${[f.props.ref && `<span class="mono vc-ref">${esc(f.props.ref)}</span>`, esc(f.props.category), esc(f.props.status)].filter(Boolean).join(' · ')}</span>
          </div>
        </div>
        ${measureTiles(measure(f))}
        <div class="vc-actions">
          <button type="button" class="btn" data-vc="fit"><svg><use href="#i-target"/></svg>Toon vak</button>
          ${c ? `<a class="btn" target="_blank" rel="noopener" href="https://www.google.com/maps/dir/?api=1&destination=${c[1].toFixed(6)},${c[0].toFixed(6)}"><svg><use href="#i-next"/></svg>Route</a>` : ''}
          ${locateBtn}
        </div>
        ${foot}`;
      sync();
      if (zoom) fitTo(boundsOf([f]));
    }

    function sync() {
      document.documentElement.style.setProperty('--vc-h', `${card.offsetHeight}px`);
    }

    card.addEventListener('click', (e) => {
      const li = e.target.closest('.vc-list li[data-i]');
      if (li) { show(feats[+li.dataset.i], true); return; }
      const act = e.target.closest('[data-vc]')?.dataset.vc;
      if (act === 'all') showAll(true);
      if (act === 'fit') fitTo(current ? boundsOf([current]) : shared.getBounds());
      if (act === 'locate') locate();
    });
    map.on('click', () => { if (multi && current) showAll(false); });

    function locate() {
      if (!('geolocation' in navigator)) return;
      navigator.geolocation.getCurrentPosition((p) => {
        const ll = L.latLng(p.coords.latitude, p.coords.longitude);
        if (!pos) {
          pos = L.layerGroup([
            L.circle(ll, { radius: p.coords.accuracy, color: '#1a73e8', weight: 1, fillOpacity: 0.12, interactive: false }),
            L.circleMarker(ll, { radius: 7, color: '#fff', weight: 2.5, fillColor: '#1a73e8', fillOpacity: 1, interactive: false }),
          ]).addTo(map);
        } else {
          pos.getLayers()[0].setLatLng(ll).setRadius(p.coords.accuracy);
          pos.getLayers()[1].setLatLng(ll);
        }
        fitTo((current ? boundsOf([current]) : shared.getBounds()).extend(ll));
      }, () => alert('Je locatie kon niet worden bepaald. Sta locatie toe in je browserinstellingen.'), { enableHighAccuracy: true, timeout: 15000 });
    }

    if (multi) showAll(true); else show(feats[0], true);
  }

  if (viewerMode) { window.Kaartdata = { map }; startViewer(); return; }

  // Opent iemand in de app een nieuwe kijklink, laad dan de kijkweergave
  window.addEventListener('hashchange', () => { if (Share.payloadFromHash()) location.reload(); });

  // ---------------------------------------------------------------- Lagen
  function attachLayer(f) {
    const layer = featureToLayer(f);
    layer.featureId = f.id;
    layer.addTo(group);
    featureLayers.set(f.id, layer);
    wireLayer(layer);
    applyStyle(f);
    return layer;
  }

  function wireLayer(layer) {
    layer.on('click', (e) => {
      if (picking) return;   // klik gaat door naar de kaart (vlak selecteren)
      if (map.pm.globalRemovalModeEnabled && map.pm.globalRemovalModeEnabled()) return;
      L.DomEvent.stopPropagation(e);
      select(layer.featureId);
    });
    const persist = () => {
      const f = Store.feature(layer.featureId);
      if (!f) return;
      Store.updateFeature(f.id, layerToGeometry(layer, f.shape));
      if (f.id === selectedId) renderMeasure(f);
      renderList();
    };
    layer.on('pm:edit pm:dragend pm:rotateend', persist);
  }

  function renderLayers() {
    group.clearLayers();
    featureLayers.clear();
    const p = Store.activeProject();
    if (!p) return;
    Store.features(p.id).forEach(attachLayer);
  }

  // Nieuw getekend object
  function createFromLayer(shape, layer, extraProps) {
    const p = Store.activeProject();
    if (!p) { layer.remove(); return null; }
    const count = Store.features(p.id).length + 1;
    const kind = shape === 'Marker' || shape === 'Line' ? 'asset' : 'gebied';
    const f = Store.addFeature({
      projectId: p.id,
      shape,
      ...layerToGeometry(layer, shape),
      props: {
        name: `${SHAPE_LABEL[shape] || shape} ${count}`,
        kind,
        category: shape === 'Marker' ? 'Overig' : shape === 'Line' ? 'Kabel' : 'Projectgebied',
        status: 'Gepland',
        ref: '',
        notes: '',
        color: p.color,
        ...(extraProps || {}),
      },
    });
    layer.remove();          // vervangen door onze eigen laag
    attachLayer(f);
    setDrawButton(null);
    renderList();
    select(f.id, { focusName: true });
    if (isMobile()) toast('Opgeslagen · vul de gegevens aan');
    return f;
  }
  map.on('pm:create', (e) => createFromLayer(e.shape, e.layer));

  map.on('pm:remove', (e) => {
    const id = e.layer.featureId;
    if (!id) return;
    Store.deleteFeature(id);
    featureLayers.delete(id);
    if (selectedId === id) closePanel();
    renderList();
    toast('Object verwijderd');
  });

  map.on('pm:cut', (e) => {
    const id = e.originalLayer?.featureId;
    if (!id) return;
    const f = Store.feature(id);
    e.layer.remove();
    if (!e.layer.getLatLngs || e.layer.getLatLngs().flat(Infinity).length === 0) {
      Store.deleteFeature(id);
    } else {
      Store.updateFeature(id, { geometry: e.layer.toGeoJSON().geometry, shape: f.shape === 'Rectangle' ? 'Polygon' : f.shape });
    }
    renderLayers();
    renderList();
    if (selectedId === id) select(id);
  });

  map.on('click', (e) => {
    if (picking) { pickMsg = `${isMobile() ? 'Tik' : 'Klik'} op een groen vlak, haag of boom`; renderPickStatus(); pickMsg = ''; return; }
    if (!map.pm.globalDrawModeEnabled() && !editLayer) closePanel();
  });

  // ---------------------------------------------------------------- Tekenknoppen
  const drawButtons = document.querySelectorAll('[data-draw]');
  const hint = $('#drawHint');
  let drawShape = null;     // vorm die nu getekend wordt
  let editLayer = null;     // laag die nu bewerkt wordt (vorm aanpassen)

  function vertexCount() {
    const wl = map.pm.Draw[drawShape]?._layer;
    if (!wl || !wl.getLatLngs) return 0;
    return wl.getLatLngs().flat(Infinity).length;
  }

  function updateHintButtons() {
    const multi = drawShape === 'Polygon' || drawShape === 'Line';
    const n = multi ? vertexCount() : 0;
    $('#drawUndo').hidden = !multi;
    $('#drawUndo').disabled = n === 0;
    $('#drawFinish').hidden = !(multi || editLayer);
    $('#drawFinish').disabled = multi && n < (drawShape === 'Polygon' ? 3 : 2);
    $('#drawGps').hidden = !(multi || drawShape === 'Marker') || !('geolocation' in navigator);
    $('#cancelDraw').hidden = !!editLayer;
    $('#pickNext').hidden = true;
    $('#pickZoom').hidden = !picking || !viewTooLarge();
    $('#pickMerge').hidden = !picking || selectedItems().filter(g => g.item.kind === 'polygon').length < 2;
    $('#pickMerge').classList.toggle('on', pickMerge);
    $('#pickAccept').hidden = !picking || !selectedItems().length;
    if (picking) { const n = selectedItems().length; $('#pickAccept').querySelector('span').textContent = n > 1 && !isMobile() ? `Overnemen (${n})` : 'Overnemen'; }
    if (multi && n > 0) {
      const need = drawShape === 'Polygon' ? 3 : 2;
      $('#drawHintText').textContent = n < need
        ? `${n} punt${n === 1 ? '' : 'en'} · nog ${need - n} nodig`
        : `${n} punten · tik op Klaar om af te ronden`;
    }
  }

  function setDrawButton(shape) {
    drawShape = shape;
    drawButtons.forEach(b => b.classList.toggle('active', b.dataset.draw === shape));
    hint.hidden = !shape && !editLayer && !picking;
    document.body.classList.toggle('drawing', !!shape || !!editLayer || picking);
    if (shape) $('#drawHintText').textContent = (isMobile() ? DRAW_HINT_TOUCH : DRAW_HINT)[shape] || '';
    updateHintButtons();
  }

  function stopDrawing() { map.pm.disableDraw(); setDrawButton(null); }

  drawButtons.forEach(btn => btn.addEventListener('click', () => {
    if (!Store.activeProject()) { toast('Maak eerst een project aan'); return; }
    const shape = btn.dataset.draw;
    if (map.pm.Draw[shape]?.enabled()) { stopDrawing(); return; }
    stopEditing();
    stopPick();
    closePanel();
    const color = Store.activeProject().color;
    map.pm.enableDraw(shape, {
      pathOptions: { color, fillColor: color, fillOpacity: 0.2 },
      templineStyle: { color },
      hintlineStyle: { color, dashArray: '5 5' },
      markerStyle: { icon: pinIcon(color) },
      continueDrawing: false,
      finishOn: null,
      tooltips: !isMobile(),
    });
    setDrawButton(shape);
  }));

  map.on('pm:drawstart', ({ workingLayer }) => {
    workingLayer?.on?.('pm:vertexadded pm:vertexremoved', () => setTimeout(updateHintButtons, 0));
  });
  map.on('pm:drawend', () => { if (drawShape) setDrawButton(null); });

  $('#drawUndo').addEventListener('click', () => {
    map.pm.Draw[drawShape]?._removeLastVertex?.();
    updateHintButtons();
  });
  $('#drawFinish').addEventListener('click', () => {
    if (editLayer) { stopEditing(); return; }
    map.pm.Draw[drawShape]?._finishShape?.();
  });
  $('#drawGps').addEventListener('click', async () => {
    const shape = drawShape;
    const btn = $('#drawGps');
    btn.disabled = true;
    try {
      const pos = await getPosition();
      if (shape === 'Marker') {
        map.pm.disableDraw();
        createFromLayer('Marker', L.marker(pos.latlng));
        toast(`Punt geplaatst op GPS (±${Math.round(pos.accuracy)} m)`);
      } else if (drawShape === shape) {
        map.pm.Draw[shape]._createVertex({ latlng: pos.latlng });
        map.panTo(pos.latlng);
        toast(`GPS-punt toegevoegd (±${Math.round(pos.accuracy)} m)`);
        updateHintButtons();
      }
    } catch (err) {
      toast(err.message);
    } finally {
      btn.disabled = false;
    }
  });
  $('#cancelDraw').addEventListener('click', () => { if (picking) stopPick(); else if (editLayer) stopEditing(); else stopDrawing(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { if (picking) stopPick(); else if (editLayer) stopEditing(); else stopDrawing(); }
  });

  // Vorm bewerken (hoekpunten slepen) — op telefoon met inklapbaar paneel
  function startEditing(layer) {
    stopPick();
    stopDrawing();
    editLayer = layer;
    layer.pm.enable({ allowSelfIntersection: false, draggable: true });
    const point = layer instanceof L.Marker;
    $('#drawHintText').textContent = point
      ? 'Sleep het punt naar de nieuwe plek'
      : (isMobile() ? 'Sleep de hoekpunten · houd een punt vast om het te verwijderen' : 'Sleep de hoekpunten · rechtsklik op een punt om het te verwijderen');
    hint.hidden = false;
    document.body.classList.add('drawing');
    $('#panel').classList.add('peek');
    updateHintButtons();
    if (isMobile()) {
      const b = layer.getBounds ? layer.getBounds() : L.latLngBounds([layer.getLatLng(), layer.getLatLng()]);
      map.fitBounds(b, { paddingTopLeft: [40, 90], paddingBottomRight: [40, 210], maxZoom: Math.max(map.getZoom(), 18) });
    }
    $('#editShape').classList.add('active');
  }
  function stopEditing() {
    if (!editLayer) return;
    editLayer.pm.disable();
    editLayer = null;
    $('#panel').classList.remove('peek');
    $('#editShape').classList.remove('active');
    setDrawButton(null);
    const f = Store.feature(selectedId);
    if (f) { renderMeasure(f); toast('Vorm opgeslagen'); }
  }

  // ---------------------------------------------------------------- GPS / mijn locatie
  let posLayer = null;
  function getPosition() {
    return new Promise((resolve, reject) => {
      if (!('geolocation' in navigator)) return reject(new Error('Locatie wordt niet ondersteund op dit toestel'));
      navigator.geolocation.getCurrentPosition(
        (p) => {
          const pos = { latlng: L.latLng(p.coords.latitude, p.coords.longitude), accuracy: p.coords.accuracy };
          showPosition(pos);
          resolve(pos);
        },
        (err) => reject(new Error(err.code === 1
          ? 'Geen toegang tot je locatie. Sta locatie toe in je browserinstellingen.'
          : 'Locatie niet gevonden. Probeer het buiten opnieuw.')),
        { enableHighAccuracy: true, timeout: 15000, maximumAge: 5000 });
    });
  }
  function showPosition({ latlng, accuracy }) {
    if (!posLayer) {
      posLayer = L.layerGroup([
        L.circle(latlng, { radius: accuracy, color: '#1a73e8', weight: 1, fillColor: '#1a73e8', fillOpacity: 0.12, interactive: false, pmIgnore: true }),
        L.circleMarker(latlng, { radius: 7, color: '#fff', weight: 2.5, fillColor: '#1a73e8', fillOpacity: 1, interactive: false, pmIgnore: true }),
      ]).addTo(map);
    } else {
      const [acc, dot] = posLayer.getLayers();
      acc.setLatLng(latlng).setRadius(accuracy);
      dot.setLatLng(latlng);
    }
  }
  $('#locateBtn').addEventListener('click', async () => {
    const btn = $('#locateBtn');
    btn.classList.add('busy');
    try {
      const pos = await getPosition();
      map.setView(pos.latlng, Math.max(map.getZoom(), 18));
      btn.classList.add('on');
    } catch (err) {
      toast(err.message);
    } finally {
      btn.classList.remove('busy');
    }
  });

  // ---------------------------------------------------------------- Groen selecteren uit de kaart (PDOK BGT)
  // Alleen groenobjecten: begroeide terreindelen, groene bermen, vegetatievlakken, hagen en bomen.
  // In selecteermodus wordt al het groen in beeld getoond; tik om te (de)selecteren.
  const BGT = 'https://api.pdok.nl/lv/bgt/ogc/v1/collections';
  const cap = (t) => t ? t.charAt(0).toUpperCase() + t.slice(1) : '';
  const GREEN = { vlak: '#3f8f3a', berm: '#5f9e2f', haag: '#2d6a27', boom: '#1d7a3c' };

  function greenCategory(text) {
    const t = (text || '').toLowerCase();
    if (/gras|kruid/.test(t)) return 'Gras';
    if (/heester|struik|bodembedek|haag/.test(t)) return 'Beplanting';
    if (/bos|houtwal|boom/.test(t)) return 'Bos';
    return 'Groen';
  }

  const GREEN_SOURCES = [
    { id: 'begroeidterreindeel', kind: 'polygon', describe: (p) => {
        const t = p.plus_fysiek_voorkomen || p.fysiek_voorkomen;
        return { name: cap(t) || 'Groenvlak', category: greenCategory(t), color: GREEN.vlak, source: 'BGT begroeid terreindeel',
          extra: p.plus_fysiek_voorkomen && p.fysiek_voorkomen ? p.fysiek_voorkomen : '' };
      } },
    { id: 'ondersteunendwegdeel', kind: 'polygon',
      keep: (p) => /groen|gras|heester|bodembedek|begroeid/i.test(`${p.fysiek_voorkomen} ${p.plus_fysiek_voorkomen}`),
      describe: (p) => {
        const t = p.plus_fysiek_voorkomen || p.fysiek_voorkomen;
        return { name: `${cap(p.plus_functie || p.functie) || 'Berm'} (${t})`, category: greenCategory(t) === 'Groen' ? 'Berm' : greenCategory(t),
          color: GREEN.berm, source: 'BGT ondersteunend wegdeel' };
      } },
    { id: 'vegetatieobject_vlak', kind: 'polygon', describe: (p) => ({
        name: cap(p.plus_type) || 'Vegetatie', category: greenCategory(p.plus_type), color: GREEN.haag, source: 'BGT vegetatieobject' }) },
    { id: 'vegetatieobject_lijn', kind: 'line', describe: (p) => ({
        name: cap(p.plus_type) || 'Haag', category: p.plus_type === 'haag' ? 'Haag' : 'Beplanting', color: GREEN.haag, source: 'BGT vegetatieobject' }) },
    { id: 'vegetatieobject_punt', kind: 'point', describe: (p) => ({
        name: cap(p.plus_type) || 'Boom', category: 'Boom', color: GREEN.boom, source: 'BGT vegetatieobject' }) },
  ];

  let picking = false;
  let pickMerge = false;
  let pickCtrl = null;
  let pickMsg = '';
  let pickLoading = 0;
  let pickTimer = null;
  const greenItems = new Map();     // id -> { item, layer, selected }
  const pickButtons = document.querySelectorAll('[data-pick]');
  map.createPane('greenPick').style.zIndex = 450;
  const greenRenderer = L.canvas({ pane: 'greenPick', tolerance: 8 });
  const greenGroup = L.layerGroup();

  const selectedItems = () => [...greenItems.values()].filter(g => g.selected);

  function greenStyle(item, selected) {
    if (item.kind === 'point') {
      // Bomen kleiner bij verder uitzoomen, zodat de groenvlakken eronder aan te tikken blijven
      const z = map.getZoom();
      const r = z >= 18 ? 5.5 : z >= 17 ? 4.5 : 3;
      return selected
        ? { radius: r + 2.5, color: '#fff', weight: 2.5, fillColor: '#0f5a2a', fillOpacity: 1 }
        : { radius: r, color: '#fff', weight: z >= 17 ? 1.2 : 0.8, fillColor: item.info.color, fillOpacity: 0.85 };
    }
    if (item.kind === 'line') {
      return selected ? { color: '#0f5a2a', weight: 7, opacity: 1 } : { color: item.info.color, weight: 5, opacity: 0.6 };
    }
    return selected
      ? { color: '#0f5a2a', weight: 2.5, fillColor: '#2fa84f', fillOpacity: 0.55 }
      : { color: item.info.color, weight: 1, fillColor: item.info.color, fillOpacity: 0.18 };
  }

  function startPick() {
    if (!Store.activeProject()) { toast('Maak eerst een project aan'); return; }
    stopDrawing();
    stopEditing();
    closePanel();
    picking = true;
    pickMsg = '';
    pickCtrl = new AbortController();
    pickButtons.forEach(b => b.classList.add('active'));
    greenGroup.addTo(map);
    hint.hidden = false;
    document.body.classList.add('drawing');
    renderPickStatus();
    loadGreen();
  }

  function stopPick() {
    if (!picking) return;
    picking = false;
    pickCtrl?.abort();
    clearTimeout(pickTimer);
    greenGroup.clearLayers();
    greenGroup.remove();
    greenItems.clear();
    pickLoading = 0;
    pickQueue = [];
    pickActive = 0;
    pickOk = pickFailed = 0;
    tilesDone.clear();
    tilesBusy.clear();
    pickButtons.forEach(b => b.classList.remove('active'));
    hint.classList.remove('loading');
    setDrawButton(null);
  }

  pickButtons.forEach(b => b.addEventListener('click', () => { if (picking) stopPick(); else startPick(); }));
  map.on('zoomend', () => {
    if (!picking) return;
    greenItems.forEach(g => { if (g.item.kind === 'point') g.layer.setStyle(greenStyle(g.item, g.selected)); });
  });
  map.on('moveend', () => {
    if (!picking) return;
    clearTimeout(pickTimer);
    pickTimer = setTimeout(loadGreen, 250);
  });

  // Het groen wordt in vakken van ca. 350 × 330 m geladen: snel, parallel, en
  // eenmaal geladen vakken worden bij verschuiven niet opnieuw opgehaald.
  const TILE_W = 0.005, TILE_H = 0.003;
  const MAX_VIEW_KM2 = 1.6;
  const tilesDone = new Set();
  const tilesBusy = new Set();
  let pickQueue = [];
  let pickActive = 0;
  let pickOk = 0, pickFailed = 0;

  function viewKm2() {
    const b = map.getBounds();
    const kmLat = (b.getNorth() - b.getSouth()) * 111.32;
    const kmLng = (b.getEast() - b.getWest()) * 111.32 * Math.cos(b.getCenter().lat * Math.PI / 180);
    return kmLat * kmLng;
  }
  const viewTooLarge = () => map.getZoom() < 16 || viewKm2() > MAX_VIEW_KM2;

  function renderPickStatus() {
    pickLoading = pickActive + pickQueue.length;
    hint.classList.toggle('loading', pickLoading > 0);
    const verb = isMobile() ? 'Tik' : 'Klik';
    const sel = selectedItems();
    let html;
    if (viewTooLarge() && !sel.length) {
      html = `Zoom verder in om het groen te tonen<small>Gras, beplanting, hagen en bomen verschijnen vanaf straatniveau</small>`;
    } else if (!sel.length) {
      html = pickLoading > 0 && !greenItems.size
        ? 'Groen laden'
        : (pickMsg || `${verb} op groenvlakken, hagen of bomen<small>Je kunt er meerdere achter elkaar kiezen</small>`);
    } else {
      const polys = sel.filter(g => g.item.kind === 'polygon');
      const trees = sel.filter(g => g.item.kind === 'point').length;
      const lines = sel.filter(g => g.item.kind === 'line');
      const parts = [];
      if (polys.length) parts.push(`${polys.length} ${polys.length === 1 ? 'vlak' : 'vlakken'} · ${areaParts(polys.reduce((t, g) => t + g.item.area, 0)).slice(0, 2).join(' ')}`);
      if (lines.length) parts.push(`${lines.length} ${lines.length === 1 ? 'haag' : 'hagen'} · ${lenParts(lines.reduce((t, g) => t + g.item.length, 0)).slice(0, 2).join(' ')}`);
      if (trees) parts.push(`${trees} ${trees === 1 ? 'boom' : 'bomen'}`);
      html = `<strong>${parts.join(' · ')}</strong><small>${esc(pickMsg || `${verb} nog eens om iets weg te halen`)}</small>`;
    }
    $('#drawHintText').innerHTML = html;
    updateHintButtons();
  }

  async function fetchCollection(src, bbox, signal, onPage) {
    const now = new Date().toISOString().slice(0, 19) + 'Z';   // alleen de actuele objecten
    let url = `${BGT}/${src.id}/items?f=json&limit=1000&bbox=${bbox}&datetime=${now}`;
    for (let page = 0; url && page < 5; page++) {
      const res = await fetch(url, { signal });
      if (!res.ok) throw new Error(`${src.id}: ${res.status}`);
      const data = await res.json();
      onPage(data.features || []);
      url = (data.links || []).find(l => l.rel === 'next')?.href;
    }
  }

  function tileBbox(key) {
    const [i, j] = key.split('_').map(Number);
    return [i * TILE_W, j * TILE_H, (i + 1) * TILE_W, (j + 1) * TILE_H].map(v => v.toFixed(6)).join(',');
  }

  function loadGreen() {
    if (!picking) return;
    renderPickStatus();
    if (viewTooLarge()) return;
    const b = map.getBounds().pad(0.1);
    const c = map.getCenter();
    const keys = [];
    for (let i = Math.floor(b.getWest() / TILE_W); i <= Math.floor(b.getEast() / TILE_W); i++) {
      for (let j = Math.floor(b.getSouth() / TILE_H); j <= Math.floor(b.getNorth() / TILE_H); j++) {
        const key = `${i}_${j}`;
        if (!tilesDone.has(key) && !tilesBusy.has(key)) keys.push(key);
      }
    }
    keys.forEach(key => {
      tilesBusy.add(key);
      const tile = { key, left: GREEN_SOURCES.length, failed: false };
      GREEN_SOURCES.forEach(src => pickQueue.push({ src, tile }));
    });
    // Vakken in het midden van het scherm eerst
    const dist = (job) => {
      const [i, j] = job.tile.key.split('_').map(Number);
      return Math.hypot((i + 0.5) * TILE_W - c.lng, ((j + 0.5) * TILE_H - c.lat) * 1.6);
    };
    pickQueue.sort((a, z) => dist(a) - dist(z));
    pumpPick();
  }

  function pumpPick() {
    const signal = pickCtrl.signal;
    while (picking && pickActive < 8 && pickQueue.length) {
      const job = pickQueue.shift();
      pickActive++;
      fetchCollection(job.src, tileBbox(job.tile.key), signal, (feats) => {
        if (picking && !signal.aborted) feats.forEach(f => addGreen(job.src, f));
      })
        .then(() => { pickOk++; })
        .catch(() => { if (!signal.aborted) { pickFailed++; job.tile.failed = true; } })
        .finally(() => {
          if (signal.aborted || !picking) return;
          pickActive--;
          if (--job.tile.left === 0) {
            tilesBusy.delete(job.tile.key);
            if (!job.tile.failed) tilesDone.add(job.tile.key);   // mislukte vakken later opnieuw
          }
          if (!pickActive && !pickQueue.length) {
            if (!pickOk && pickFailed) pickMsg = 'PDOK is niet bereikbaar. Controleer je internetverbinding.';
            else if (!greenItems.size) pickMsg = 'Geen groen gevonden in dit gebied';
          }
          renderPickStatus();
          pickMsg = '';
          pumpPick();
        });
    }
    renderPickStatus();
  }

  $('#pickZoom').addEventListener('click', () => {
    let z = Math.max(map.getZoom() + 1, 16);
    map.setZoom(z);
    map.once('zoomend', () => { if (viewTooLarge()) map.setZoom(map.getZoom() + 1); });
  });

  function addGreen(src, f) {
    if (!f.geometry || f.properties.eind_registratie != null) return;
    if (src.keep && !src.keep(f.properties)) return;
    const srcId = f.properties.lokaal_id || f.id;
    const id = `${src.id}:${srcId}`;
    if (greenItems.has(id)) return;
    let geometry = f.geometry;
    if (geometry.type === 'MultiPolygon' && geometry.coordinates.length === 1) geometry = { type: 'Polygon', coordinates: geometry.coordinates[0] };
    if (geometry.type === 'MultiLineString' && geometry.coordinates.length === 1) geometry = { type: 'LineString', coordinates: geometry.coordinates[0] };
    if (src.kind === 'point' && geometry.type !== 'Point') return;
    const item = { id, srcId, geometry, kind: src.kind, info: src.describe(f.properties) };
    if (item.kind === 'polygon') item.area = turf.area(geometry);
    if (item.kind === 'line') item.length = turf.length(geometry, { units: 'meters' });
    const layer = L.geoJSON(geometry, {
      renderer: greenRenderer, pane: 'greenPick', pmIgnore: true,
      style: () => greenStyle(item, false),
      pointToLayer: (_, ll) => L.circleMarker(ll, { renderer: greenRenderer, pane: 'greenPick', pmIgnore: true, ...greenStyle(item, false) }),
    });
    layer.on('click', (e) => { L.DomEvent.stop(e); toggleGreen(id); });
    layer.bindTooltip(() => {
      const m = item.area ? ` · ${areaParts(item.area).slice(0, 2).join(' ')}` : item.length ? ` · ${lenParts(item.length).slice(0, 2).join(' ')}` : '';
      return esc(item.info.name) + m;
    }, { sticky: true, direction: 'top', opacity: 0.95 });
    const g = { item, layer, selected: false };
    greenItems.set(id, g);
    // Bomen bovenop vlakken
    layer.addTo(greenGroup);
    if (item.kind === 'point' || item.kind === 'line') layer.bringToFront();
  }

  function toggleGreen(id) {
    const g = greenItems.get(id);
    if (!g) return;
    g.selected = !g.selected;
    g.layer.setStyle(greenStyle(g.item, g.selected));
    if (g.selected && g.item.kind !== 'polygon') g.layer.bringToFront();
    pickMsg = `${g.item.info.name} ${g.selected ? 'geselecteerd' : 'weggehaald'}`;
    renderPickStatus();
    pickMsg = '';
  }

  $('#pickNext').hidden = true;

  $('#pickMerge').addEventListener('click', () => {
    pickMerge = !pickMerge;
    toast(pickMerge ? 'Samenvoegen aan: de vlakken worden één gebied' : 'Samenvoegen uit: elk vlak wordt een los object');
    updateHintButtons();
  });

  function propsFromItem(item) {
    const info = item.info;
    return {
      name: info.name,
      kind: item.kind === 'polygon' ? 'gebied' : 'asset',
      category: info.category,
      ref: '',
      color: info.color,
      status: 'In beheer',
      bgt: [item.id],
      notes: `Overgenomen uit ${info.source}${item.srcId ? ` (id ${item.srcId})` : ''} op ${new Date().toLocaleDateString('nl-NL')}.${info.extra ? `\n${cap(info.extra)}.` : ''}`,
    };
  }
  const SHAPE_FOR = { polygon: 'Polygon', line: 'Line', point: 'Marker' };

  $('#pickAccept').addEventListener('click', () => {
    const p = Store.activeProject();
    const sel = selectedItems().map(g => g.item);
    if (!p || !sel.length) return;

    let toCreate = sel.map(item => ({ shape: SHAPE_FOR[item.kind], geometry: item.geometry, props: propsFromItem(item) }));
    const polys = sel.filter(i => i.kind === 'polygon');
    if (pickMerge && polys.length > 1) {
      let merged = null;
      try { merged = turf.union(turf.featureCollection(polys.map(i => turf.feature(i.geometry)))); } catch (err) { merged = null; }
      if (!merged) { toast('Samenvoegen lukte niet; zet Samenvoegen uit en neem de vlakken los over'); return; }
      const same = (k) => polys.every(i => i.info[k] === polys[0].info[k]);
      const mergedObj = {
        shape: 'Polygon', geometry: merged.geometry,
        props: {
          ...propsFromItem(polys[0]),
          name: same('name') ? polys[0].info.name : 'Groengebied',
          category: same('category') ? polys[0].info.category : 'Groen',
          bgt: polys.map(i => i.id),
          notes: `Samengevoegd uit ${polys.length} vlakken op ${new Date().toLocaleDateString('nl-NL')}:\n` +
            polys.map(i => `- ${i.info.name} (${i.info.source}${i.srcId ? `, id ${i.srcId}` : ''})`).join('\n'),
        },
      };
      toCreate = [mergedObj, ...toCreate.filter(o => o.shape !== 'Polygon')];
    }

    stopPick();
    if (toCreate.length === 1) {
      const o = toCreate[0];
      createFromLayer(o.shape, featureToLayer({ shape: o.shape, geometry: o.geometry, props: o.props }), o.props);
      return;
    }
    const created = toCreate.map(o => {
      const f = Store.addFeature({ projectId: p.id, shape: o.shape, geometry: o.geometry, props: o.props });
      attachLayer(f);
      return f;
    });
    renderList();
    renderCategories();
    const b = L.latLngBounds([]);
    created.forEach(f => { const l = featureLayers.get(f.id); if (!l) return; if (l.getBounds) b.extend(l.getBounds()); else b.extend(l.getLatLng()); });
    if (b.isValid() && !map.getBounds().contains(b)) map.fitBounds(b, { padding: [40, 40], maxZoom: map.getZoom() });
    toast(`${created.length} groenobjecten overgenomen`);
  });

  // ---------------------------------------------------------------- Projecten
  const projectSelect = $('#projectSelect');

  function renderProjects() {
    const projects = Store.projects();
    projectSelect.innerHTML = projects.map(p =>
      `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');
    projectSelect.value = Store.state.activeProjectId || '';
    const p = Store.activeProject();
    $('#projectSwatch').style.background = p?.color || 'var(--faint)';
    $('#projectMeta').innerHTML = p
      ? [p.client && `<strong>${esc(p.client)}</strong>`, p.description && esc(p.description)].filter(Boolean).join(' · ')
      : 'Nog geen project. Klik op “Nieuw”.';
  }

  function renderStats() {
    const p = Store.activeProject();
    const feats = p ? Store.features(p.id) : [];
    let area = 0, length = 0;
    feats.forEach(f => { const m = measure(f); area += m.area || 0; length += m.length || 0; });
    const set = (k, v) => { $(`#projectStats [data-stat="${k}"]`).textContent = v; };
    set('count', feats.length);
    set('area', area ? areaParts(area).slice(0, 2).join(' ') : '–');
    set('length', length ? lenParts(length).slice(0, 2).join(' ') : '–');
  }

  projectSelect.addEventListener('change', () => {
    Store.setActive(projectSelect.value);
    closePanel();
    refreshAll();
    zoomToProject();
  });

  const projectDialog = $('#projectDialog');
  const projectForm = $('#projectForm');
  let editingProjectId = null;

  const swatchesEl = $('#swatches');
  function setSwatch(color) {
    projectForm.color.value = color;
    swatchesEl.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.color === color));
  }
  swatchesEl.innerHTML = PROJECT_COLORS.map(c =>
    `<button type="button" data-color="${c}" style="background:${c}" aria-label="Kleur ${c}"></button>`).join('');
  swatchesEl.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-color]');
    if (b) setSwatch(b.dataset.color);
  });

  function openProjectDialog(project) {
    editingProjectId = project?.id ?? null;
    $('#projectDialogTitle').textContent = project ? 'Project bewerken' : 'Nieuw project';
    projectForm.reset();
    projectForm.name.value = project?.name || '';
    projectForm.client.value = project?.client || '';
    projectForm.description.value = project?.description || '';
    const used = new Set(Store.projects().map(p => p.color));
    setSwatch(project?.color || PROJECT_COLORS.find(c => !used.has(c)) || PROJECT_COLORS[0]);
    projectDialog.showModal();
    projectForm.name.focus();
  }

  // Eigen bevestigingsvenster in plaats van confirm()
  const confirmDialog = $('#confirmDialog');
  function askConfirm(title, text) {
    $('#confirmTitle').textContent = title;
    $('#confirmText').textContent = text;
    confirmDialog.returnValue = '';
    confirmDialog.showModal();
    return new Promise(resolve => {
      confirmDialog.addEventListener('close', () => resolve(confirmDialog.returnValue === 'ok'), { once: true });
    });
  }

  projectDialog.addEventListener('close', () => {
    if (projectDialog.returnValue !== 'ok') return;
    const data = {
      name: projectForm.name.value.trim() || 'Naamloos project',
      client: projectForm.client.value.trim(),
      description: projectForm.description.value.trim(),
      color: projectForm.color.value,
    };
    if (editingProjectId) {
      Store.updateProject(editingProjectId, data);
      toast('Project bijgewerkt');
    } else {
      Store.addProject(data);
      toast('Project aangemaakt');
    }
    closePanel();
    refreshAll();
  });

  $('#newProject').addEventListener('click', () => openProjectDialog(null));
  $('#editProject').addEventListener('click', () => {
    const p = Store.activeProject();
    if (p) openProjectDialog(p);
  });
  $('#deleteProject').addEventListener('click', async () => {
    const p = Store.activeProject();
    if (!p) return;
    const n = Store.features(p.id).length;
    if (!await askConfirm('Project verwijderen?', `“${p.name}” en ${n} object(en) worden definitief verwijderd. Maak eventueel eerst een GeoJSON-export.`)) return;
    Store.deleteProject(p.id);
    closePanel();
    refreshAll();
    toast('Project verwijderd');
  });

  function zoomToProject() {
    const b = group.getBounds();
    if (b.isValid()) map.fitBounds(b, { padding: [40, 40], maxZoom: 18 });
  }

  // ---------------------------------------------------------------- Lijst
  const listEl = $('#featureList');

  function renderList() {
    const p = Store.activeProject();
    const q = $('#search').value.trim().toLowerCase();
    const type = typeFilter;
    const all = p ? Store.features(p.id) : [];
    const items = all.filter(f => {
      if (type && f.props.kind !== type) return false;
      if (!q) return true;
      return [f.props.name, f.props.category, f.props.notes, f.props.ref, f.props.status]
        .some(v => String(v || '').toLowerCase().includes(q));
    });
    $('#featureCount').textContent = all.length;
    renderStats();
    if (!items.length) {
      listEl.innerHTML = all.length
        ? `<li class="empty"><strong>Geen resultaten</strong><span>Pas je zoekterm of filter aan.</span></li>`
        : `<li class="empty">${icon('i-empty')}<strong>Nog geen objecten</strong><span>Kies een tekengereedschap en klik op de kaart om je eerste gebied of asset vast te leggen.</span></li>`;
      return;
    }
    listEl.innerHTML = items.map(f => {
      const c = colorOf(f);
      const st = f.props.status ? `<span class="status ${STATUS_CLASS[f.props.status] || ''}">${esc(f.props.status)}</span>` : '';
      const sub = [f.props.ref && `<span class="f-ref mono">${esc(f.props.ref)}</span>`, f.props.category && esc(f.props.category), st].filter(Boolean).join(' · ');
      return `
      <li data-id="${esc(f.id)}" class="${f.id === selectedId ? 'selected' : ''}">
        <span class="f-icon" style="color:${esc(c)};background:${esc(c)}1f">${icon(SHAPE_ICON[shapeOf(f)])}</span>
        <span class="f-main">
          <div class="f-name">${esc(f.props.name || '(naamloos)')}</div>
          <div class="f-sub">${sub}</div>
        </span>
        <span class="f-measure">${esc(measureText(f, true))}</span>
      </li>`;
    }).join('');
  }

  listEl.addEventListener('click', (e) => {
    const li = e.target.closest('li[data-id]');
    if (!li) return;
    if (isMobile()) closeSidebar();
    select(li.dataset.id);
    zoomTo(li.dataset.id);
  });
  $('#search').addEventListener('input', renderList);
  let typeFilter = '';
  $('#typeFilter').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-filter]');
    if (!b) return;
    typeFilter = b.dataset.filter;
    $('#typeFilter').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
    renderList();
  });

  // ---------------------------------------------------------------- Eigenschappenpaneel
  const panel = $('#panel');
  const form = $('#featureForm');

  function select(id, opts = {}) {
    flushSave();
    if (editLayer && editLayer !== featureLayers.get(id)) stopEditing();
    const prev = selectedId;
    selectedId = id;
    if (prev && prev !== id) {
      const pf = Store.feature(prev);
      if (pf) applyStyle(pf);
      featureLayers.get(prev)?.pm?.disable();
    }
    const f = Store.feature(id);
    if (!f) return closePanel();
    applyStyle(f);
    featureLayers.get(id)?.bringToFront?.();

    form.name.value = f.props.name || '';
    form.kind.value = f.props.kind || 'gebied';
    form.category.value = f.props.category || '';
    form.status.value = f.props.status || 'Gepland';
    form.ref.value = f.props.ref || '';
    form.notes.value = f.props.notes || '';
    form.fill.value = f.props.fill || 'effen';
    $('#fillField').hidden = !/Polygon/.test(f.geometry.type) && f.shape !== 'Circle';
    form.color.value = colorOf(f);
    updateFillPreview();
    renderPanelHead(f);
    $('#saveState').textContent = 'Wijzigingen worden automatisch bewaard';
    renderMeasure(f);
    panel.hidden = false;
    map.invalidateSize();
    renderList();
    if (opts.focusName && !isMobile()) { form.name.focus(); form.name.select(); }
  }

  function renderPanelHead(f) {
    const shape = shapeOf(f);
    const c = colorOf(f);
    const kind = f.props.kind === 'asset' ? 'Asset' : 'Gebied';
    $('#panelTitle').textContent = `${kind} · ${SHAPE_LABEL[shape]}`;
    $('#panelName').textContent = f.props.name || '(naamloos)';
    const ic = $('#panelIcon');
    ic.innerHTML = icon(SHAPE_ICON[shape]);
    ic.style.color = c;
    ic.style.background = c + '1f';
    $('#colorHex').textContent = c;
  }

  function renderMeasure(f) {
    $('#measure').innerHTML = measureText(f);
    let c;
    try { c = turf.centroid(f.geometry).geometry.coordinates; } catch (e) { c = null; }
    $('#coords').textContent = c ? `${c[1].toFixed(6)}° N, ${c[0].toFixed(6)}° O · WGS84` : '';
  }

  function closePanel() {
    flushSave();
    if (editLayer) stopEditing();
    if (selectedId) {
      featureLayers.get(selectedId)?.pm?.disable();
      const f = Store.feature(selectedId);
      selectedId = null;
      if (f) applyStyle(f);
    }
    if (!panel.hidden) { panel.hidden = true; map.invalidateSize(); }
    renderList();
  }

  // Gegevens bewaren: direct tijdens het typen (na een korte pauze) en bij sluiten/wisselen
  let saveTimer = null;
  function saveForm(showToast) {
    clearTimeout(saveTimer);
    saveTimer = null;
    const f = Store.feature(selectedId);
    if (!f) return;
    Store.updateFeature(f.id, {
      props: {
        ...f.props,
        name: form.name.value.trim(),
        kind: form.kind.value,
        category: form.category.value.trim(),
        status: form.status.value,
        ref: form.ref.value.trim(),
        notes: form.notes.value,
        color: form.color.value,
        fill: form.fill.value,
      },
    });
    applyStyle(f);
    renderPanelHead(f);
    renderList();
    renderCategories();
    $('#saveState').textContent = 'Bewaard';
    if (showToast) toast('Opgeslagen');
  }
  function flushSave() { if (saveTimer) saveForm(false); }
  window.addEventListener('pagehide', flushSave);
  document.addEventListener('visibilitychange', () => { if (document.hidden) flushSave(); });
  form.addEventListener('submit', (e) => { e.preventDefault(); saveForm(true); });
  ['input', 'change'].forEach(t => form.addEventListener(t, (e) => {
    if (e.target === form.color && t === 'input') return;   // kleur heeft eigen live-voorbeeld
    $('#saveState').textContent = 'Bewaren…';
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => saveForm(false), 500);
  }));
  function updateFillPreview() {
    const r = document.getElementById('fillPreview');
    const color = form.color.value || '#0a6c8f';
    const { fillColor, fillOpacity } = fillFor(form.fill.value, color, form.kind.value === 'asset', defsIn(r.ownerSVGElement), 'fpp');
    r.setAttribute('fill', fillColor);
    r.setAttribute('fill-opacity', fillOpacity);
    r.setAttribute('stroke', color);
  }
  form.fill.addEventListener('change', () => {
    const f = Store.feature(selectedId);
    updateFillPreview();
    if (f) { f.props.fill = form.fill.value; applyStyle(f); }
  });
  // Kleur direct tonen tijdens kiezen
  form.color.addEventListener('input', () => {
    const f = Store.feature(selectedId);
    if (!f) return;
    f.props.color = form.color.value;
    applyStyle(f);
    updateFillPreview();
    renderPanelHead(f);
  });

  $('#closePanel').addEventListener('click', closePanel);
  // Onderpaneel in-/uitklappen door op de kop te tikken (telefoon)
  function togglePeek(e) {
    if (!isMobile() || e.target.closest('#closePanel')) return;
    panel.classList.toggle('peek');
  }
  $('#sheetGrip').addEventListener('click', togglePeek);
  $('#panelHead').addEventListener('click', togglePeek);
  $('#zoomFeature').addEventListener('click', () => zoomTo(selectedId));
  $('#deleteFeature').addEventListener('click', async () => {
    const f = Store.feature(selectedId);
    if (!f || !await askConfirm('Object verwijderen?', `“${f.props.name || 'Naamloos'}” wordt definitief van de kaart verwijderd.`)) return;
    featureLayers.get(f.id)?.remove();
    featureLayers.delete(f.id);
    Store.deleteFeature(f.id);
    closePanel();
    toast('Object verwijderd');
  });
  $('#editShape').addEventListener('click', () => {
    const layer = featureLayers.get(selectedId);
    if (!layer) return;
    if (editLayer === layer) stopEditing();
    else startEditing(layer);
  });

  // Zoom naar object; op telefoon rekening houden met het onderpaneel
  function zoomTo(id) {
    const layer = featureLayers.get(id);
    if (!layer) return;
    const b = layer.getBounds ? layer.getBounds() : L.latLngBounds([layer.getLatLng(), layer.getLatLng()]);
    const sheet = isMobile() && !panel.hidden ? panel.getBoundingClientRect().height : 0;
    map.fitBounds(b, {
      paddingTopLeft: [40, isMobile() ? 80 : 60],
      paddingBottomRight: [40, sheet + 40],
      maxZoom: layer.getBounds ? 19 : Math.max(map.getZoom(), 18),
    });
  }

  function renderCategories() {
    const used = Store.state.features.map(f => f.props.category).filter(Boolean);
    const cats = [...new Set([...DEFAULT_CATEGORIES, ...used])].sort((a, b) => a.localeCompare(b, 'nl'));
    $('#categoryList').innerHTML = cats.map(c => `<option value="${esc(c)}">`).join('');
  }


  // ---------------------------------------------------------------- Delen (kijklink)
  // Kijklink zonder lengtegrens: één vak of alle vakken van het project, vorm op ± 10 cm
  const shareDialog = $('#shareDialog');
  let shareTitleText = '';
  async function openShare(features, title, label) {
    flushSave();
    if (!features.length) { toast('Er zijn nog geen vakken om te delen'); return; }
    let res;
    try {
      res = await Share.linkFor(features, { title });
    } catch (err) {
      toast('Delen lukte niet: ' + err.message);
      return;
    }
    const url = res.url;
    shareTitleText = label;
    $('#shareUrl').value = url;
    $('#shareTitle').textContent = `Kijklink voor ${label}`;
    const n = features.length;
    let info = `${n} ${n === 1 ? 'vak' : 'vakken'} · ${url.length.toLocaleString('nl-NL')} tekens · vormen op ± 10 cm nauwkeurig.`;
    if (url.length > 8000) info += ' Lange link: via mail of WhatsApp werkt hij, maar sommige apps (zoals sms) knippen lange links af.';
    $('#shareInfo').textContent = info;
    $('#shareNative').hidden = !navigator.share;
    shareDialog.showModal();
    $('#shareUrl').select();
  }
  $('#shareFeature').addEventListener('click', () => {
    const f = Store.feature(selectedId);
    if (f) openShare([f], '', `“${f.props.name || 'dit vak'}”`);
  });
  $('#shareProject').addEventListener('click', () => {
    const p = Store.activeProject();
    if (!p) return;
    openShare(Store.features(p.id), p.name, `project “${p.name}”`);
  });
  $('#shareCopy').addEventListener('click', async () => {
    const input = $('#shareUrl');
    try {
      await navigator.clipboard.writeText(input.value);
    } catch (e) {
      input.select();
      document.execCommand && document.execCommand('copy');
    }
    toast('Link gekopieerd');
  });
  $('#shareNative').addEventListener('click', async () => {
    const f = Store.feature(selectedId);
    try {
      await navigator.share({ title: `${shareTitleText} – Kaartdata`, text: `Bekijk ${shareTitleText} op de kaart`, url: $('#shareUrl').value });
    } catch (e) { /* geannuleerd */ }
  });
  $('#shareOpen').addEventListener('click', () => window.open($('#shareUrl').value, '_blank', 'noopener'));

  // ---------------------------------------------------------------- Import / export
  function download(filename, content, type) {
    const blob = new Blob([content], { type });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  const slug = (s) => String(s || 'project').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'project';

  function projectGeoJSON(p) {
    return {
      type: 'FeatureCollection',
      name: p.name,
      metadata: { project: p.name, client: p.client || '', description: p.description || '', exported: new Date().toISOString() },
      features: Store.features(p.id).map(f => {
        const m = measure(f);
        return {
          type: 'Feature',
          id: f.id,
          geometry: f.geometry,
          properties: {
            ...f.props,
            shape: f.shape,
            ...(f.radius ? { radius: f.radius } : {}),
            ...(m.area != null ? { area_m2: Math.round(m.area * 100) / 100 } : {}),
            ...(m.length != null ? { length_m: Math.round(m.length * 100) / 100 } : {}),
          },
        };
      }),
    };
  }

  $('#exportProject').addEventListener('click', () => {
    const p = Store.activeProject();
    if (!p) return toast('Geen project geselecteerd');
    download(`${slug(p.name)}.geojson`, JSON.stringify(projectGeoJSON(p), null, 2), 'application/geo+json');
  });

  $('#exportCsv').addEventListener('click', () => {
    const p = Store.activeProject();
    if (!p) return toast('Geen project geselecteerd');
    const cols = ['naam', 'soort', 'categorie', 'status', 'kenmerk', 'vorm', 'oppervlakte_m2', 'lengte_m', 'lat', 'lon', 'notities'];
    const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const rows = Store.features(p.id).map(f => {
      const m = measure(f);
      let c = ['', ''];
      try { c = turf.centroid(f.geometry).geometry.coordinates; } catch (e) { /* */ }
      return [f.props.name, f.props.kind, f.props.category, f.props.status, f.props.ref, SHAPE_LABEL[f.shape] || f.shape,
        m.area != null ? m.area.toFixed(2) : '', m.length != null ? m.length.toFixed(2) : '',
        c[1] !== '' ? Number(c[1]).toFixed(7) : '', c[0] !== '' ? Number(c[0]).toFixed(7) : '', f.props.notes].map(q).join(';');
    });
    download(`${slug(p.name)}.csv`, '﻿' + [cols.join(';'), ...rows].join('\r\n'), 'text/csv;charset=utf-8');
  });

  function geomShape(g) {
    if (g.type.includes('Polygon')) return 'Polygon';
    if (g.type.includes('LineString')) return 'Line';
    return 'Marker';
  }

  function looksLikeRD(gj) {
    let sample = null;
    turf.coordEach(gj, (c) => { if (!sample) sample = c; });
    return sample && (Math.abs(sample[0]) > 180 || Math.abs(sample[1]) > 90);
  }

  $('#importFile').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    let p = Store.activeProject();
    try {
      let gj = JSON.parse(await file.text());
      if (gj.type !== 'FeatureCollection') gj = gj.type === 'Feature' ? turf.featureCollection([gj]) : turf.featureCollection([turf.feature(gj)]);
      if (looksLikeRD(gj)) { alert('Dit bestand lijkt geen WGS84-coördinaten (graden) te bevatten, bijv. RD New. Exporteer het eerst als WGS84 / EPSG:4326.'); return; }
      if (!p) p = Store.addProject({ name: gj.name || file.name.replace(/\.[^.]+$/, '') });

      let n = 0;
      const add = (feat) => {
        const g = feat.geometry;
        if (!g) return;
        if (g.type === 'GeometryCollection' || g.type === 'MultiPoint') { turf.flatten(feat).features.forEach(add); return; }
        const pr = feat.properties || {};
        const shape = pr.shape && SHAPE_LABEL[pr.shape] ? pr.shape : geomShape(g);
        Store.addFeature({
          projectId: p.id,
          shape: shape === 'Circle' && !pr.radius ? 'Marker' : shape,
          geometry: g,
          ...(pr.radius ? { radius: Number(pr.radius) } : {}),
          props: {
            name: pr.name || pr.naam || pr.Name || pr.NAME || pr.title || `Object ${++n}`,
            kind: pr.kind || pr.soort || (g.type.includes('Polygon') ? 'gebied' : 'asset'),
            category: pr.category || pr.categorie || pr.type || '',
            status: pr.status || 'In beheer',
            ref: pr.ref || pr.kenmerk || pr.id || '',
            notes: pr.notes || pr.notities || pr.description || '',
            ...(pr.fill || pr.opvulling ? { fill: pr.fill || pr.opvulling } : {}),
            color: pr.color || pr.kleur || p.color,
          },
        });
        n++;
      };
      gj.features.forEach(add);
      refreshAll();
      zoomToProject();
      toast(`${n} object(en) geïmporteerd`);
    } catch (err) {
      console.error(err);
      alert('Importeren mislukt: ' + err.message);
    }
  });

  // ---------------------------------------------------------------- Print
  $('#printMap').addEventListener('click', () => window.print());
  window.addEventListener('beforeprint', () => {
    const p = Store.activeProject();
    $('#printTitle').textContent = `${p ? p.name : 'Kaart'} — ${new Date().toLocaleDateString('nl-NL')}`;
    setTimeout(() => map.invalidateSize(), 0);
  });
  window.addEventListener('afterprint', () => map.invalidateSize());

  // ---------------------------------------------------------------- Zoeken adres (PDOK Locatieserver)
  const gcInput = $('#geocodeInput');
  const gcResults = $('#geocodeResults');
  let gcTimer = null;
  let gcCtrl = null;

  // Eigen objecten (alle projecten) die passen bij de zoekterm.
  // Hoofdletters, spaties, streepjes en punten maken niet uit: "up 1234" vindt "UP-1234".
  const normQ = (v) => String(v ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');
  function searchObjects(q) {
    const t = normQ(q);
    if (!t) return [];
    const hits = [];
    Store.state.features.forEach(f => {
      const pr = f.props || {};
      const ref = normQ(pr.ref), name = normQ(pr.name);
      let score = 0;
      if (ref && ref === t) score = 100;
      else if (ref && ref.startsWith(t)) score = 80;
      else if (ref && ref.includes(t)) score = 60;
      else if (name.startsWith(t)) score = 45;
      else if (name.includes(t)) score = 35;
      else if (normQ(pr.category).includes(t)) score = 20;
      else if (normQ(pr.notes).includes(t)) score = 15;
      else if (Object.values(pr).some(v => typeof v === 'string' && normQ(v).includes(t))) score = 10;
      if (score) hits.push({ f, score });
    });
    return hits
      .sort((a, b) => b.score - a.score || String(a.f.props.ref || a.f.props.name).localeCompare(String(b.f.props.ref || b.f.props.name), 'nl', { numeric: true }))
      .slice(0, 10).map(h => h.f);
  }

  // Zoekterm markeren in een tekst (ook als je streepjes/spaties anders typt)
  function highlight(text, q) {
    const raw = String(text ?? '');
    const t = normQ(q);
    if (!t) return esc(raw);
    let normed = '', map = [];
    for (let i = 0; i < raw.length; i++) {
      const c = normQ(raw[i]);
      for (const ch of c) { normed += ch; map.push(i); }
    }
    const at = normed.indexOf(t);
    if (at < 0) return esc(raw);
    const from = map[at], to = map[at + t.length - 1] + 1;
    return esc(raw.slice(0, from)) + '<mark>' + esc(raw.slice(from, to)) + '</mark>' + esc(raw.slice(to));
  }

  function objectResultsHtml(q) {
    const found = searchObjects(q);
    if (!found.length) return '';
    return '<li class="gc-head">Je objecten</li>' + found.map(f => {
      const proj = Store.project(f.projectId);
      const label = f.props.ref
        ? `<span class="gc-ref mono">${highlight(f.props.ref, q)}</span> ${highlight(f.props.name || '', q)}`
        : highlight(f.props.name || '(naamloos)', q);
      const sub = [f.props.category, f.props.status, proj && proj.id !== Store.state.activeProjectId ? `project ${proj.name}` : ''].filter(Boolean).join(' · ');
      return `<li data-fid="${esc(f.id)}" class="gc-obj" role="option"><span class="gc-icon" style="color:${esc(colorOf(f))}">${icon(SHAPE_ICON[shapeOf(f)])}</span><span class="gc-main"><span>${label}</span>${sub ? `<small>${esc(sub)}</small>` : ''}</span></li>`;
    }).join('');
  }

  const noneHtml = (q) => `<li class="gc-none"><strong>Niets gevonden voor “${esc(q)}”</strong><span>Er wordt gezocht in kenmerk, naam, categorie en notities van je objecten, en in adressen, postcodes en plaatsen.</span></li>`;
  const PLACE_TYPE = { adres: 'Adres', postcode: 'Postcode', weg: 'Straat', woonplaats: 'Plaats', gemeente: 'Gemeente', provincie: 'Provincie', perceel: 'Perceel', buurt: 'Buurt', wijk: 'Wijk' };

  async function geocode(q) {
    gcCtrl?.abort();
    gcCtrl = new AbortController();
    const own = objectResultsHtml(q);
    if (q.length < 3) { gcResults.innerHTML = own || noneHtml(q); return; }
    const url = `https://api.pdok.nl/bzk/locatieserver/search/v3_1/free?rows=6&fl=weergavenaam,centroide_ll,type&q=${encodeURIComponent(q)}`;
    try {
      const res = await fetch(url, { signal: gcCtrl.signal });
      const data = await res.json();
      const docs = data.response?.docs || [];
      const places = docs.length
        ? '<li class="gc-head">Adressen en plaatsen</li>' + docs.map(d =>
            `<li data-ll="${esc(d.centroide_ll)}" data-type="${esc(d.type)}" role="option"><span class="gc-place-icon">${icon('i-point')}</span><span class="gc-main"><span>${highlight(d.weergavenaam, q)}</span><small>${esc(PLACE_TYPE[d.type] || d.type)}</small></span></li>`).join('')
        : '';
      gcResults.innerHTML = (own + places) || noneHtml(q);
    } catch (e) {
      if (e.name !== 'AbortError') gcResults.innerHTML = own || noneHtml(q);
    }
  }

  const gcClear = $('#gcClear');
  function closeResults() { gcResults.innerHTML = ''; }
  gcInput.addEventListener('input', () => {
    clearTimeout(gcTimer);
    const q = gcInput.value.trim();
    gcClear.hidden = !gcInput.value;
    if (!q) { closeResults(); return; }
    const own = objectResultsHtml(q);              // eigen objecten direct tonen
    if (own) gcResults.innerHTML = own;
    gcTimer = setTimeout(() => geocode(q), 250);
  });
  gcInput.addEventListener('focus', () => { if (gcInput.value.trim()) geocode(gcInput.value.trim()); });
  gcClear.addEventListener('click', () => {
    gcInput.value = '';
    gcClear.hidden = true;
    closeResults();
    gcInput.focus();
  });
  $('#geocoder').addEventListener('submit', (e) => {
    e.preventDefault();
    gcResults.querySelector('li[data-fid], li[data-ll]')?.click();
  });
  gcResults.addEventListener('click', (e) => {
    const obj = e.target.closest('li[data-fid]');
    if (obj) {
      const f = Store.feature(obj.dataset.fid);
      closeResults();
      gcInput.blur();
      if (!f) return;
      stopPick(); stopDrawing(); stopEditing();
      if (f.projectId !== Store.state.activeProjectId) {
        Store.setActive(f.projectId);
        refreshAll();
      }
      if (isMobile()) closeSidebar();
      select(f.id);
      zoomTo(f.id);
      return;
    }
    const li = e.target.closest('li[data-ll]');
    if (!li) return;
    const m = /POINT\(([-\d.]+) ([-\d.]+)\)/.exec(li.dataset.ll);
    if (m) {
      const zoom = { adres: 19, postcode: 18, weg: 17, woonplaats: 13, gemeente: 12, provincie: 9 }[li.dataset.type] || 16;
      map.setView([+m[2], +m[1]], zoom);
    }
    gcResults.innerHTML = '';
    gcInput.blur();
  });
  document.addEventListener('click', (e) => { if (!e.target.closest('#geocoder, #geocodeResults')) closeResults(); });

  // ---------------------------------------------------------------- Labels & zijbalk
  const LabelControl = L.Control.extend({
    options: { position: 'topright' },
    onAdd() {
      const div = L.DomUtil.create('div', 'leaflet-bar leaflet-control label-ctl');
      div.innerHTML = '<a href="#" title="Labels tonen/verbergen" role="button">Labels</a>';
      L.DomEvent.disableClickPropagation(div);
      div.firstChild.addEventListener('click', (e) => {
        e.preventDefault();
        showLabels = !showLabels;
        div.firstChild.classList.toggle('off', !showLabels);
        (Store.activeProject() ? Store.features(Store.activeProject().id) : []).forEach(applyStyle);
      });
      return div;
    },
  });
  new LabelControl().addTo(map);

  // Zijbalk: inklappen op desktop, schuiflade op telefoon
  const sidebar = $('#sidebar');
  const backdrop = $('#sidebarBackdrop');
  function openSidebar() {
    if (isMobile()) { sidebar.classList.add('open'); backdrop.classList.add('show'); }
    else { sidebar.classList.remove('collapsed'); document.body.classList.remove('sidebar-collapsed'); setTimeout(() => map.invalidateSize(), 250); }
  }
  function closeSidebar() {
    if (isMobile()) { sidebar.classList.remove('open'); backdrop.classList.remove('show'); }
    else { sidebar.classList.add('collapsed'); document.body.classList.add('sidebar-collapsed'); setTimeout(() => map.invalidateSize(), 250); }
  }
  $('#toggleSidebar').addEventListener('click', closeSidebar);
  $('#openSidebar').addEventListener('click', openSidebar);
  backdrop.addEventListener('click', closeSidebar);

  // ---------------------------------------------------------------- Toast
  let toastTimer;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
  }

  // ---------------------------------------------------------------- Start
  function refreshAll() {
    renderProjects();
    renderLayers();
    renderList();
    renderCategories();
  }

  if (!Store.projects().length) {
    Store.addProject({ name: 'Mijn eerste project', description: 'Teken een polygoon om te beginnen.', color: '#0a6c8f' });
  } else if (!Store.activeProject()) {
    Store.setActive(Store.projects()[0].id);
  }
  refreshAll();

  // Op iOS de pagina zelf niet laten zoomen (alleen de kaart); Leaflet gebruikt touch-events, geen gesture-events
  ['gesturestart', 'gesturechange', 'gestureend'].forEach(t => document.addEventListener(t, (e) => e.preventDefault(), { passive: false }));
  document.addEventListener('touchmove', (e) => { if (e.touches.length > 1 && !e.target.closest('#map')) e.preventDefault(); }, { passive: false });

  // Offline beschikbaar / installeerbaar als app
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }

  // Handig voor debuggen in de console
  window.Kaartdata = { map, Store, select };
})();
