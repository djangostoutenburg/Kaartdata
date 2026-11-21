# Kaartdata

Eenvoudige webtool om kaarten te maken voor **projecten** en **assets**: teken polygonen, lijnen, punten, rechthoeken en cirkels op een kaart van Nederland, geef ze eigenschappen en exporteer ze.

## Starten

Geen installatie of server nodig: open `index.html` in je browser.
Je kunt de map ook hosten via GitHub Pages (Settings → Pages → branch kiezen) zodat je hem online kunt gebruiken.

## Functies

- **Projecten** – meerdere projecten met naam, opdrachtgever, omschrijving en eigen kleur.
- **Tekenen** – polygoon, rechthoek, lijn (kabel/leiding/route), punt (asset) en cirkel.
- **Bewerken** – hoekpunten verplaatsen, slepen, roteren, uitsnijden (gat/knippen) en verwijderen via de knoppen links op de kaart, of “Vorm bewerken” in het objectpaneel. Snappen aan bestaande objecten staat aan.
- **Eigenschappen per object** – naam, soort (gebied of asset), categorie, status, kenmerk/ID, notities en kleur.
- **Metingen** – oppervlakte (m²/ha), omtrek en lengte worden automatisch berekend.
- **Achtergronden** – PDOK Standaard, Grijs, Pastel, Luchtfoto en OpenStreetMap, plus kadastrale percelen als overlay (inzoomen tot ±niveau 16).
- **Adres zoeken** – via de PDOK Locatieserver.
- **Zoeken & filteren** in de objectenlijst.
- **Export** – GeoJSON (inclusief oppervlakte/lengte) en CSV (opent in Excel); **import** van GeoJSON (WGS84).
- **Print / PDF** – kaart afdrukken of als PDF opslaan (A4 liggend).
- Labels aan/uit met de knop **Aa**.

Alle gegevens worden lokaal in je browser bewaard (localStorage). Maak regelmatig een GeoJSON-export als back-up, of om gegevens naar een andere computer of naar GIS-software (QGIS, ArcGIS) te verplaatsen.

## Structuur

```
index.html       opbouw van de pagina
css/style.css    opmaak (ook donkere modus, mobiel en print)
js/store.js      opslag van projecten en objecten
js/app.js        kaart, tekenen, panelen, import/export
vendor/          Leaflet 1.9.4, Leaflet-Geoman 2.17.0, Turf 7.1.0 (MIT-licenties)
```
