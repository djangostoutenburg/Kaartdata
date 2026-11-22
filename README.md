# Kaartdata

Eenvoudige webtool om kaarten te maken voor **projecten** en **assets**: teken polygonen, lijnen, punten, rechthoeken en cirkels op een kaart van Nederland, geef ze eigenschappen en exporteer ze.

## Starten

Online: **https://djangostoutenburg.github.io/Kaartdata/**


Geen installatie of server nodig: open `index.html` in je browser.
Je kunt de map ook hosten via GitHub Pages (Settings → Pages → branch kiezen) zodat je hem online kunt gebruiken.

## Functies

- **Projecten** – meerdere projecten met naam, opdrachtgever, omschrijving en eigen kleur.
- **Tekenen** – polygoon, rechthoek, lijn (kabel/leiding/route), punt (asset) en cirkel.
- **Groen selecteren uit de kaart** – in de modus *Selecteer* licht al het groen uit de BGT op: grasvelden, plantsoenen, beplanting, groene bermen, hagen en bomen (vanaf straatniveau ingezoomd). Tik op vlakken, hagen en bomen om ze te selecteren (nog eens tikken haalt ze weg) en neem ze in één keer over: los, of met *Samenvoegen* als één groengebied. Andere objecten (gebouwen, wegen, water, percelen) zijn niet selecteerbaar.
- **Bewerken** – hoekpunten verplaatsen, slepen, roteren, uitsnijden (gat/knippen) en verwijderen via de knoppen links op de kaart, of “Vorm bewerken” in het objectpaneel. Snappen aan bestaande objecten staat aan.
- **Eigenschappen per object** – naam, soort (gebied of asset), categorie, status, kenmerk/ID, notities en kleur.
- **Metingen** – oppervlakte (m²/ha), omtrek en lengte worden automatisch berekend.
- **Achtergronden** – PDOK Standaard, Grijs, Pastel, Luchtfoto en OpenStreetMap, plus kadastrale percelen als overlay (inzoomen tot ±niveau 16).
- **Zoeken** – in de zoekbalk bovenaan op kenmerk of naam van je eigen objecten (in alle projecten; hoofdletters, spaties en streepjes maken niet uit, dus `gr201` vindt `GR-201`) en op adres, postcode of plaats via de PDOK Locatieserver.
- **Zoeken & filteren** in de objectenlijst.
- **Delen als kijklink** – met *Delen* in het objectpaneel maak je een link naar één vak van maximaal 255 tekens. Wie hem opent, ziet alleen de kaart met dat vak (naam, kenmerk, oppervlakte, route) en kan niets wijzigen. Er wordt niets online opgeslagen: een ongewijzigd BGT-vak gaat mee als BGT-nummer (de exacte vorm wordt bij PDOK opgehaald), andere vormen worden zo nodig vereenvoudigd tot de link binnen 255 tekens past.
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
