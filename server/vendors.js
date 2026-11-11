// Finds or creates the vendor for a receipt or vendor invoice. A new vendor is saved for future use unless saveVendor is false:
// then it is a one-time purchase, kept on the invoice but left out of the vendor dropdowns. Choosing "save" later upgrades it.
import { bad, text } from './http.js';

export async function resolveSupplier(t, { supplierId, supplierName, saveVendor }) {
  const keep = saveVendor !== false;
  if (supplierId) {
    const [s] = await t('SELECT id, one_time FROM suppliers WHERE id=$1', [supplierId]); if (!s) throw bad('Supplier not found.');
    if (saveVendor === true && s.one_time) await t('UPDATE suppliers SET one_time=false WHERE id=$1', [s.id]);
    return s.id;
  }
  const name = text(supplierName, 'Vendor', { max: 200 });
  const [ex] = await t('SELECT id, one_time FROM suppliers WHERE lower(name)=lower($1)', [name]);
  if (ex) { if (keep && ex.one_time) await t('UPDATE suppliers SET one_time=false WHERE id=$1', [ex.id]); return ex.id; }
  return (await t('INSERT INTO suppliers(name,one_time) VALUES ($1,$2) RETURNING id', [name, !keep]))[0].id;
}
