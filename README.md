# Lagersystem – lager.vebjorn.world

Første versjon: skann varer inn og ut med navn, kommentar og lokasjon.
Frontend i `public/`, API (Azure Functions, Node 20) i `api/`, data i Azure Table Storage.

## Mappestruktur

```
public/
  index.html               hovedsiden
  app.js                   skanning, lister og lokasjoner
  style.css
  hyllekoder.html          utskrift av strekkoder for hyller og inn/ut
  ingen-tilgang.html       vises for innloggede uten rolle
  jsbarcode.min.js         strekkodebibliotek (lokal kopi)
  staticwebapp.config.json innlogging og tilgangsregler
api/
  src/shared.js            tabeller, tilgangssjekk, validering
  src/functions/bevegelser.js
  src/functions/lokasjoner.js
```

## Tabeller (opprettes automatisk)

**Bevegelser**: PartitionKey = `inn` eller `ut`, RowKey = omvendt tidsstempel (nyeste først).
Felter: Kode, Navn, Kommentar, LokasjonKode, Lokasjon, RegistrertAv (innlogget konto), Tidspunkt.

**Lokasjoner**: PartitionKey = `lokasjon`, RowKey = kode (f.eks. `A3`). Felt: Navn.

## Sette opp i Azure

1. **Storage Account**: bruk den du har fra invite, eller lag en ny. Kopier
   connection string fra *Security + networking → Access keys*.
2. **GitHub**: legg prosjektet i et eget repo.
3. **Static Web App**: *Create → Static Web App*, plan **Free**, koble til repoet.
   Build details: preset **Custom**, App location `public`, Api location `api`,
   Output location tom. Azure lager GitHub Actions-workflowen selv.
4. **Miljøvariabel**: i Static Web App → *Settings → Environment variables*, legg til
   `TABLES_CONNECTION_STRING` med connection string fra steg 1.
5. **Domene**: *Custom domains → Add*, skriv `lager.vebjorn.world`.
   I Namecheap → Advanced DNS: CNAME Record, Host `lager`,
   Value = standardadressen til appen (`xxxx.azurestaticapps.net`). Vent til Azure validerer.

## Gi folk tilgang

Alle sider og hele API-et krever rollen `lagerbruker`.

1. Static Web App → *Settings → Role management → Invite*.
2. Provider: **Microsoft Entra ID**, domene `lager.vebjorn.world`,
   e-postadressen de logger inn med, rolle `lagerbruker`.
3. Send lenken til personen. Når de åpner den og logger inn, har de tilgang.

Inviter deg selv først. Uten rolle får man siden «Du har ikke tilgang».
GitHub-innlogging er skrudd av i `staticwebapp.config.json`.

## Første gangs bruk

1. Åpne *Lokasjoner* nederst og legg til hyller (kode `A3`, navn `Hylle A3`).
2. Åpne *Skriv ut hyllekoder* og heng etikettene opp.
3. Fyll inn navn og kommentar, velg lokasjon, velg Inn eller Ut, og skann.

Spesialkoder skanneren forstår:

- `LOK-A3` bytter lokasjon til A3
- `MODUS-INN` / `MODUS-UT` bytter retning

**Skanneren** må sende Enter etter hver kode (standard på de fleste).
Sett den gjerne til norsk tastaturoppsett. Systemet godtar `LOK+A3` i stedet for
`LOK-A3`, siden en skanner på amerikansk oppsett ofte sender `+` for `-` på norsk PC.

## Teste lokalt

```bash
npm install -g @azure/static-web-apps-cli azure-functions-core-tools@4 azurite
azurite-table --inMemoryPersistence &        # lokal Table Storage
cd api && cp local.settings.example.json local.settings.json && npm install && cd ..
swa start public --api-location api
```

Åpne http://localhost:4280. Ved den falske innloggingen: skriv inn en e-post og
legg til `lagerbruker` i feltet for roller.

## Ikke med i versjon 1

Slette eller rette feilskanninger, antallsfelt, varelinjer med navn på strekkoder,
beholdning, serienummer, retur, bestillinger og varsler.
