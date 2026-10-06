const { app } = require("@azure/functions");
const { odata } = require("@azure/data-tables");
const { hentTabell, vask, vaskKode, omvendtNokkel, svar, beskyttet, erAdmin } = require("../shared");

const TABELL = "Bevegelser";
const BEHOLDNING = "Beholdning";
const INNE = "inne";
const RETNINGER = ["inn", "ut"];
const ANGRE_MINUTTER = 15;
const ID_MONSTER = /^\d{13}-[0-9a-f]{8}$/;
const MAKS_TOP = 5000;

// Strekkoder kan inneholde tegn som ikke er lov i RowKey, så de kodes som base64url.
function beholdningsnokkel(kode) {
  return Buffer.from(kode, "utf8").toString("base64url");
}

// Lager en Beholdning-rad fra en inn-bevegelse (eller en eksisterende Beholdning-rad).
function tilBeholdning(e, bevegelseId) {
  return {
    partitionKey: INNE,
    rowKey: beholdningsnokkel(e.Kode),
    BevegelseId: bevegelseId,
    Kode: e.Kode,
    Navn: e.Navn,
    Kommentar: e.Kommentar || "",
    LokasjonKode: e.LokasjonKode || "",
    Lokasjon: e.Lokasjon || "",
    RegistrertAv: e.RegistrertAv || "",
    Tidspunkt: e.Tidspunkt,
  };
}

// Nyeste inn-bevegelse for en kode, eller null. Radene kommer nyeste først.
async function sisteInn(tabell, kode) {
  const rader = tabell.listEntities({
    queryOptions: { filter: odata`PartitionKey eq 'inn' and Kode eq ${kode}` },
  });
  for await (const e of rader) return e;
  return null;
}

// Finnes det en inn- eller ut-bevegelse for koden som er nyere enn id? Lavere RowKey er nyere.
async function harNyereBevegelse(tabell, kode, id) {
  const rader = tabell.listEntities({
    queryOptions: { filter: odata`Kode eq ${kode} and RowKey lt ${id}`, select: ["RowKey"] },
  });
  for await (const _ of rader) return true;
  return false;
}

// Beholdning-tabellen kom etter Bevegelser. Er den tom, bygges den fra historikken
// (varer med flere inn enn ut regnes som inne). Kjøres én gang per oppstart.
let beholdningKlar;
function hentBeholdning() {
  if (!beholdningKlar) {
    beholdningKlar = byggBeholdningVedBehov().catch((e) => {
      beholdningKlar = null;
      throw e;
    });
  }
  return beholdningKlar;
}

async function byggBeholdningVedBehov() {
  const beholdning = await hentTabell(BEHOLDNING);
  for await (const _ of beholdning.listEntities({ queryOptions: { select: ["PartitionKey"] } })) {
    return beholdning;
  }

  const tabell = await hentTabell(TABELL);
  const koder = new Map();
  for await (const e of tabell.listEntities()) {
    const k = koder.get(e.Kode) || { inn: 0, ut: 0, siste: null };
    if (e.partitionKey === "inn") {
      k.inn++;
      if (!k.siste || e.rowKey < k.siste.rowKey) k.siste = e;
    } else if (e.partitionKey === "ut") {
      k.ut++;
    }
    koder.set(e.Kode, k);
  }
  for (const k of koder.values()) {
    if (k.inn > k.ut) await beholdning.upsertEntity(tilBeholdning(k.siste, k.siste.rowKey));
  }
  return beholdning;
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

function beholdningTilRad(e) {
  return { ...tilRad(e), id: e.BevegelseId, retning: "inn" };
}

// Sjekker om et søkeord finnes i et av tekstfeltene (store/små bokstaver spiller ingen rolle).
function treff(e, sok) {
  return [e.Kode, e.Navn, e.Kommentar, e.Lokasjon, e.LokasjonKode, e.RegistrertAv]
    .some((felt) => String(felt || "").toLowerCase().includes(sok));
}

function lesTopOgSok(request) {
  return {
    top: Math.min(Math.max(parseInt(request.query.get("top"), 10) || 100, 1), MAKS_TOP),
    sok: vask(request.query.get("q"), 100).toLowerCase(),
  };
}

// Table Storage kan ikke søke i deler av tekst, så vi leser radene og filtrerer selv.
async function hentBevegelser(retning, sok, top) {
  const tabell = await hentTabell(TABELL);
  const rader = [];
  const liste = tabell.listEntities({ queryOptions: { filter: odata`PartitionKey eq ${retning}` } });
  for await (const e of liste) {
    if (sok && !treff(e, sok)) continue;
    rader.push(tilRad(e));
    if (rader.length >= top) break;
  }
  return rader;
}

// GET /api/bevegelser?retning=ut&top=100&q=hdmi
app.http("bevegelserListe", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "bevegelser",
  handler: beskyttet(async (request) => {
    const retning = request.query.get("retning");
    if (!RETNINGER.includes(retning)) return svar(400, { feil: "Retning må være inn eller ut" });
    const { top, sok } = lesTopOgSok(request);
    return svar(200, await hentBevegelser(retning, sok, top));
  }),
});

// GET /api/beholdning?q=hdmi  –  alt som er på lageret nå, nyeste først.
app.http("beholdningListe", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "beholdning",
  handler: beskyttet(async (request) => {
    const { sok } = lesTopOgSok(request);
    const beholdning = await hentBeholdning();
    const rader = [];
    for await (const e of beholdning.listEntities({ queryOptions: { filter: odata`PartitionKey eq ${INNE}` } })) {
      if (sok && !treff(e, sok)) continue;
      rader.push(beholdningTilRad(e));
    }
    rader.sort((a, b) => a.id.localeCompare(b.id)); // omvendt tidsstempel: nyeste først
    return svar(200, rader);
  }),
});

// GET /api/aktivitet?top=100&q=hdmi  –  all inn og ut, nyeste først. Bare for admin.
app.http("aktivitetListe", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "aktivitet",
  handler: beskyttet(async (request, context, bruker) => {
    if (!erAdmin(bruker)) return svar(403, { feil: "Bare admin kan se all aktivitet" });
    const { top, sok } = lesTopOgSok(request);
    const [inn, ut] = await Promise.all([hentBevegelser("inn", sok, top), hentBevegelser("ut", sok, top)]);
    const rader = [...inn, ...ut].sort((a, b) => a.id.localeCompare(b.id)).slice(0, top);
    return svar(200, rader);
  }),
});

// POST /api/bevegelser  { retning, kode, navn, kommentar, lokasjonKode, lokasjon }
// Inn avvises hvis varen allerede er på lageret, ut avvises hvis den ikke er det.
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
    const beholdning = await hentBeholdning();
    const nokkel = beholdningsnokkel(kode);

    if (retning === "inn") {
      const tidligere = await sisteInn(tabell, kode);
      try {
        await beholdning.createEntity(tilBeholdning(entitet, entitet.rowKey));
      } catch (e) {
        if (e.statusCode !== 409) throw e;
        const inne = await beholdning.getEntity(INNE, nokkel).catch(() => null);
        const hvor = inne?.Lokasjon ? ` på ${inne.Lokasjon}` : "";
        return svar(409, { feil: `${kode} er allerede på lageret${hvor}. Skann den ut først.`, varsel: "allerede_inne" });
      }
      try {
        await tabell.createEntity(entitet);
      } catch (e) {
        await beholdning.deleteEntity(INNE, nokkel).catch(() => {});
        throw e;
      }
      return svar(201, { ...tilRad(entitet), varsel: tidligere ? null : "ny" });
    }

    // Ut: fjern fra beholdningen. Etag sørger for at to samtidige utskanninger ikke begge går gjennom.
    let inne;
    try {
      inne = await beholdning.getEntity(INNE, nokkel);
      await beholdning.deleteEntity(INNE, nokkel, { etag: inne.etag });
    } catch (e) {
      if (e.statusCode !== 404 && e.statusCode !== 412) throw e;
      return svar(409, { feil: `${kode} er ikke på lageret, så den kan ikke skannes ut.`, varsel: "ikke_inne" });
    }
    try {
      await tabell.createEntity(entitet);
    } catch (e) {
      await beholdning.upsertEntity(tilBeholdning(inne, inne.BevegelseId)).catch(() => {});
      throw e;
    }
    return svar(201, { ...tilRad(entitet), varsel: null });
  }),
});

// DELETE /api/bevegelser/{retning}/{id}
// Brukes av Angre-knappen: bare egne registreringer, og bare de siste minuttene.
// Admin kan slette hvilken som helst registrering. Beholdningen rettes bare når
// registreringen er den siste for varen; eldre registreringer fjernes bare fra historikken.
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

    const admin = erAdmin(bruker);
    if (!admin && entitet.RegistrertAv !== bruker.userDetails) {
      return svar(403, { feil: "Du kan bare angre dine egne registreringer" });
    }
    const alderMinutter = (Date.now() - new Date(entitet.Tidspunkt).getTime()) / 60000;
    if (!admin && alderMinutter > ANGRE_MINUTTER) {
      return svar(403, { feil: `Kan bare angre de siste ${ANGRE_MINUTTER} minuttene` });
    }

    const beholdning = await hentBeholdning();
    const nokkel = beholdningsnokkel(entitet.Kode);

    if (retning === "inn") {
      // Varen må fortsatt være inne fra akkurat denne registreringen.
      const inne = await beholdning.getEntity(INNE, nokkel).catch((e) => {
        if (e.statusCode === 404) return null;
        throw e;
      });
      if (inne && inne.BevegelseId === id) {
        await beholdning.deleteEntity(INNE, nokkel, { etag: inne.etag });
      } else if (!admin) {
        return svar(409, { feil: `${entitet.Kode} er skannet ut etterpå. Angre utskanningen først.` });
      }
    } else if (await harNyereBevegelse(tabell, entitet.Kode, id)) {
      if (!admin) {
        return svar(409, { feil: `${entitet.Kode} er skannet inn igjen etterpå, så utskanningen kan ikke angres.` });
      }
    } else {
      // Legg varen tilbake på lageret slik den ble registrert inn sist.
      const forrige = await sisteInn(tabell, entitet.Kode);
      if (forrige) {
        try {
          await beholdning.createEntity(tilBeholdning(forrige, forrige.rowKey));
        } catch (e) {
          if (e.statusCode !== 409) throw e;
          return svar(409, { feil: `${entitet.Kode} er skannet inn igjen etterpå, så utskanningen kan ikke angres.` });
        }
      }
    }

    await tabell.deleteEntity(retning, id);
    return svar(204);
  }),
});

module.exports = { hentBeholdning };
