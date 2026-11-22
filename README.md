# Kaartdata

Eenvoudige webtool om kaarten te maken voor **projecten** en **assets**: teken polygonen, lijnen, punten, rechthoeken en cirkels op een kaart van Nederland, geef ze eigenschappen en exporteer ze.

## Starten

Online: **https://djangostoutenburg.github.io/Kaartdata/**


Geen installatie of server nodig: open `index.html` in je browser.
Je kunt de map ook hosten via GitHub Pages (Settings → Pages → branch kiezen) zodat je hem online kunt gebruiken.

## Functies

- **Projecten** – meerdere projecten met naam, opdrachtgever, omschrijving en eigen kleur.
- **Tekenen** – polygoon, rechthoek, lijn (kabel/leiding/route), punt (asset) en cirkel.
- **Selecteren uit de kaart** – tik op een grasveld, plantsoen, pad, weg, berm, water, gebouw of perceel en neem het exacte vlak over uit de BGT (Basisregistratie Grootschalige Topografie) of het Kadaster. Liggen er meerdere vlakken op dezelfde plek, dan blader je met *Andere* (eerst het kleinste, bijvoorbeeld het grasveld, daarna het perceel). Je kunt meerdere vlakken achter elkaar aantikken (nog eens tikken haalt een vlak weg) en ze daarna in één keer overnemen: als losse objecten, of met *Samenvoegen* als één gebied.
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

## Op je telefoon

- **Als app installeren:** open de link in Safari (iPhone) of Chrome (Android) en kies *Deel → Zet op beginscherm*. De tool opent dan schermvullend, als een gewone app.
- **Tekenen met je vinger:** tik op een gereedschap in de balk onderin. Tijdens het tekenen heb je de knoppen *Ongedaan*, *GPS-punt*, *Klaar* en *Stop*.
- **GPS:** met de locatieknop rechts zie je waar je staat. Met *GPS-punt* plaats je een asset of hoekpunt precies op je huidige locatie, handig om in het veld een terrein af te lopen.
- **Vorm aanpassen:** open een object en tik op *Vorm*. Sleep de hoekpunten; houd een hoekpunt vast om het te verwijderen.

## Structuur

```
index.html       opbouw van de pagina
css/style.css    opmaak (ook donkere modus, mobiel en print)
js/store.js      opslag van projecten en objecten
js/app.js        kaart, tekenen, panelen, import/export
vendor/          Leaflet 1.9.4, Leaflet-Geoman 2.17.0, Turf 7.1.0 (MIT-licenties)
```
