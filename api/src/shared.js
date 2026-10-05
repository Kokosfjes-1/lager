const { TableClient } = require("@azure/data-tables");
const crypto = require("crypto");

const ROLLE = "lagerbruker";
const tabeller = {};

// Henter en tabellklient og oppretter tabellen første gang den brukes.
function hentTabell(navn) {
  const conn = process.env.TABLES_CONNECTION_STRING;
  if (!conn) throw new Error("Miljøvariabelen TABLES_CONNECTION_STRING mangler");
  if (!tabeller[navn]) {
    const klient = TableClient.fromConnectionString(conn, navn, {
      allowInsecureConnection: conn.includes("UseDevelopmentStorage=true"),
    });
    tabeller[navn] = klient
      .createTable()
      .catch((e) => {
        if (e.statusCode !== 409) {
          delete tabeller[navn];
          throw e;
        }
      })
      .then(() => klient);
  }
  return tabeller[navn];
}

// Static Web Apps sender innlogget bruker i denne headeren.
function hentBruker(request) {
  const header = request.headers.get("x-ms-client-principal");
  if (!header) return null;
  try {
    return JSON.parse(Buffer.from(header, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

// Ekstra sikring i tillegg til rutereglene i staticwebapp.config.json.
function krevBruker(request) {
  const bruker = hentBruker(request);
  if (!bruker || !(bruker.userRoles || []).includes(ROLLE)) return null;
  return bruker;
}

function vask(verdi, maks) {
  return String(verdi ?? "").trim().slice(0, maks);
}

// Lokasjonskoder brukes som RowKey, så de må være enkle: A-Z, 0-9 og bindestrek.
function vaskKode(verdi) {
  return vask(verdi, 30).toUpperCase().replace(/[^A-Z0-9-]/g, "");
}

// Omvendt tidsstempel gjør at nyeste rad kommer først i Table Storage.
function omvendtNokkel() {
  const omvendt = (9999999999999 - Date.now()).toString().padStart(13, "0");
  return `${omvendt}-${crypto.randomUUID().slice(0, 8)}`;
}

function svar(status, body) {
  return body === undefined ? { status } : { status, jsonBody: body };
}

// Pakker inn en handler med tilgangssjekk og felles feilhåndtering.
function beskyttet(handler) {
  return async (request, context) => {
    const bruker = krevBruker(request);
    if (!bruker) return svar(403, { feil: "Du har ikke tilgang til lageret" });
    try {
      return await handler(request, context, bruker);
    } catch (e) {
      context.error(e);
      return svar(500, { feil: "Noe gikk galt på serveren. Prøv igjen." });
    }
  };
}

module.exports = { hentTabell, vask, vaskKode, omvendtNokkel, svar, beskyttet };
