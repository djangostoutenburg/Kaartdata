/* Kaartdata – kaarten maken voor projecten en assets. */
(function () {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const DEFAULT_CATEGORIES = [
    'Projectgebied', 'Perceel', 'Bouwvlak', 'Werkterrein', 'Gebouw', 'Groen', 'Verharding', 'Water',
    'Kabel', 'Leiding', 'Riolering', 'Weg', 'Route', 'Hek',
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

  // ---------------------------------------------------------------- Kaart
  const map = L.map('map', { zoomControl: true, doubleClickZoom: false }).setView([52.1, 5.3], 8);

  const pdok = (layer) => L.tileLayer(
    `https://service.pdok.nl/brt/achtergrondkaart/wmts/v2_0/${layer}/EPSG:3857/{z}/{x}/{y}.png`,
    { maxZoom: 19, maxNativeZoom: 19, attribution: 'Kaartgegevens &copy; <a href="https://www.kadaster.nl">Kadaster</a> / PDOK' });

  const baseLayers = {
    'PDOK Standaard': pdok('standaard'),
    'PDOK Grijs': pdok('grijs'),
    'PDOK Pastel': pdok('pastel'),
    'Luchtfoto (PDOK)': L.tileLayer(
      'https://service.pdok.nl/hwh/luchtfotorgb/wmts/v1_0/Actueel_orthoHR/EPSG:3857/{z}/{x}/{y}.jpeg',
      { maxZoom: 21, maxNativeZoom: 19, attribution: 'Luchtfoto &copy; Beeldmateriaal.nl / PDOK' }),
    'OpenStreetMap': L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
      { maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' }),
  };
  const overlays = {
    'Kadastrale percelen': L.tileLayer.wms('https://service.pdok.nl/kadaster/kadastralekaart/wms/v5_0', {
      layers: 'Kadastralekaart', format: 'image/png', transparent: true, minZoom: 16, maxZoom: 21,
      attribution: 'Kadastrale kaart &copy; Kadaster',
    }),
  };

  const savedBase = Store.state.baseLayer && baseLayers[Store.state.baseLayer] ? Store.state.baseLayer : 'PDOK Standaard';
  baseLayers[savedBase].addTo(map);
  L.control.layers(baseLayers, overlays, { position: 'topright' }).addTo(map);
  L.control.scale({ imperial: false, position: 'bottomright' }).addTo(map);
  map.on('baselayerchange', (e) => { Store.state.baseLayer = e.name; Store.save(); });

  if (Store.state.view) map.setView(Store.state.view.center, Store.state.view.zoom);
  map.on('moveend', () => {
    Store.state.view = { center: map.getCenter(), zoom: map.getZoom() };
    Store.save();
  });

  // Geoman: alleen de bewerk-knoppen op de kaart; tekenen gaat via de zijbalk.
  map.pm.setLang('nl');
  map.pm.addControls({
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

  function styleFor(f, selected) {
    const color = colorOf(f);
    const isLine = f.geometry.type.includes('LineString');
    return {
      color,
      weight: selected ? 5 : (isLine ? 4 : 2),
      opacity: 1,
      fillColor: color,
      fillOpacity: f.props.kind === 'asset' ? 0.45 : 0.2,
      dashArray: f.props.status === 'Gepland' && !isLine ? '6 4' : null,
    };
  }

  function applyStyle(f) {
    const layer = featureLayers.get(f.id);
    if (!layer) return;
    const selected = f.id === selectedId;
    if (layer instanceof L.Marker) layer.setIcon(pinIcon(colorOf(f), selected));
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
      return L.marker([lat, lng], { icon: pinIcon(colorOf(f)) });
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
    if (picking) { pickAt(e.latlng); return; }
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
    $('#pickNext').hidden = !picking || !pickLast || pickLast.candidates.length < 2;
    $('#pickMerge').hidden = !picking || pickSel.length < 2;
    $('#pickMerge').classList.toggle('on', pickMerge);
    $('#pickAccept').hidden = !picking || !pickSel.length;
    if (picking && pickLast && pickLast.candidates.length > 1) $('#pickNext').querySelector('span').textContent = `Andere (${pickLast.index + 1}/${pickLast.candidates.length})`;
    if (picking) $('#pickAccept').querySelector('span').textContent = pickSel.length > 1 && !isMobile() ? `Overnemen (${pickSel.length})` : 'Overnemen';
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

  // ---------------------------------------------------------------- Selecteren uit kaart (PDOK: BGT + Kadaster)
  const BGT = 'https://api.pdok.nl/lv/bgt/ogc/v1/collections';
  const BRK = 'https://api.pdok.nl/kadaster/brk-kadastrale-kaart/ogc/v1/collections';
  const cap = (t) => t ? t.charAt(0).toUpperCase() + t.slice(1) : '';
  const COLORS = { groen: '#3f8f3a', water: '#2f6fd6', weg: '#5b6778', gebouw: '#b4572b', perceel: '#6a4fc2' };

  // Per bron: hoe we het vlak benoemen en indelen
  const PICK_SOURCES = [
    { id: 'begroeidterreindeel', url: `${BGT}/begroeidterreindeel/items`, describe: (p) => {
        const t = p.plus_fysiek_voorkomen || p.fysiek_voorkomen;
        return { name: cap(t) || 'Begroeid terrein', category: 'Groen', color: COLORS.groen, kind: 'gebied', source: 'BGT begroeid terreindeel' };
      } },
    { id: 'onbegroeidterreindeel', url: `${BGT}/onbegroeidterreindeel/items`, describe: (p) => {
        const t = p.plus_fysiek_voorkomen || p.fysiek_voorkomen;
        return { name: cap(t) || 'Onbegroeid terrein', category: p.fysiek_voorkomen === 'erf' ? 'Erf' : 'Verharding', color: COLORS.weg, kind: 'gebied', source: 'BGT onbegroeid terreindeel' };
      } },
    { id: 'wegdeel', url: `${BGT}/wegdeel/items`, describe: (p) => ({
        name: cap(p.plus_functie || p.functie) || 'Wegdeel', category: 'Weg', color: COLORS.weg, kind: 'gebied',
        extra: [p.fysiek_voorkomen, p.plus_fysiek_voorkomen].filter(Boolean).join(', '), source: 'BGT wegdeel' }) },
    { id: 'ondersteunendwegdeel', url: `${BGT}/ondersteunendwegdeel/items`, describe: (p) => {
        const groen = /groen|gras|begroeid/.test(`${p.fysiek_voorkomen} ${p.plus_fysiek_voorkomen}`);
        return { name: cap(p.plus_functie || p.functie) || 'Ondersteunend wegdeel', category: groen ? 'Groen' : 'Weg', color: groen ? COLORS.groen : COLORS.weg, kind: 'gebied',
          extra: [p.fysiek_voorkomen, p.plus_fysiek_voorkomen].filter(Boolean).join(', '), source: 'BGT ondersteunend wegdeel' };
      } },
    { id: 'waterdeel', url: `${BGT}/waterdeel/items`, describe: (p) => ({
        name: cap(p.plus_type || p.type) || 'Water', category: 'Water', color: COLORS.water, kind: 'gebied', source: 'BGT waterdeel' }) },
    { id: 'ondersteunendwaterdeel', url: `${BGT}/ondersteunendwaterdeel/items`, describe: (p) => ({
        name: cap(p.plus_type || p.type) || 'Oever', category: 'Water', color: COLORS.water, kind: 'gebied', source: 'BGT ondersteunend waterdeel' }) },
    { id: 'pand', url: `${BGT}/pand/items`, describe: (p) => ({
        name: 'Gebouw', category: 'Gebouw', color: COLORS.gebouw, kind: 'asset',
        ref: p.bag_pnd ? `BAG ${p.bag_pnd}` : '', source: 'BGT pand' }) },
    { id: 'overbruggingsdeel', url: `${BGT}/overbruggingsdeel/items`, describe: (p) => ({
        name: 'Brug', category: 'Kunstwerk', color: COLORS.weg, kind: 'asset', source: 'BGT overbruggingsdeel' }) },
    { id: 'perceel', url: `${BRK}/perceel/items`, describe: (p) => {
        const code = [p.kadastrale_gemeente_waarde, p.sectie, p.perceelnummer].filter(v => v != null && v !== '').join(' ');
        return { name: `Perceel ${code}`.trim(), category: 'Perceel', color: COLORS.perceel, kind: 'gebied', ref: code,
          extra: p.kadastrale_grootte_waarde ? `kadastrale grootte ${nf(p.kadastrale_grootte_waarde)} m²` : '', source: 'Kadaster (BRK)' };
      }, current: (p) => !p.status_historie_waarde || p.status_historie_waarde === 'Geldig' },
  ];

  // Meerdere vlakken selecteren: elke tik voegt een vlak toe aan de selectie,
  // opnieuw tikken op een geselecteerd vlak haalt het weer weg.
  let picking = false;
  let pickSel = [];          // [{ candidates, index, layer }]
  let pickLast = null;       // laatst toegevoegde (voor "Andere")
  let pickMerge = false;     // samenvoegen tot één vlak bij overnemen
  let pickPending = 0;
  let pickCtrl = null;
  let pickMsg = '';
  const pickButtons = document.querySelectorAll('[data-pick]');
  const candOf = (e) => e.candidates[e.index];

  function startPick() {
    if (!Store.activeProject()) { toast('Maak eerst een project aan'); return; }
    stopDrawing();
    stopEditing();
    closePanel();
    picking = true;
    pickSel = [];
    pickLast = null;
    pickMsg = '';
    pickCtrl = new AbortController();
    pickButtons.forEach(b => b.classList.add('active'));
    hint.hidden = false;
    document.body.classList.add('drawing');
    renderPickStatus();
    if (map.getZoom() < 16) toast('Zoom ver genoeg in om een vlak precies te kiezen');
  }

  function stopPick() {
    if (!picking) return;
    picking = false;
    pickCtrl?.abort();
    pickSel.forEach(e => e.layer.remove());
    pickSel = [];
    pickLast = null;
    pickPending = 0;
    pickButtons.forEach(b => b.classList.remove('active'));
    hint.classList.remove('loading');
    setDrawButton(null);
  }

  pickButtons.forEach(b => b.addEventListener('click', () => { if (picking) stopPick(); else startPick(); }));

  function renderPickStatus() {
    hint.classList.toggle('loading', pickPending > 0);
    const verb = isMobile() ? 'Tik' : 'Klik';
    let html;
    if (pickPending > 0 && !pickSel.length) {
      html = 'Vlakken zoeken';
    } else if (!pickSel.length) {
      html = pickMsg || `${verb} op grasvelden, paden, gebouwen, water of percelen<small>Je kunt meerdere vlakken achter elkaar kiezen</small>`;
    } else {
      const area = pickSel.reduce((t, e) => t + candOf(e).area, 0);
      const [v, u] = areaParts(area);
      const n = pickSel.length;
      const last = pickLast ? candOf(pickLast) : null;
      const sub = pickMsg || (last ? `Laatste: ${last.info.name} · ${last.info.source}` : `${verb} opnieuw op een vlak om het weg te halen`);
      html = `<strong>${n} ${n === 1 ? 'vlak' : 'vlakken'}</strong> · ${v} ${u}<small>${esc(sub)}</small>`;
    }
    $('#drawHintText').innerHTML = html;
    updateHintButtons();
  }

  function selStyle(c, latest) {
    return { color: c.info.color, weight: latest ? 3.5 : 2.5, fillColor: c.info.color, fillOpacity: 0.4, dashArray: latest ? '6 4' : null };
  }
  function restyleSelection() {
    pickSel.forEach(e => e.layer.setStyle(selStyle(candOf(e), e === pickLast)));
  }

  async function fetchSource(src, latlng, signal) {
    const d = 0.00002; // ± 1,5 m rond het getikte punt
    const bbox = [latlng.lng - d, latlng.lat - d, latlng.lng + d, latlng.lat + d].map(v => v.toFixed(7)).join(',');
    const res = await fetch(`${src.url}?f=json&limit=100&bbox=${bbox}`, { signal });
    if (!res.ok) throw new Error(`${src.id}: ${res.status}`);
    const data = await res.json();
    const pt = turf.point([latlng.lng, latlng.lat]);
    return (data.features || [])
      .filter(f => f.geometry && /Polygon/.test(f.geometry.type))
      .filter(f => (src.current ? src.current(f.properties) : f.properties.eind_registratie == null))
      .filter(f => { try { return turf.booleanPointInPolygon(pt, f); } catch (e) { return false; } })
      .map(f => {
        // Eén-delige multipolygonen omzetten naar een gewone polygoon (makkelijker bewerken)
        let geometry = f.geometry;
        if (geometry.type === 'MultiPolygon' && geometry.coordinates.length === 1) {
          geometry = { type: 'Polygon', coordinates: geometry.coordinates[0] };
        }
        const id = f.properties.lokaal_id || f.properties.identificatie_lokaal_id || f.id;
        return { geometry, area: turf.area(geometry), info: src.describe(f.properties), id: `${src.id}:${id}`, srcId: id };
      });
  }

  const selectedIds = (except) => new Set(pickSel.filter(e => e !== except).map(e => candOf(e).id));

  async function pickAt(latlng) {
    // Tik op een vlak dat al geselecteerd is: weghalen
    const pt = turf.point([latlng.lng, latlng.lat]);
    const hit = [...pickSel].reverse().find(e => { try { return turf.booleanPointInPolygon(pt, candOf(e).geometry); } catch (err) { return false; } });
    if (hit) {
      hit.layer.remove();
      pickSel = pickSel.filter(e => e !== hit);
      if (pickLast === hit) pickLast = pickSel[pickSel.length - 1] || null;
      pickMsg = `${candOf(hit).info.name} weggehaald`;
      restyleSelection();
      renderPickStatus();
      pickMsg = '';
      return;
    }

    const signal = pickCtrl.signal;
    pickPending++;
    pickMsg = '';
    renderPickStatus();
    const results = await Promise.allSettled(PICK_SOURCES.map(src => fetchSource(src, latlng, signal)));
    if (signal.aborted || !picking) return;
    pickPending--;
    const failed = results.filter(r => r.status === 'rejected').length;
    // Kleinste vlak eerst: dat is meestal het grasveld/pad waar je op tikte, het perceel komt daarna
    const taken = selectedIds();
    const candidates = results.filter(r => r.status === 'fulfilled').flatMap(r => r.value)
      .filter(c => !taken.has(c.id))
      .sort((a, b) => a.area - b.area);
    if (!candidates.length) {
      pickMsg = failed === PICK_SOURCES.length
        ? 'PDOK is niet bereikbaar. Controleer je internetverbinding.'
        : 'Geen (nieuw) vlak gevonden op deze plek';
      renderPickStatus();
      pickMsg = '';
      return;
    }
    const entry = { candidates, index: 0, layer: null };
    entry.layer = L.geoJSON(candidates[0].geometry, { pmIgnore: true, interactive: false, style: selStyle(candidates[0], true) }).addTo(map);
    pickSel.push(entry);
    pickLast = entry;
    restyleSelection();
    renderPickStatus();
  }

  $('#pickNext').addEventListener('click', () => {
    const e = pickLast;
    if (!e || e.candidates.length < 2) return;
    const taken = selectedIds(e);
    for (let i = 1; i <= e.candidates.length; i++) {
      const j = (e.index + i) % e.candidates.length;
      if (!taken.has(e.candidates[j].id)) { e.index = j; break; }
    }
    e.layer.remove();
    e.layer = L.geoJSON(candOf(e).geometry, { pmIgnore: true, interactive: false, style: selStyle(candOf(e), true) }).addTo(map);
    const b = e.layer.getBounds();
    if (!map.getBounds().contains(b)) {
      map.fitBounds(b, { paddingTopLeft: [40, 80], paddingBottomRight: [40, isMobile() ? 200 : 60], maxZoom: map.getZoom() });
    }
    renderPickStatus();
  });

  $('#pickMerge').addEventListener('click', () => {
    pickMerge = !pickMerge;
    toast(pickMerge ? 'Samenvoegen aan: de vlakken worden één gebied' : 'Samenvoegen uit: elk vlak wordt een los object');
    updateHintButtons();
  });

  function propsFromCandidate(c) {
    const info = c.info;
    return {
      name: info.name,
      kind: info.kind,
      category: info.category,
      ref: info.ref || '',
      color: info.color,
      status: 'In beheer',
      notes: `Overgenomen uit ${info.source}${c.srcId ? ` (id ${c.srcId})` : ''} op ${new Date().toLocaleDateString('nl-NL')}.${info.extra ? `\n${cap(info.extra)}.` : ''}`,
    };
  }

  $('#pickAccept').addEventListener('click', () => {
    const p = Store.activeProject();
    const cands = pickSel.map(candOf);
    if (!p || !cands.length) return;

    // Eén vlak, of samenvoegen tot één gebied
    if (cands.length === 1 || pickMerge) {
      let geometry = cands[0].geometry;
      let props = propsFromCandidate(cands[0]);
      if (cands.length > 1) {
        let merged = null;
        try { merged = turf.union(turf.featureCollection(cands.map(c => turf.feature(c.geometry)))); } catch (err) { merged = null; }
        if (!merged) { toast('Samenvoegen lukte niet; probeer de vlakken los over te nemen'); return; }
        geometry = merged.geometry;
        const same = (k) => cands.every(c => c.info[k] === cands[0].info[k]);
        const date = new Date().toLocaleDateString('nl-NL');
        props = {
          ...props,
          name: same('name') ? cands[0].info.name : `Samengevoegd gebied`,
          category: same('category') ? cands[0].info.category : cands[0].info.category,
          kind: 'gebied',
          ref: '',
          notes: `Samengevoegd uit ${cands.length} vlakken op ${date}:\n` +
            cands.map(c => `- ${c.info.name} (${c.info.source}${c.srcId ? `, id ${c.srcId}` : ''})`).join('\n'),
        };
      }
      const layer = L.GeoJSON.geometryToLayer({ type: 'Feature', geometry, properties: {} });
      stopPick();
      createFromLayer('Polygon', layer, props);
      if (cands.length > 1) toast(`${cands.length} vlakken samengevoegd tot één gebied`);
      return;
    }

    // Meerdere losse objecten
    const created = cands.map(c => {
      const f = Store.addFeature({ projectId: p.id, shape: 'Polygon', geometry: c.geometry, props: propsFromCandidate(c) });
      attachLayer(f);
      return f;
    });
    stopPick();
    renderList();
    renderCategories();
    const b = L.latLngBounds([]);
    created.forEach(f => { const l = featureLayers.get(f.id); if (l?.getBounds) b.extend(l.getBounds()); });
    if (b.isValid() && !map.getBounds().contains(b)) map.fitBounds(b, { padding: [40, 40], maxZoom: map.getZoom() });
    toast(`${created.length} vlakken overgenomen`);
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
      const sub = [f.props.category && esc(f.props.category), st].filter(Boolean).join(' · ');
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
    form.color.value = colorOf(f);
    renderPanelHead(f);
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

  form.addEventListener('submit', (e) => {
    e.preventDefault();
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
      },
    });
    applyStyle(f);
    renderPanelHead(f);
    renderList();
    renderCategories();
    toast('Opgeslagen');
  });
  // Kleur direct tonen tijdens kiezen
  form.color.addEventListener('input', () => {
    const f = Store.feature(selectedId);
    if (!f) return;
    f.props.color = form.color.value;
    applyStyle(f);
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

  async function geocode(q) {
    gcCtrl?.abort();
    gcCtrl = new AbortController();
    const url = `https://api.pdok.nl/bzk/locatieserver/search/v3_1/free?rows=8&fl=weergavenaam,centroide_ll,type&q=${encodeURIComponent(q)}`;
    try {
      const res = await fetch(url, { signal: gcCtrl.signal });
      const data = await res.json();
      const docs = data.response?.docs || [];
      gcResults.innerHTML = docs.length
        ? docs.map(d => `<li data-ll="${esc(d.centroide_ll)}" data-type="${esc(d.type)}"><span>${esc(d.weergavenaam)}</span><span class="gc-type">${esc(d.type)}</span></li>`).join('')
        : '<li>Niets gevonden</li>';
    } catch (e) {
      if (e.name !== 'AbortError') gcResults.innerHTML = '<li>Zoeken niet beschikbaar</li>';
    }
  }

  gcInput.addEventListener('input', () => {
    clearTimeout(gcTimer);
    const q = gcInput.value.trim();
    if (q.length < 3) { gcResults.innerHTML = ''; return; }
    gcTimer = setTimeout(() => geocode(q), 250);
  });
  $('#geocoder').addEventListener('submit', (e) => {
    e.preventDefault();
    gcResults.querySelector('li[data-ll]')?.click();
  });
  gcResults.addEventListener('click', (e) => {
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
  document.addEventListener('click', (e) => { if (!e.target.closest('#geocoder')) gcResults.innerHTML = ''; });

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

  // Offline beschikbaar / installeerbaar als app
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }

  // Handig voor debuggen in de console
  window.Kaartdata = { map, Store, select };
})();
