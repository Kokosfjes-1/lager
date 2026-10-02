const { app } = require("@azure/functions");
const { odata } = require("@azure/data-tables");
const { hentTabell, vask, vaskKode, omvendtNokkel, svar, beskyttet } = require("../shared");

const TABELL = "Bevegelser";
const RETNINGER = ["inn", "ut"];

function tilRad(e) {
  return {
    id: e.rowKey,
    retning: e.partitionKey,
    kode: e.Kode,
    navn: e.Navn,
    kommentar: e.Kommentar || "",
    lokasjon: e.Lokasjon || "",
    lokasjonKode: e.LokasjonKode || "",
    registrertAv: e.RegistrertAv || "",
    tidspunkt: e.Tidspunkt,
  };
}

// Sjekker om et søkeord finnes i et av tekstfeltene (store/små bokstaver spiller ingen rolle).
function treff(e, sok) {
  return [e.Kode, e.Navn, e.Kommentar, e.Lokasjon, e.LokasjonKode, e.RegistrertAv]
    .some((felt) => String(felt || "").toLowerCase().includes(sok));
}

// GET /api/bevegelser?retning=inn&top=100&q=hdmi
// Table Storage kan ikke søke i deler av tekst, så vi leser radene og filtrerer selv.
app.http("bevegelserListe", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "bevegelser",
  handler: beskyttet(async (request) => {
    const retning = request.query.get("retning");
    if (!RETNINGER.includes(retning)) return svar(400, { feil: "Retning må være inn eller ut" });
    const top = Math.min(Math.max(parseInt(request.query.get("top"), 10) || 100, 1), 500);
    const sok = vask(request.query.get("q"), 100).toLowerCase();

    const tabell = await hentTabell(TABELL);
    const rader = [];
    const liste = tabell.listEntities({ queryOptions: { filter: odata`PartitionKey eq ${retning}` } });
    for await (const e of liste) {
      if (sok && !treff(e, sok)) continue;
      rader.push(tilRad(e));
      if (rader.length >= top) break;
    }
    return svar(200, rader);
  }),
});

// POST /api/bevegelser  { retning, kode, navn, kommentar, lokasjonKode, lokasjon }
app.http("bevegelserNy", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "bevegelser",
  handler: beskyttet(async (request, context, bruker) => {
    let body;
    try {
      body = await request.json();
    } catch {
      return svar(400, { feil: "Ugyldig forespørsel" });
    }

    const retning = body.retning;
    const kode = vask(body.kode, 200);
    const navn = vask(body.navn, 100);
    const lokasjonKode = vaskKode(body.lokasjonKode);
    if (!RETNINGER.includes(retning)) return svar(400, { feil: "Retning må være inn eller ut" });
    if (!kode) return svar(400, { feil: "Strekkode eller tekst mangler" });
    if (!navn) return svar(400, { feil: "Fyll inn navn før du skanner" });
    if (!lokasjonKode) return svar(400, { feil: "Velg lokasjon før du skanner" });

    const entitet = {
      partitionKey: retning,
      rowKey: omvendtNokkel(),
      Kode: kode,
      Navn: navn,
      Kommentar: vask(body.kommentar, 500),
      LokasjonKode: lokasjonKode,
      Lokasjon: vask(body.lokasjon, 100) || lokasjonKode,
      RegistrertAv: bruker.userDetails || "",
      Tidspunkt: new Date().toISOString(),
    };

    const tabell = await hentTabell(TABELL);
    await tabell.createEntity(entitet);
    return svar(201, tilRad(entitet));
  }),
});
