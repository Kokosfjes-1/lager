const { app } = require("@azure/functions");
const { odata } = require("@azure/data-tables");
const { hentTabell, vask, vaskKode, svar, beskyttet, erAdmin } = require("../shared");
const { hentBeholdning } = require("./bevegelser");

const TABELL = "Lokasjoner";
const PARTISJON = "lokasjon";
const VIS_KODER = 3;

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

// Strekkodene til varene som er inne på en lokasjon.
async function varerInne(lokasjonKode) {
  const beholdning = await hentBeholdning();
  const koder = [];
  const rader = beholdning.listEntities({
    queryOptions: { filter: odata`PartitionKey eq 'inne' and LokasjonKode eq ${lokasjonKode}`, select: ["Kode"] },
  });
  for await (const e of rader) koder.push(e.Kode);
  return koder;
}

// DELETE /api/lokasjoner/{kode}  –  bare admin, og bare når lokasjonen er tom.
app.http("lokasjonerSlett", {
  methods: ["DELETE"],
  authLevel: "anonymous",
  route: "lokasjoner/{kode}",
  handler: beskyttet(async (request, context, bruker) => {
    if (!erAdmin(bruker)) return svar(403, { feil: "Bare admin kan fjerne lokasjoner" });
    const kode = vaskKode(request.params.kode);

    const inne = await varerInne(kode);
    if (inne.length) {
      const eksempler = inne.slice(0, VIS_KODER).join(", ") + (inne.length > VIS_KODER ? ", …" : "");
      const antall = inne.length === 1 ? "1 vare" : `${inne.length} varer`;
      return svar(409, { feil: `${kode} har ${antall} inne (${eksempler}). Skann dem ut før du fjerner lokasjonen.` });
    }

    const tabell = await hentTabell(TABELL);
    try {
      await tabell.deleteEntity(PARTISJON, kode);
    } catch (e) {
      if (e.statusCode !== 404) throw e;
    }
    return svar(204);
  }),
});
