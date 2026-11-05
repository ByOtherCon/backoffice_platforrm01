import test from 'node:test';
import assert from 'node:assert/strict';
import { titleCase } from '../public/ui.js';

test('app rule: the first letter of every word is a capital in titles, buttons and labels', () => {
  assert.equal(titleCase('Receipts & supplier invoices'), 'Receipts & Supplier Invoices');
  assert.equal(titleCase('+ Add to-do'), '+ Add To-Do'); assert.equal(titleCase('Review and import'), 'Review And Import'); assert.equal(titleCase('← All projects'), '← All Projects');
  assert.equal(titleCase('Ignore all not matched (1)'), 'Ignore All Not Matched (1)'); assert.equal(titleCase('Retainage held (optional)'), 'Retainage Held (Optional)'); assert.equal(titleCase('save changes'), 'Save Changes');
});
test('the company name stays "by Other", and codes, emails and sentences are left alone', () => {
  assert.equal(titleCase('by Other Desk Platform'), 'by Other Desk Platform'); assert.equal(titleCase('Sign in to by Other Desk Platform'), 'Sign In To by Other Desk Platform');
  assert.equal(titleCase('user@byother.net'), 'user@byother.net'); assert.equal(titleCase('C11031 invoice'), 'C11031 Invoice');
  const sentence = 'This is a long sentence that explains what happens when you press the button.'; assert.equal(titleCase(sentence), sentence);
  assert.equal(titleCase('Already Capitalized Words'), 'Already Capitalized Words'); assert.equal(titleCase('QuickBooks and SharePoint'), 'QuickBooks And SharePoint'); assert.equal(titleCase(''), '');
});
