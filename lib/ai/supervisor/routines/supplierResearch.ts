/** Map exact canonical ingredient labels to a fixed public search vocabulary.
 * Never concatenate arbitrary owner/model/source text or a cafe address.
 * Unknown products require owner-confirmed public terms in normal chat. */
const publicIngredients:Record<string,string>={
 milk:"milk", "whole milk":"whole milk", "skim milk":"skim milk", "oat milk":"oat milk",
 "almond milk":"almond milk", "soy milk":"soy milk", "coffee beans":"coffee beans",
 coffee:"coffee beans", espresso:"coffee beans", sugar:"sugar", flour:"flour",
 eggs:"eggs", butter:"butter", cream:"cream", chocolate:"chocolate", tea:"tea",
 cups:"disposable cups", lids:"cup lids", napkins:"napkins", water:"bottled water"
};
export function publicSupplierLeadQuery(name:unknown,city:unknown):string|null{
 if(typeof name!=="string")return null;
 const term=publicIngredients[name.normalize("NFKC").trim().toLowerCase()];
 if(typeof term!=="string")return null;
 // City is a saved public geography field. Never accept an address, ID, URL,
 // multiline payload, or model query. Missing/unsafe city means no lookup.
 if(typeof city!=="string"||!/^[\p{L}\p{M} .'-]{1,80}$/u.test(city.trim())||
    /\b(?:password|secret|token|private|customer|employee|invoice|bank|account)\b/iu.test(city))return null;
 return "Wholesale "+term+" suppliers serving "+city.trim()+". Public supplier website leads only; no confirmed quote, price, inventory or delivery.";
}
