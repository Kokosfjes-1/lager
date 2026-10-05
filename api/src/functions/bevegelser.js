const { app } = require("@azure/functions");
const { odata } = require("@azure/data-tables");
const { hentTabell, vask, vaskKode, omvendtNokkel, svar, beskyttet } = require("../shared");

const TABELL = "Bevegelser";
const RETNINGER = ["inn", "ut"];
const ANGRE_MINUTTER = 15;
const ID_MONSTER = /^\d{13}-[0-9a-f]{8}$/;

// Teller hvor mange ganger en kode er skannet inn og ut.
async function tellKode(tabell, kode) {
  const telling = { inn: 0, ut: 0 };
  const rader = tabell.listEntities({
    queryOptions: { filter: odata`Kode eq ${kode}`, select: ["PartitionKey"] },
  });
  for await (const e of rader) {
    if (e.partitionKey in telling) telling[e.partitionKey]++;
  }
  return telling;
}

// Avgjør om skanningen skal gi et varsel.
function finnVarsel(retning, telling) {
  const paLager = telling.inn - telling.ut;
  if (retning === "ut" && paLager <= 0) return "ikke_inne";
  if (telling.inn + telling.ut === 0) return "ny";
  if (retning === "inn" && paLager > 0) return "allerede_inne";
  return null;
}

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
    const telling = await tellKode(tabell, kode);
    await tabell.createEntity(entitet);

    const paLagerFoer = telling.inn - telling.ut;
    return svar(201, {
      ...tilRad(entitet),
      varsel: finnVarsel(retning, telling),
      paLagerFoer,
      paLagerEtter: paLagerFoer + (retning === "inn" ? 1 : -1),
    });
  }),
});

// DELETE /api/bevegelser/{retning}/{id}
// Brukes av Angre-knappen: bare egne registreringer, og bare de siste minuttene.
app.http("bevegelserAngre", {
  methods: ["DELETE"],
  authLevel: "anonymous",
  route: "bevegelser/{retning}/{id}",
  handler: beskyttet(async (request, context, bruker) => {
    const { retning, id } = request.params;
    if (!RETNINGER.includes(retning) || !ID_MONSTER.test(id)) return svar(400, { feil: "Ugyldig registrering" });

    const tabell = await hentTabell(TABELL);
    let entitet;
    try {
      entitet = await tabell.getEntity(retning, id);
    } catch (e) {
      if (e.statusCode === 404) return svar(404, { feil: "Registreringen finnes ikke, den er kanskje allerede angret" });
      throw e;
    }

    if (entitet.RegistrertAv !== bruker.userDetails) {
      return svar(403, { feil: "Du kan bare angre dine egne registreringer" });
    }
    const alderMinutter = (Date.now() - new Date(entitet.Tidspunkt).getTime()) / 60000;
    if (alderMinutter > ANGRE_MINUTTER) {
      return svar(403, { feil: `Kan bare angre de siste ${ANGRE_MINUTTER} minuttene` });
    }

    await tabell.deleteEntity(retning, id);
    return svar(204);
  }),
});
