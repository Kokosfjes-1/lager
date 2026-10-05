const { app } = require("@azure/functions");
const { hentTabell, vask, vaskKode, svar, beskyttet } = require("../shared");

const TABELL = "Lokasjoner";
const PARTISJON = "lokasjon";

// GET /api/lokasjoner
app.http("lokasjonerListe", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "lokasjoner",
  handler: beskyttet(async () => {
    const tabell = await hentTabell(TABELL);
    const rader = [];
    for await (const e of tabell.listEntities()) {
      rader.push({ kode: e.rowKey, navn: e.Navn || e.rowKey });
    }
    rader.sort((a, b) => a.kode.localeCompare(b.kode, "nb", { numeric: true }));
    return svar(200, rader);
  }),
});

// POST /api/lokasjoner  { kode, navn }
app.http("lokasjonerNy", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "lokasjoner",
  handler: beskyttet(async (request) => {
    let body;
    try {
      body = await request.json();
    } catch {
      return svar(400, { feil: "Ugyldig forespørsel" });
    }
    const kode = vaskKode(body.kode);
    if (!kode) return svar(400, { feil: "Koden kan bare inneholde bokstaver A–Z, tall og bindestrek" });
    const navn = vask(body.navn, 100) || kode;

    const tabell = await hentTabell(TABELL);
    try {
      await tabell.createEntity({ partitionKey: PARTISJON, rowKey: kode, Navn: navn });
    } catch (e) {
      if (e.statusCode === 409) return svar(409, { feil: `Lokasjonen ${kode} finnes allerede` });
      throw e;
    }
    return svar(201, { kode, navn });
  }),
});

// DELETE /api/lokasjoner/{kode}
app.http("lokasjonerSlett", {
  methods: ["DELETE"],
  authLevel: "anonymous",
  route: "lokasjoner/{kode}",
  handler: beskyttet(async (request) => {
    const kode = vaskKode(request.params.kode);
    const tabell = await hentTabell(TABELL);
    try {
      await tabell.deleteEntity(PARTISJON, kode);
    } catch (e) {
      if (e.statusCode !== 404) throw e;
    }
    return svar(204);
  }),
});
