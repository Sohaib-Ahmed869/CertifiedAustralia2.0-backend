const PDFDocument = require('pdfkit');

const BRAND_GREEN = '#0a9d42';
const INK = '#1a1a2e';
const MUTE = '#555555';

const fmtAUD = (n) =>
  typeof n === 'number' && !isNaN(n)
    ? n.toLocaleString('en-AU', { style: 'currency', currency: 'AUD' })
    : '—';

const fmtDate = (d) => {
  if (!d) return '—';
  const date = new Date(d);
  return isNaN(date.getTime())
    ? '—'
    : date.toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric' });
};

/**
 * Render a Direct Debit Authority to a PDF Buffer.
 * @param {object} record - the DirectDebitAuthority document (lean/plain object)
 * @param {object} ctx - { applicationDisplayId }
 * @returns {Promise<Buffer>}
 */
function generateDirectDebitPdf(record, ctx = {}) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 50 });
      const chunks = [];
      doc.on('data', (c) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const form = record.form || {};
      const arr = record.arrangement || {};
      const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
      const left = doc.page.margins.left;

      // ── Header band ──
      doc.rect(0, 0, doc.page.width, 96).fill(BRAND_GREEN);
      doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(22)
        .text('Certified Australia Group', left, 30);
      doc.font('Helvetica').fontSize(13)
        .text('Direct Debit Request & Authorisation', left, 60);
      doc.moveDown(2);

      let y = 120;
      doc.fillColor(MUTE).font('Helvetica').fontSize(9);
      doc.text(`Application: ${ctx.applicationDisplayId || form.studentClientId || '—'}`, left, y, { align: 'left' });
      doc.text(`Date: ${fmtDate(record.submittedAt || new Date())}`, left, y, { width: pageWidth, align: 'right' });
      y += 24;

      const heading = (label) => {
        doc.fillColor(BRAND_GREEN).font('Helvetica-Bold').fontSize(12).text(label, left, y);
        y = doc.y + 4;
        doc.moveTo(left, y).lineTo(left + pageWidth, y).strokeColor('#e5e7eb').lineWidth(1).stroke();
        y += 10;
      };

      const row = (label, value) => {
        doc.fillColor(MUTE).font('Helvetica').fontSize(10).text(label, left, y, { width: pageWidth * 0.4, continued: false });
        doc.fillColor(INK).font('Helvetica-Bold').fontSize(10)
          .text(value ?? '—', left + pageWidth * 0.4, y, { width: pageWidth * 0.6 });
        y = doc.y + 8;
      };

      // ── Customer details ──
      heading('Customer Details');
      row('Full name', form.fullName);
      row('Address', form.address);
      row('Phone', form.phone);
      row('Email', form.email);
      y += 6;

      // ── Payment arrangement ──
      heading('Payment Arrangement');
      row('Total amount', fmtAUD(arr.totalAmount));
      row('Recurring amount', fmtAUD(arr.recurringAmount));
      row('Frequency', arr.frequency || 'Per schedule');
      row('First charge date', fmtDate(arr.firstChargeDate));
      if (arr.numberOfPayments) row('Number of payments', String(arr.numberOfPayments));
      if (arr.outstanding != null) row('Outstanding balance', fmtAUD(arr.outstanding));
      if (arr.surcharge) row('Surcharge', fmtAUD(arr.surcharge));
      y += 6;

      // ── Authorisation ──
      heading('Authorisation');
      const consents = [
        [form.authoriseRecurring, 'I authorise Certified Australia Group Pty Ltd to charge the payment method on file on a recurring basis for the amounts and schedule shown above.'],
        [form.understandRecurring, 'I understand these are recurring charges that will continue until the arrangement is complete or I provide written notice.'],
        [form.confirmCardholder, 'I confirm I am the authorised holder of the payment method being charged.'],
        [form.acceptTerms, 'I have read and accept the terms of this Direct Debit arrangement.'],
      ];
      consents.forEach(([checked, text]) => {
        const boxY = y + 1;
        doc.rect(left, boxY, 10, 10).strokeColor(BRAND_GREEN).lineWidth(1).stroke();
        if (checked) {
          doc.fillColor(BRAND_GREEN).font('Helvetica-Bold').fontSize(9).text('X', left + 1.5, boxY + 0.5);
        }
        doc.fillColor(INK).font('Helvetica').fontSize(9)
          .text(text, left + 18, y, { width: pageWidth - 18 });
        y = doc.y + 8;
      });
      y += 10;

      // ── Signature ──
      heading('Signature');
      const sigDataUrl = record.signature?.dataUrl || '';
      if (sigDataUrl.startsWith('data:image')) {
        try {
          const base64 = sigDataUrl.split(',')[1];
          const imgBuffer = Buffer.from(base64, 'base64');
          doc.image(imgBuffer, left, y, { fit: [220, 80] });
        } catch {
          /* ignore malformed signature image */
        }
      }
      y += 90;
      doc.moveTo(left, y).lineTo(left + 240, y).strokeColor('#9ca3af').lineWidth(0.5).stroke();
      y += 4;
      doc.fillColor(MUTE).font('Helvetica').fontSize(9)
        .text(`${form.signatureName || form.fullName || ''}`, left, y);
      doc.text(`Signed: ${form.signatureDate || fmtDate(record.submittedAt)}`, left, y, { width: 240, align: 'right' });

      // ── Footer ──
      const footerY = doc.page.height - 60;
      doc.fillColor('#9ca3af').font('Helvetica').fontSize(7.5)
        .text(
          'Certified Australia Group Pty Ltd — This document is an electronic record of the customer\'s Direct Debit authorisation. Charges are processed via a PCI-DSS compliant payment gateway; no card or bank numbers are stored in this document.',
          left, footerY, { width: pageWidth, align: 'center' }
        );

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

module.exports = { generateDirectDebitPdf };
