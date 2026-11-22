/**
 * DIAGNOSTIC_ONLY. Pure, ephemeral field-shape counter for an owner-approved
 * Standard Toast API sample. Never print or persist provider values.
 * Never feed this module to Supervisor, cv_* views, or ingestion.
 */
const FIELD_PATHS = Object.freeze({
  order: [
    "guid", "source", "customer", "customer.guid", "customer.firstName",
    "customer.lastName", "customer.email", "customer.phone", "customer.phoneNumber",
    "guest", "guest.guid", "guest.firstName", "guest.lastName", "guestInfo",
    "customerNotes", "deliveryInfo", "numberOfGuests",
  ],
  check: [
    "guid", "tabName", "customer", "customer.guid", "customer.firstName",
    "customer.lastName", "customer.email", "customer.phone", "customer.phoneNumber",
    "customer.address", "appliedLoyaltyInfo", "appliedLoyaltyInfo.loyaltyIdentifier",
    "appliedLoyaltyInfo.vendor", "customerNotes", "deliveryInfo",
    "deliveryInfo.recipientName", "email", "phone", "phoneNumber",
  ],
  payment: [
    "guid", "type", "cardEntryMode", "cardType", "cardholderName",
    "cardholder.firstName", "cardholder.lastName", "cardInfo.holderName",
    "cardInfo.cardholderName", "cardDetails.cardholderName",
    "cardDetails.firstName", "cardDetails.lastName", "paymentCard.cardholderName",
    "customer", "customer.guid", "customer.firstName", "customer.lastName",
    "guest", "guest.guid", "cardPaymentId", "cardFingerprint",
    "paymentAccountReference", "networkTransactionIdentifier",
    "paymentMethodId", "tenderTransactionGuid", "first6Digits", "last4Digits",
  ],
});
const SENSITIVE_KEY = /^(?:pan|primaryaccountnumber|cardnumber|paymentcardnumber|cvv|cvc|cvc2|cvv2|securitycode|magstripe|track\d*|password|secret|apikey|authtoken|accesstoken|refreshtoken|paymenttoken|cardtoken|authorization)$/i;
const RELEVANT_PATH = /(?:customer|guest|cardholder|holdername|payer|name|email|phone|loyalty|fingerprint|paymentaccountreference|cardpaymentid|tab|delivery)/i;
const STATES = ["populated", "null", "empty", "absent"];
const record = value => value !== null && typeof value === "object" && !Array.isArray(value);
const allowedField = name => /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name) && !SENSITIVE_KEY.test(name);

export function fieldState(value, path) {
  let cur = value;
  for (const part of path.split(".")) {
    if (!record(cur) || !Object.prototype.hasOwnProperty.call(cur, part)) return "absent";
    cur = cur[part];
  }
  if (cur === null) return "null";
  if (cur === undefined) return "absent";
  if (typeof cur === "string" && cur.trim() === "") return "empty";
  if (Array.isArray(cur) && cur.length === 0) return "empty";
  if (record(cur) && Object.keys(cur).length === 0) return "empty";
  return "populated";
}

export function newFieldReport() {
  return {
    objectCounts: { order: 0, check: 0, payment: 0 },
    fields: Object.fromEntries(Object.entries(FIELD_PATHS).map(([kind, fields]) =>
      [kind, Object.fromEntries(fields.map(name =>
        [name, Object.fromEntries(STATES.map(state => [state, 0]))]))])),
    extraNameRelatedPaths: {},
  };
}

// Only provider schema *keys* meeting strict identifier syntax, never values.
// A bounded scan finds surprises (including nested guest/name paths) without
// returning raw objects, dynamic user-supplied property names, or secrets.
function noteSchemaKeys(summary, kind, value) {
  const seen = new Set();
  function visit(current, prefix, depth) {
    if (depth > 5 || seen.size >= 250) return;
    if (Array.isArray(current)) {
      for (const item of current.slice(0, 2)) visit(item, prefix, depth + 1);
      return;
    }
    if (!record(current)) return;
    for (const [key, nested] of Object.entries(current)) {
      if (!allowedField(key)) continue;
      const full = prefix ? prefix + "." + key : key;
      if (full.length > 150) continue;
      if (RELEVANT_PATH.test(full) && !seen.has(full)) seen.add(full);
      // Never enumerate the values; follow only their object structure.
      if (nested !== null && typeof nested === "object") visit(nested, full, depth + 1);
      if (seen.size >= 250) break;
    }
  }
  visit(value, "", 0);
  for (const full of seen) {
    const key = kind + "." + full;
    if (Object.keys(summary.extraNameRelatedPaths).length >= 250 &&
        !Object.prototype.hasOwnProperty.call(summary.extraNameRelatedPaths, key)) continue;
    summary.extraNameRelatedPaths[key] = (summary.extraNameRelatedPaths[key] ?? 0) + 1;
  }
}

function observe(summary, kind, value) {
  if (!record(value)) return;
  summary.objectCounts[kind] += 1;
  for (const path of FIELD_PATHS[kind]) {
    summary.fields[kind][path][fieldState(value, path)] += 1;
  }
  noteSchemaKeys(summary, kind, value);
}
export function observeOrder(summary, rawOrder) {
  observe(summary, "order", rawOrder);
  const checks = Array.isArray(rawOrder?.checks) ? rawOrder.checks : [];
  for (const check of checks) {
    observe(summary, "check", check);
    const payments = Array.isArray(check?.payments) ? check.payments : [];
    for (const payment of payments) observe(summary, "payment", payment);
  }
}
export function observePayment(summary, rawPayment) {
  observe(summary, "payment", rawPayment);
}
export function publicFieldReport(summary) {
  const paths = Object.entries(summary.extraNameRelatedPaths)
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(0, 150)
    .map(([field, observedObjects]) => ({ field, observedObjects }));
  return { objectCounts: summary.objectCounts, fields: summary.fields,
    extraNameRelatedPaths: paths };
}
