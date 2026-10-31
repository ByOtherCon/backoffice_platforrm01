// Vendor (subcontractor) compliance: a vendor can be paid only with a W-9 AND valid insurance
// (a COI that has not expired, or a workers' comp exemption that has not expired).
export type Doc = { present: boolean; expires: string | null };
export type VendorDocs = { w9: boolean; coi: Doc; exemption: Doc };
export type Status = 'Valid' | 'Expiring' | 'Expired' | 'Missing';

const days = (from: string, to: string) => Math.round((Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / 86400000);

export function evaluate(d: VendorDocs, today: string, warnDays = 30) {
  const reasons: string[] = [];
  if (!d.w9) reasons.push('No W-9 on file');
  const coiGood = d.coi.present && !!d.coi.expires && d.coi.expires >= today;
  const exGood = d.exemption.present && (!d.exemption.expires || d.exemption.expires >= today);
  if (!d.coi.present && !d.exemption.present) reasons.push('No certificate of insurance or exemption on file');
  else if (!coiGood && !exGood) {
    if (d.coi.present && !d.coi.expires) reasons.push('Certificate of insurance has no expiration date');
    else if (d.coi.present && d.coi.expires! < today) reasons.push(`Certificate of insurance expired ${d.coi.expires}`);
    if (d.exemption.present && d.exemption.expires && d.exemption.expires < today) reasons.push(`Exemption expired ${d.exemption.expires}`);
  }
  const hasInsuranceDoc = d.coi.present || d.exemption.present;
  const canPay = d.w9 && (coiGood || exGood);
  // soonest date coverage lapses (the best valid coverage, so an exemption with no end date means no expiry)
  let nextExpiry: string | null = null;
  if (coiGood || exGood) {
    const ends = [coiGood ? d.coi.expires! : null, exGood ? d.exemption.expires : null];
    nextExpiry = ends.some((e) => e === null && exGood) ? null : (ends.filter(Boolean).sort().at(-1) as string);
  }
  const daysLeft = nextExpiry ? days(today, nextExpiry) : null;
  let status: Status;
  if (!d.w9 || !hasInsuranceDoc) status = 'Missing';
  else if (!canPay) status = 'Expired';
  else status = daysLeft !== null && daysLeft <= warnDays ? 'Expiring' : 'Valid';
  return { status, canPay, reasons, nextExpiry, daysLeft };
}
export const stageFor = (daysLeft: number | null, status: Status): 'd30' | 'd7' | 'expired' | null =>
  status === 'Expired' ? 'expired' : status === 'Expiring' && daysLeft !== null ? (daysLeft <= 7 ? 'd7' : 'd30') : null;
