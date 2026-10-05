"use strict";

const $ = (id) => document.getElementById(id);
const tilstand = {
  retning: "inn",
  lokasjoner: [],
  rader: { inn: [], ut: [], aktivitet: [] },
  sok: "",
  bruker: "",
  admin: false,
  visAlle: { inn: false, ut: false, aktivitet: false },
};
const LISTER = ["inn", "ut", "aktivitet"];
const ANTALL_I_LISTE = 100;
const ANTALL_KORT = 5;
const MAKS_CSV = 5000;

// Skannere med amerikansk tastaturoppsett kan sende "+" i stedet for "-" på norsk oppsett.
const LOKASJON_PREFIKS = /^LOK[-+]/i;
const MODUS_KODE = /^MODUS[-+](INN|UT)$/i;

// ---------- Hjelpere ----------

async function api(sti, valg = {}) {
  let res;
  try {
    res = await fetch("/api/" + sti, {
      headers: { "Content-Type": "application/json" },
      ...valg,
    });
  } catch {
    throw new Error("Får ikke kontakt med serveren. Sjekk nettet, eller last inn siden på nytt hvis du har vært logget ut.");
  }
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) {
    const feil = new Error(data?.feil || `Serveren svarte med feil ${res.status}`);
    feil.varsel = data?.varsel;
    throw feil;
  }
  return data;
}

function lagre() {
  try {
    localStorage.setItem("lager", JSON.stringify({
      navn: $("navn").value,
      kommentar: $("kommentar").value,
      lokasjon: $("lokasjon").value,
      retning: tilstand.retning,
    }));
  } catch { /* lagring er bare en bekvemmelighet */ }
}

function hentLagret() {
  try {
    return JSON.parse(localStorage.getItem("lager")) || {};
  } catch {
    return {};
  }
}

let lyd;
function pip(ok) {
  try {
    lyd = lyd || new AudioContext();
    const osc = lyd.createOscillator();
    const gain = lyd.createGain();
    osc.frequency.value = ok ? 1200 : 300;
    gain.gain.value = 0.08;
    osc.connect(gain).connect(lyd.destination);
    osc.start();
    osc.stop(lyd.currentTime + (ok ? 0.08 : 0.3));
  } catch { /* lyd er valgfritt */ }
}

function melding(type, tekst, stille = false) {
  const el = $("melding");
  el.className = "melding " + type;
  el.textContent = tekst;
  void el.offsetWidth;
  el.classList.add("blink");
  if (!stille) pip(type === "ok");
}

// To toner for advarsel, så den skiller seg fra vanlig pip.
function varselPip() {
  try {
    lyd = lyd || new AudioContext();
    [0, 0.16].forEach((start, i) => {
      const osc = lyd.createOscillator();
      const gain = lyd.createGain();
      osc.frequency.value = i ? 520 : 780;
      gain.gain.value = 0.1;
      osc.connect(gain).connect(lyd.destination);
      osc.start(lyd.currentTime + start);
      osc.stop(lyd.currentTime + start + 0.13);
    });
  } catch { /* lyd er valgfritt */ }
}

function formaterTid(iso) {
  const d = new Date(iso);
  const klokke = d.toLocaleTimeString("nb-NO", { hour: "2-digit", minute: "2-digit" });
  const iDag = new Date().toDateString() === d.toDateString();
  return iDag ? klokke : `${d.toLocaleDateString("nb-NO", { day: "numeric", month: "short" })} ${klokke}`;
}

function el(tag, klasse, tekst) {
  const e = document.createElement(tag);
  if (klasse) e.className = klasse;
  if (tekst !== undefined) e.textContent = tekst;
  return e;
}

// ---------- Retning (inn/ut) ----------

function settRetning(retning) {
  tilstand.retning = retning;
  document.body.dataset.retning = retning;
  $("knapp-inn").setAttribute("aria-pressed", retning === "inn");
  $("knapp-ut").setAttribute("aria-pressed", retning === "ut");
  $("skann-etikett").textContent = retning === "inn" ? "Skann vare inn" : "Skann vare ut";
  lagre();
}

// ---------- Lister ----------

function lagRad(r, ny, visRetning) {
  const li = el("li", "rad" + (ny ? " ny" : ""));
  li.append(el("span", "kode", r.kode));
  li.append(el("span", "lok", r.lokasjon || r.lokasjonKode));
  const info = el("div", "info");
  if (visRetning) info.append(el("span", "merke " + r.retning, r.retning));
  info.append(el("time", "", formaterTid(r.tidspunkt)));
  info.lastChild.dateTime = r.tidspunkt;
  info.append(el("span", "hvem", r.navn));
  if (r.kommentar) info.append(el("span", "", r.kommentar));
  if (r.registrertAv && r.registrertAv !== r.navn) info.append(el("span", "", `registrert av ${r.registrertAv}`));
  if (tilstand.admin) {
    const slett = el("button", "slett", "Slett");
    slett.type = "button";
    slett.addEventListener("click", () => slettRegistrering(r, slett));
    info.append(slett);
  }
  li.append(info);
  return li;
}

const TOM_TEKST = {
  inn: "Ingen varer på lageret.",
  ut: "Ingen varer registrert ut ennå.",
  aktivitet: "Ingen registreringer ennå.",
};

function antallTekst(liste, antall) {
  if (tilstand.sok) return `${antall}${liste !== "inn" && antall >= ANTALL_I_LISTE ? "+" : ""} treff`;
  if (!antall) return "";
  if (liste === "inn") return `${antall} stk`;
  if (liste === "aktivitet" && !tilstand.admin) return `${antall}`;
  return `siste ${antall}`;
}

// Viser de siste fem, eller opptil hundre når listen er utvidet eller det søkes.
function visListe(liste, nyId) {
  const ol = $("liste-" + liste);
  const rader = tilstand.rader[liste];
  const alle = tilstand.visAlle[liste] || tilstand.sok;
  ol.replaceChildren();
  if (!rader.length) ol.append(el("li", "tom", tilstand.sok ? `Ingen treff på «${tilstand.sok}».` : TOM_TEKST[liste]));
  for (const r of rader.slice(0, alle ? ANTALL_I_LISTE : ANTALL_KORT)) {
    ol.append(lagRad(r, r.id === nyId, liste === "aktivitet"));
  }
  $("antall-" + liste).textContent = antallTekst(liste, rader.length);

  const knapp = $("mer-" + liste);
  knapp.hidden = Boolean(tilstand.sok) || rader.length <= ANTALL_KORT;
  knapp.textContent = tilstand.visAlle[liste] ? `Vis bare siste ${ANTALL_KORT}` : `Vis siste ${ANTALL_I_LISTE}`;
}

for (const knapp of document.querySelectorAll(".mer")) {
  knapp.addEventListener("click", () => {
    const liste = knapp.dataset.liste;
    tilstand.visAlle[liste] = !tilstand.visAlle[liste];
    visListe(liste);
  });
}

// Admin kan slette registreringer for godt, også eldre enn angrefristen.
async function slettRegistrering(r, knapp) {
  if (!confirm(`Slette registreringen av ${r.kode} (${r.retning}, ${formaterTid(r.tidspunkt)}) fra databasen? Dette kan ikke angres.`)) return;
  knapp.disabled = true;
  try {
    await api(`bevegelser/${r.retning}/${encodeURIComponent(r.id)}`, { method: "DELETE" });
    fjernLokalt(r.id);
    await oppdaterLister();
    melding("ok", `Slettet: ${r.kode} (${r.retning})`, true);
  } catch (e) {
    knapp.disabled = false;
    melding("feil", `Kunne ikke slette. ${e.message}`);
  }
}

function sti(base, params) {
  const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== "" && v !== undefined));
  const tekst = q.toString();
  return tekst ? `${base}?${tekst}` : base;
}

// Henter radene til en liste fra serveren (eller lokalt lagret aktivitet for vanlige brukere).
function hentRader(liste, sok, top) {
  if (liste === "inn") return api(sti("beholdning", { q: sok }));
  if (liste === "ut") return api(sti("bevegelser", { retning: "ut", top, q: sok }));
  if (tilstand.admin) return api(sti("aktivitet", { top, q: sok }));
  return Promise.resolve(filtrerLokalt(hentLokalAktivitet(), sok));
}

async function lastListe(liste, sok) {
  const rader = await hentRader(liste, sok, ANTALL_I_LISTE);
  if (sok !== tilstand.sok) return; // et nyere søk har tatt over
  tilstand.rader[liste] = rader;
  visListe(liste);
}

async function oppdaterLister() {
  try {
    const sok = tilstand.sok;
    await Promise.all(LISTER.map((liste) => lastListe(liste, sok)));
  } catch (e) {
    melding("feil", e.message, true);
  }
}

// Legger en ny registrering inn i listene uten å hente alt på nytt.
function visRegistrering(rad) {
  if (tilstand.sok) return oppdaterLister();
  const { rader } = tilstand;
  if (rad.retning === "inn") {
    rader.inn = [rad, ...rader.inn];
  } else {
    rader.inn = rader.inn.filter((r) => r.kode !== rad.kode);
    rader.ut = [rad, ...rader.ut].slice(0, ANTALL_I_LISTE);
  }
  rader.aktivitet = tilstand.admin
    ? [rad, ...rader.aktivitet].slice(0, ANTALL_I_LISTE)
    : hentLokalAktivitet();
  visListe("inn", rad.retning === "inn" ? rad.id : undefined);
  visListe("ut", rad.id);
  visListe("aktivitet", rad.id);
}

// ---------- Egen aktivitet (lagres i nettleseren) ----------

const AKTIVITET_NOKKEL = "lager-aktivitet";
const MAKS_LOKAL = 1000;

function hentLokalAktivitet() {
  try {
    const lagret = JSON.parse(localStorage.getItem(AKTIVITET_NOKKEL));
    return lagret?.bruker === tilstand.bruker && Array.isArray(lagret.rader) ? lagret.rader : [];
  } catch {
    return [];
  }
}

function lagreLokalAktivitet(rader) {
  try {
    localStorage.setItem(AKTIVITET_NOKKEL, JSON.stringify({ bruker: tilstand.bruker, rader: rader.slice(0, MAKS_LOKAL) }));
  } catch { /* lagring er bare en bekvemmelighet */ }
}

function loggLokalt(rad) {
  const { varsel, ...ren } = rad;
  lagreLokalAktivitet([ren, ...hentLokalAktivitet()]);
}

function fjernLokalt(id) {
  lagreLokalAktivitet(hentLokalAktivitet().filter((r) => r.id !== id));
}

function filtrerLokalt(rader, sok) {
  if (!sok) return rader;
  const s = sok.toLowerCase();
  return rader.filter((r) =>
    [r.kode, r.navn, r.kommentar, r.lokasjon, r.lokasjonKode, r.registrertAv]
      .some((felt) => String(felt || "").toLowerCase().includes(s)));
}

function visAktivitetTittel() {
  $("aktivitet-tittel").textContent = tilstand.admin ? "All aktivitet" : "Din aktivitet";
  $("aktivitet-forklaring").textContent = tilstand.admin
    ? ""
    : "Det du har registrert i denne nettleseren siden du logget inn. Tømmes når du logger ut.";
}

// ---------- CSV ----------

const CSV_KOLONNER = [
  ["Retning", (r) => r.retning],
  ["Tidspunkt", (r) => new Date(r.tidspunkt).toLocaleString("sv-SE")],
  ["Strekkode", (r) => r.kode],
  ["Navn", (r) => r.navn],
  ["Kommentar", (r) => r.kommentar],
  ["Lokasjonskode", (r) => r.lokasjonKode],
  ["Lokasjon", (r) => r.lokasjon],
  ["Registrert av", (r) => r.registrertAv],
];

// Semikolon og BOM gjør at norsk Excel åpner filen riktig.
// Celler som starter med = + - @ får en apostrof foran, så Excel ikke tolker dem som formler.
function csvCelle(verdi) {
  let t = String(verdi ?? "");
  if (/^[=+\-@\t\r]/.test(t)) t = "'" + t;
  return /[";\r\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
}

function tilCsv(rader) {
  const linjer = [CSV_KOLONNER.map(([navn]) => navn)];
  for (const r of rader) linjer.push(CSV_KOLONNER.map(([, hent]) => hent(r)));
  return "\ufeff" + linjer.map((l) => l.map(csvCelle).join(";")).join("\r\n");
}

const CSV_NAVN = { inn: "inne", ut: "ut", aktivitet: "aktivitet" };

async function lastNedCsv(liste, knapp) {
  knapp.disabled = true;
  try {
    const rader = await hentRader(liste, tilstand.sok, MAKS_CSV);
    const dato = new Date().toLocaleDateString("sv-SE");
    const lenke = el("a");
    lenke.href = URL.createObjectURL(new Blob([tilCsv(rader)], { type: "text/csv;charset=utf-8" }));
    lenke.download = `lager-${CSV_NAVN[liste]}-${dato}.csv`;
    lenke.click();
    setTimeout(() => URL.revokeObjectURL(lenke.href), 1000);
  } catch (e) {
    melding("feil", `Kunne ikke lage CSV. ${e.message}`);
  } finally {
    knapp.disabled = false;
  }
}

for (const knapp of document.querySelectorAll(".csv")) {
  knapp.addEventListener("click", () => lastNedCsv(knapp.dataset.liste, knapp));
}

// ---------- Lokasjoner ----------

function visLokasjoner(valgt) {
  const select = $("lokasjon");
  select.replaceChildren(el("option", "", "Velg lokasjon"));
  select.firstChild.value = "";
  for (const l of tilstand.lokasjoner) {
    const opt = el("option", "", l.navn === l.kode ? l.kode : `${l.navn} (${l.kode})`);
    opt.value = l.kode;
    select.append(opt);
  }
  if (tilstand.lokasjoner.some((l) => l.kode === valgt)) select.value = valgt;

  const ul = $("lokasjonsliste");
  ul.replaceChildren();
  if (!tilstand.lokasjoner.length) {
    ul.append(el("li", "tom", "Legg til den første lokasjonen, for eksempel en hylle eller et bur."));
  }
  for (const l of tilstand.lokasjoner) {
    const li = el("li");
    const tekst = el("span");
    tekst.append(el("span", "kode", l.kode), document.createTextNode(l.navn));
    const slett = el("button", "", "Fjern");
    slett.type = "button";
    slett.addEventListener("click", () => fjernLokasjon(l));
    li.append(tekst, slett);
    ul.append(li);
  }
}

async function lastLokasjoner(valgt) {
  tilstand.lokasjoner = await api("lokasjoner");
  visLokasjoner(valgt);
  if (!tilstand.lokasjoner.length) $("admin").open = true;
}

async function fjernLokasjon(l) {
  if (!confirm(`Fjerne lokasjonen ${l.navn}? Tidligere registreringer beholder lokasjonen sin.`)) return;
  try {
    await api("lokasjoner/" + encodeURIComponent(l.kode), { method: "DELETE" });
    await lastLokasjoner($("lokasjon").value);
  } catch (e) {
    melding("feil", e.message);
  }
}

$("ny-lokasjon").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  try {
    const ny = await api("lokasjoner", {
      method: "POST",
      body: JSON.stringify({ kode: $("ny-kode").value, navn: $("ny-navn").value }),
    });
    $("ny-kode").value = "";
    $("ny-navn").value = "";
    await lastLokasjoner($("lokasjon").value || ny.kode);
    lagre();
    melding("ok", `Lokasjonen ${ny.navn} er lagt til`);
    $("ny-kode").focus();
  } catch (e) {
    melding("feil", e.message);
  }
});

// ---------- Varsler ----------

const VARSEL_SEKUNDER = 8;
const MAKS_VARSLER = 3;

const AVVIST_TITTEL = { allerede_inne: "Allerede på lageret", ikke_inne: "Ikke på lageret" };

function lukkVarsel(boks) {
  clearTimeout(boks._timer);
  boks.remove();
}

function startNedtelling(boks, sekunder) {
  const tid = boks.querySelector(".tid");
  tid.style.animationDuration = sekunder + "s";
  // Holder varselet oppe så lenge musa er over det.
  const tikk = () => {
    boks._timer = setTimeout(() => (boks.matches(":hover") ? tikk() : lukkVarsel(boks)), 250);
  };
  tid.addEventListener("animationend", () => lukkVarsel(boks), { once: true });
  boks._timer = setTimeout(tikk, sekunder * 1000);
}

function lagVarsel(type, tittelTekst, innhold) {
  const beholder = $("varsler");
  while (beholder.children.length >= MAKS_VARSLER) lukkVarsel(beholder.firstElementChild);

  const boks = el("div", "varsel " + type);
  boks.setAttribute("role", "alert");
  const tekst = el("p", "tekst");
  tekst.append(...innhold);
  boks.append(el("p", "tittel", tittelTekst), tekst, el("div", "handling"), el("div", "tid"));
  beholder.append(boks);
  startNedtelling(boks, VARSEL_SEKUNDER);
  return boks;
}

// Første gang en strekkode registreres inn, med mulighet for å angre.
function visNyVare(rad) {
  const boks = lagVarsel("ny", "Ny vare", [
    el("span", "kode", rad.kode),
    document.createTextNode(` er ikke registrert før. Lagt inn på ${rad.lokasjon || rad.lokasjonKode}.`),
  ]);
  const angre = el("button", "", "Angre");
  angre.type = "button";
  angre.addEventListener("click", () => angreRegistrering(rad, boks, angre));
  boks.querySelector(".handling").append(angre);
  varselPip();
}

// Skanningen ble avvist fordi varen allerede er inne, eller ikke er inne.
function visAvvist(type, kode, tekst) {
  lagVarsel(type, AVVIST_TITTEL[type], [
    el("span", "kode", kode),
    document.createTextNode(" ble ikke registrert. " + tekst),
  ]);
}

async function angreRegistrering(rad, boks, knapp) {
  knapp.disabled = true;
  try {
    await api(`bevegelser/${rad.retning}/${encodeURIComponent(rad.id)}`, { method: "DELETE" });
    fjernLokalt(rad.id);
    oppdaterLister();

    clearTimeout(boks._timer);
    boks.className = "varsel angret";
    boks.querySelector(".tittel").textContent = "Angret";
    const tekst = boks.querySelector(".tekst");
    tekst.replaceChildren(el("span", "kode", rad.kode), document.createTextNode(` er fjernet fra ${rad.retning === "inn" ? "lageret" : "ut-listen"}.`));
    knapp.parentElement.replaceChildren();
    const tid = boks.querySelector(".tid");
    tid.replaceWith(el("div", "tid"));
    startNedtelling(boks, 3);
    melding("ok", `Angret: ${rad.kode} er ikke lenger registrert ${rad.retning}`, true);
  } catch (e) {
    knapp.disabled = false;
    melding("feil", `Kunne ikke angre. ${e.message}`);
  }
  $("skann").focus();
}

// ---------- Skanning ----------

async function behandleSkann() {
  const felt = $("skann");
  const verdi = felt.value.trim();
  felt.value = "";
  if (!verdi) return;

  const modus = verdi.match(MODUS_KODE);
  if (modus) {
    settRetning(modus[1].toLowerCase());
    melding("ok", modus[1].toLowerCase() === "inn" ? "Byttet til inn" : "Byttet til ut");
    return;
  }

  if (LOKASJON_PREFIKS.test(verdi)) {
    const kode = verdi.slice(4).toUpperCase();
    const lok = tilstand.lokasjoner.find((l) => l.kode === kode);
    if (!lok) return melding("feil", `Fant ingen lokasjon med koden ${kode}. Legg den til under Lokasjoner.`);
    $("lokasjon").value = lok.kode;
    lagre();
    return melding("ok", `Lokasjon satt til ${lok.navn}`);
  }

  const navn = $("navn").value.trim();
  if (!navn) {
    melding("feil", `Fyll inn navn først. ${verdi} ble ikke registrert.`);
    $("navn").focus();
    return;
  }
  const lok = tilstand.lokasjoner.find((l) => l.kode === $("lokasjon").value);
  if (!lok) {
    melding("feil", `Velg lokasjon først. ${verdi} ble ikke registrert.`);
    $("lokasjon").focus();
    return;
  }

  const retning = tilstand.retning;
  try {
    const rad = await api("bevegelser", {
      method: "POST",
      body: JSON.stringify({
        retning,
        kode: verdi,
        navn,
        kommentar: $("kommentar").value.trim(),
        lokasjonKode: lok.kode,
        lokasjon: lok.navn,
      }),
    });
    loggLokalt(rad);
    visRegistrering(rad);
    melding("ok", `${verdi} registrert ${retning} på ${lok.navn}`, Boolean(rad.varsel));
    if (rad.varsel === "ny") visNyVare(rad);
  } catch (e) {
    melding("feil", `${verdi} ble ikke registrert. ${e.message}`);
    if (AVVIST_TITTEL[e.varsel]) visAvvist(e.varsel, verdi, e.message);
  }
}

$("skann").addEventListener("keydown", (ev) => {
  if (ev.key === "Enter") {
    ev.preventDefault();
    behandleSkann();
  }
});

// ---------- Søk ----------

let sokTimer;
function sok(umiddelbart) {
  clearTimeout(sokTimer);
  sokTimer = setTimeout(() => {
    tilstand.sok = $("sok").value.trim();
    oppdaterLister();
  }, umiddelbart ? 0 : 300);
}

$("sok").addEventListener("input", () => sok(false));
$("sok").addEventListener("keydown", (ev) => {
  // Skanneren sender Enter: søk med en gang, men registrer ingenting.
  if (ev.key === "Enter") { ev.preventDefault(); sok(true); }
  if (ev.key === "Escape") { $("sok").value = ""; sok(true); $("skann").focus(); }
});

// Klikk på tom flate sender markøren tilbake til skannefeltet.
document.addEventListener("click", (ev) => {
  // preventScroll: ellers hopper siden til toppen hver gang man klikker i listene.
  if (!ev.target.closest("input, select, button, a, summary, textarea, form")) $("skann").focus({ preventScroll: true });
});

$("knapp-inn").addEventListener("click", () => { settRetning("inn"); $("skann").focus(); });
$("knapp-ut").addEventListener("click", () => { settRetning("ut"); $("skann").focus(); });
for (const id of ["navn", "kommentar", "lokasjon"]) $(id).addEventListener("change", lagre);
for (const id of ["navn", "kommentar"]) {
  $(id).addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") { ev.preventDefault(); lagre(); $("skann").focus(); }
  });
}
$("lokasjon").addEventListener("change", () => $("skann").focus());
$("logg-ut").addEventListener("click", () => {
  try { localStorage.removeItem(AKTIVITET_NOKKEL); } catch { /* ingenting å tømme */ }
});

// ---------- Oppstart ----------

async function start() {
  const lagret = hentLagret();
  $("navn").value = lagret.navn || "";
  $("kommentar").value = lagret.kommentar || "";
  settRetning(lagret.retning === "ut" ? "ut" : "inn");

  try {
    const meg = await fetch("/.auth/me").then((r) => r.json());
    const bruker = meg?.clientPrincipal?.userDetails;
    if (bruker) {
      tilstand.bruker = bruker;
      $("bruker-navn").textContent = bruker;
      if (!$("navn").value) $("navn").value = bruker;
    }
    // Bare for visning. Serveren sjekker selv om brukeren er admin.
    tilstand.admin = (meg?.clientPrincipal?.userRoles || []).includes("lageradmin");
  } catch { /* vises bare som pynt */ }
  visAktivitetTittel();

  try {
    await lastLokasjoner(lagret.lokasjon);
  } catch (e) {
    melding("feil", e.message);
  }
  await oppdaterLister();
  $("skann").focus();

  setInterval(() => { if (!document.hidden) oppdaterLister(); }, 30000);
}

start();
