/**
 * Parser za fakture — radi na jednom dugačkom stringu koji PDF.js vrati.
 * Traži labele i uzima decimalni broj koji slijedi odmah iza.
 */

export function parseInvoiceText(rawText) {
  // Sve u jedan string, normalizovano
  const text = rawText.replace(/\r/g, '').replace(/\n/g, ' ').replace(/\s+/g, ' ').trim()
  console.log('[PDF text]', text)

  const datum  = findDatum(text)
  const neto   = findValue(text, [
    'Neto iznos', 'Iznos bez PDV', 'Osnovica', 'Oporezivi iznos',
    'Neto', 'Osnovica iznos PDV',
  ])
  const pdv    = findValue(text, [
    'Iznos PDV', 'PDV iznos', 'Iznos pdv',
    'PDV 17%', 'PDV:', 'Porez na dodanu vrijednost',
  ])
  // Ukupno = neto + pdv ako ih nađemo, inače traži labele
  let ukupno = findValue(text, [
    'Za uplatu', 'Ukupno za uplatu', 'Ukupno s PDV', 'Ukupno sa PDV',
    'Vrijednost s PDV', 'UKUPNO', 'Total', 'Ukupno iznos', 'Sveukupno',
  ])
  if (ukupno === null && neto !== null && pdv !== null) {
    ukupno = Math.round((neto + pdv) * 100) / 100
  }

  return { datum, neto, pdv, ukupno, firma: findFirma(text) }
}

// ─── Traženje decimalnog iznosa nakon labele ──────────────────────────────────

function findValue(text, labels) {
  // Decimalni broj: 1.234,56 ili 1234,56 ili 1.234.56 ili 1234.56
  const amountRe = /:\s*([0-9]{1,3}(?:[.,][0-9]{3})*[.,][0-9]{2}|[0-9]+[.,][0-9]{2})/

  for (const label of labels) {
    // Escape specijalnih znakova u labeli
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const re = new RegExp(escaped + amountRe.source, 'i')
    const m = text.match(re)
    if (m) {
      const val = parseAmount(m[1])
      if (val !== null) {
        console.log(`[PDF] ${label} → ${val}`)
        return val
      }
    }
  }
  return null
}

function parseAmount(str) {
  if (!str) return null
  let s = str.trim()
  const lastComma = s.lastIndexOf(',')
  const lastDot   = s.lastIndexOf('.')
  if (lastComma > lastDot) {
    // 1.234,56 format
    s = s.replace(/\./g, '').replace(',', '.')
  } else {
    // 1,234.56 format
    s = s.replace(/,/g, '')
  }
  const n = parseFloat(s)
  return isNaN(n) ? null : n
}

// ─── Datum ────────────────────────────────────────────────────────────────────

function findDatum(text) {
  // Labele po prioritetu
  const labels = [
    'Datum isporuke', 'Datum prometa', 'Datum fakture',
    'Datum izdavanja', 'Datum dokumenta', 'Datum:',
  ]

  // Datum formati: dd.mm.yy, dd.mm.yyyy, dd-mm-yyyy
  const dateRe = /(\d{1,2})[.\-\/](\d{1,2})[.\-\/](\d{2,4})/

  for (const label of labels) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    // Uzmi 40 znakova iza labele i traži datum tamo
    const re = new RegExp(escaped + '[^0-9]{0,20}' + dateRe.source, 'i')
    const m = text.match(re)
    if (m) {
      // m[1], m[2], m[3] su grupe iz dateRe (offset zbog escaped+prefix)
      const dm = text.slice(text.search(re)).match(dateRe)
      if (dm) {
        const result = formatDate(dm[1], dm[2], dm[3])
        if (result) {
          console.log(`[PDF] Datum (${label}) → ${result}`)
          return result
        }
      }
    }
  }

  // Fallback — traži "21.01.26" ili "21.01.2026" bilo gdje
  const m = text.match(dateRe)
  if (m) {
    const result = formatDate(m[1], m[2], m[3])
    if (result) {
      console.log(`[PDF] Datum (fallback) → ${result}`)
      return result
    }
  }

  return null
}

function formatDate(d, mo, y) {
  const day  = parseInt(d)
  const mon  = parseInt(mo)
  let year   = parseInt(y)
  if (y.length === 2) year = 2000 + year
  if (mon < 1 || mon > 12 || day < 1 || day > 31) return null
  if (year < 2000 || year > 2100) return null
  return `${year}-${String(mon).padStart(2,'0')}-${String(day).padStart(2,'0')}`
}

// ─── Firma ────────────────────────────────────────────────────────────────────

function findFirma(text) {
  // Traži "TEX PRINT" ili firme sa d.o.o. u tekstu
  const m = text.match(/([A-ZŠĐŽČĆ][A-Za-zšđžčćŠĐŽČĆ\s.]+(?:d\.o\.o\.?|D\.O\.O\.?|d\.d\.?|a\.d\.?|s\.p\.?))/u)
  if (m) return m[0].trim()
  return null
}
