"use strict";

const $ = (id) => document.getElementById(id);
const tilstand = { retning: "inn", lokasjoner: [], rader: { inn: [], ut: [] } };
const ANTALL_I_LISTE = 100;

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
  if (!res.ok) throw new Error(data?.feil || `Serveren svarte med feil ${res.status}`);
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

function lagRad(r, ny) {
  const li = el("li", "rad" + (ny ? " ny" : ""));
  li.append(el("span", "kode", r.kode));
  li.append(el("span", "lok", r.lokasjon || r.lokasjonKode));
  const info = el("div", "info");
  info.append(el("time", "", formaterTid(r.tidspunkt)));
  info.lastChild.dateTime = r.tidspunkt;
  info.append(el("span", "hvem", r.navn));
  if (r.kommentar) info.append(el("span", "", r.kommentar));
  if (r.registrertAv && r.registrertAv !== r.navn) info.append(el("span", "", `registrert av ${r.registrertAv}`));
  li.append(info);
  return li;
}

function visListe(retning, nyId) {
  const ol = $("liste-" + retning);
  const rader = tilstand.rader[retning];
  ol.replaceChildren();
  if (!rader.length) {
    ol.append(el("li", "tom", retning === "inn" ? "Ingen varer registrert inn ennå." : "Ingen varer registrert ut ennå."));
  }
  for (const r of rader) ol.append(lagRad(r, r.id === nyId));
  $("antall-" + retning).textContent = rader.length ? `siste ${rader.length}` : "";
}

async function lastListe(retning) {
  tilstand.rader[retning] = await api(`bevegelser?retning=${retning}&top=${ANTALL_I_LISTE}`);
  visListe(retning);
}

async function oppdaterLister() {
  try {
    await Promise.all([lastListe("inn"), lastListe("ut")]);
  } catch (e) {
    melding("feil", e.message, true);
  }
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
    tilstand.rader[retning] = [rad, ...tilstand.rader[retning]].slice(0, ANTALL_I_LISTE);
    visListe(retning, rad.id);
    melding("ok", `${verdi} registrert ${retning} på ${lok.navn}`);
  } catch (e) {
    melding("feil", `${verdi} ble ikke registrert. ${e.message}`);
  }
}

$("skann").addEventListener("keydown", (ev) => {
  if (ev.key === "Enter") {
    ev.preventDefault();
    behandleSkann();
  }
});

// Klikk på tom flate sender markøren tilbake til skannefeltet.
document.addEventListener("click", (ev) => {
  if (!ev.target.closest("input, select, button, a, summary, textarea, form")) $("skann").focus();
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
      $("bruker-navn").textContent = bruker;
      if (!$("navn").value) $("navn").value = bruker;
    }
  } catch { /* vises bare som pynt */ }

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
