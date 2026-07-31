'use strict';

/**
 * applicationEmailService.js
 *
 * Centralised service for all application lifecycle emails in the
 * Certified Australia RPL portal.  Every function is non-blocking —
 * errors are logged but never thrown so calling code is never interrupted.
 *
 * All functions return { success: true | false }.
 */

const path = require('path');

const {
  buildEmail,
  sendEmail,
  heading2,
  heading3,
  paragraph,
  bulletList,
  numberedList,
  greeting,
  signOff,
  buttonGroup,
  infoCard,
  successCard,
  warningCard,
  dangerCard,
  detailsTable,
  statusItem,
  divider,
  smallText,
  personalMessage,
} = require('./emailService');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BASE_URL =
  process.env.APP_BASE_URL ||
  process.env.FRONTEND_URL ||
  'https://portal.certifiedaustralia.com.au';

const ADMIN_EMAIL =
  process.env.ADMIN_NOTIFICATION_EMAIL || 'info@certifiedaustralia.com.au';

const CEO_EMAIL = process.env.CEO_EMAIL || 'ceo@certifiedaustralia.com.au';

const { SIGNUP_DISCOUNT_AMOUNT } = require('../config/pricing');

// ASQA Fact Sheet for Students attached to the welcome email — required for RPL compliance.
const ASQA_FACT_SHEET = {
  filename: 'Fact Sheet for Students - Recognition of Prior Learning.pdf',
  path: path.join(
    __dirname,
    '../../docs/Fact Sheet for Students - Recognition of Prior Learning.pdf'
  ),
  contentType: 'application/pdf',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Format a number as AUD currency.
 * @param {number} amount
 * @returns {string}  e.g. "AUD $1,250.00"
 */
const formatAUD = (amount) =>
  `AUD ${new Intl.NumberFormat('en-AU', {
    style: 'currency',
    currency: 'AUD',
  }).format(amount ?? 0)}`;

/**
 * Format a date in Australian locale.
 * @param {Date|string|null} date
 * @returns {string}  e.g. "29 June 2026"
 */
const formatDate = (date) => {
  if (!date) return '—';
  return new Date(date).toLocaleDateString('en-AU', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
};

/**
 * Format a date + time in Australian locale.
 * @param {Date|string|null} date
 * @returns {string}
 */
const formatDateTime = (date) => {
  if (!date) return '—';
  return new Date(date).toLocaleString('en-AU', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
};

/**
 * Capitalise the first letter of a string.
 * @param {string} str
 * @returns {string}
 */
const cap = (str) =>
  str ? str.charAt(0).toUpperCase() + str.slice(1) : str;

/**
 * Wrap status item rows in a table shell.
 * @param {string} rows - HTML from one or more statusItem() calls
 * @returns {string}
 */
const statusTable = (rows) =>
  `<table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%"
    style="margin:16px 0;">
    ${rows}
  </table>`;

// ---------------------------------------------------------------------------
// 1. sendWelcomeEmail
// ---------------------------------------------------------------------------

/**
 * Sent when a student self-registers.
 *
 * Content is compliance-critical: the pricing/discount breakdown, evidence
 * requirements, gap training notice, scope-of-role disclaimer and the attached
 * ASQA Fact Sheet must all be present. Do not trim sections.
 *
 * @param {{ firstName: string, email: string }} student
 * @param {{ applicationId: string, qualificationId?: any, qualificationName?: string, price?: number }} application
 */
const sendWelcomeEmail = async (student, application) => {
  try {
    const paymentUrl = `${BASE_URL}/student/payments`;

    // Resolve qualification name + price for the details table. The caller may have
    // hydrated them already; otherwise look them up from the qualification.
    let qualificationName = application.qualificationName;
    let price = application.price;

    if ((!qualificationName || price == null) && application.qualificationId) {
      const Qualification = require('../models/Qualification');
      const qual = await Qualification.findById(application.qualificationId)
        .select('name caPrice')
        .lean();
      if (qual) {
        qualificationName = qualificationName || qual.name;
        price = price != null ? price : qual.caPrice;
      }
    }

    const money = (amount) => `$${Number(amount).toLocaleString()}`;
    const hasPricing = price != null && !Number.isNaN(Number(price));

    // Use the discount actually recorded on the application (authService writes the
    // signup discount at registration). Fall back to the standard amount only if the
    // caller passed an application without its discounts array.
    const discountTotal = Array.isArray(application.discounts)
      ? application.discounts.reduce((sum, d) => sum + (d.amount || 0), 0)
      : SIGNUP_DISCOUNT_AMOUNT;
    const hasDiscount = discountTotal > 0;
    const discountedPrice = hasPricing
      ? Math.max(0, Number(price) - discountTotal)
      : null;

    const body =
      greeting(student.firstName) +
      heading2('Welcome to Certified Australia!') +
      paragraph(
        "We're thrilled to see you taking this important step in your career journey &#127881; " +
        'Your registration has been successfully completed.'
      ) +
      detailsTable('Your Application Details', [
        { label: 'Application ID', value: application.applicationId },
        { label: 'Qualification', value: qualificationName || '&mdash;' },
        ...(hasPricing && hasDiscount
          ? [
              {
                label: 'Usual Price',
                value: `<span style="text-decoration:line-through;color:#888;">${money(price)}</span>`,
              },
              {
                label: 'Discount',
                value: `<span style="color:#0a9d42;font-weight:700;">- ${money(discountTotal)} &#127881;</span>`,
              },
              {
                label: 'New Cost',
                value: `<span style="color:#0a9d42;font-weight:700;font-size:16px;">${money(discountedPrice)}</span>`,
              },
            ]
          : []),
        ...(hasPricing && !hasDiscount
          ? [{ label: 'Price', value: money(price) }]
          : []),
      ]) +
      paragraph(
        'Thank you for taking the next step toward formal recognition of your skills and experience.'
      ) +
      buttonGroup({ text: 'Make Payment & Continue', url: paymentUrl }) +
      paragraph(
        'Thank you for choosing us to support your journey. Our team is here to assist you every step of the way, ' +
        'ensuring a seamless experience and providing the resources you need to achieve your goals &#128640;'
      ) +
      heading2('Why Choose RPL with Certified Australia?') +
      bulletList([
        '<strong>Save Time and Money &#128176;</strong> &ndash; Achieve recognition for your existing skills without unnecessary training',
        '<strong>Career Advancement &#128200;</strong> &ndash; Strengthen your professional profile and meet industry standards',
        '<strong>Personalised Support &#129309;</strong> &ndash; Our dedicated team will assist you through every step of the process',
      ]) +
      divider() +

      // --- Certified Now. Pay Later. -----------------------------------------
      heading2('Certified Now. Pay Later. &#128179;') +
      paragraph(
        'We understand that investing in your future should be structured and manageable.'
      ) +
      paragraph(
        'Through our <strong>Certified Now. Pay Later.</strong> option, we offer flexible payment plans to help you ' +
        'commence immediately while spreading your investment over time.'
      ) +
      infoCard('You can:', [
        'Lock in your intake position',
        'Begin your RPL process',
        'Start submitting your evidence',
        'Pay through an approved structured plan',
      ]) +
      paragraph(
        'If you would like to explore a payment arrangement, simply select the option below and our team will assist you.'
      ) +
      buttonGroup({ text: 'Certified Now. Pay Later.', url: paymentUrl }) +
      divider() +

      // --- What happens next -------------------------------------------------
      heading2('What Happens Next &#128204;') +
      numberedList([
        'You will receive access to your student portal',
        'Upload required documentation',
        'Complete the RPL kit',
        'Assessment conducted by the partnered RTO',
        'Outcome issued by the RTO',
      ]) +
      divider() +

      // --- Documents and evidence -------------------------------------------
      heading2('Documents and Evidence You Will Need &#128196;') +
      paragraph(
        'Recognition of Prior Learning is a formal assessment process. It is not automatic and requires sufficient ' +
        'evidence demonstrating competency against each unit of competency.'
      ) +
      paragraph('You will be required to provide the following:') +

      heading3('1. Identification &amp; Compliance Requirements &#129506;') +
      bulletList([
        '100 Points of ID (Passport, Driver Licence, Medicare)',
        'USI Number',
        'Visa documentation (if applicable)',
        'Contact and residential details',
      ]) +
      paragraph(
        'These documents are required for enrolment validation and regulatory compliance purposes.'
      ) +

      heading3('2. Completion of the RPL Kit &#128221;') +
      paragraph('You must complete the full RPL assessment kit, including:') +
      bulletList([
        'Self-assessment questionnaire',
        'Knowledge questions',
        'Evidence mapping responses',
        'Competency conversation (if required by the assessor)',
      ]) +
      paragraph('This forms part of your formal assessment record.') +

      heading3('3. RPL Evidence Requirements &#128736;&#65039;') +
      paragraph('Your evidence must demonstrate competency through multiple sources.') +
      paragraph('<strong>A. Direct Evidence</strong>') +
      bulletList([
        'Workplace photos',
        'Workplace videos',
        'Job documentation',
        'Completed project examples',
      ]) +
      paragraph('<strong>B. Indirect Evidence</strong>') +
      bulletList([
        'Resume',
        'Work history',
        'Position descriptions',
        'Licences held',
      ]) +
      paragraph('<strong>C. Third Party Evidence</strong>') +
      bulletList([
        'Employer testimonials',
        'Supervisor verification letters',
        'Client reference statements',
      ]) +
      paragraph('<strong>D. Supporting Evidence</strong>') +
      bulletList([
        'Proof of employment (payslips, contracts, ABN records if applicable)',
        'Apprenticeship or prior training transcripts',
        'Safety certifications',
        'Logbooks',
      ]) +

      heading3('4. Gap Training (If Required) &#128269;') +
      paragraph(
        'If, following assessment, the partnered RTO identifies competency gaps, you may be required to:'
      ) +
      bulletList([
        'Complete structured gap training',
        'Undertake practical demonstration',
        'Complete further knowledge assessment',
      ]) +
      paragraph(
        'A qualification can only be issued once the RTO is satisfied that all unit requirements have been met &#9989;'
      ) +
      divider() +

      // --- Scope of our role -------------------------------------------------
      heading2('Important Information About Our Role &#9878;&#65039;') +
      paragraph(
        'Certified Australia operates as a digital education platform that facilitates the connection between students ' +
        'and partnered Registered Training Organisations (RTOs) for the purpose of skills recognition, certification and training.'
      ) +
      warningCard(
        '',
        '<strong>Certified Australia is not a Registered Training Organisation (RTO) and does not issue qualifications.</strong>'
      ) +
      paragraph(
        'All assessments are conducted by qualified assessors engaged by the partnered RTO. The final determination of ' +
        'competency and the issuance of any qualification rests solely with the RTO in accordance with:'
      ) +
      bulletList([
        'The relevant Training Package requirements',
        'The Standards for RTOs',
        'ASQA regulatory framework',
      ]) +
      paragraph(
        'We provide administrative support, digital tools and structured guidance throughout the process to ensure your ' +
        'application is complete and compliant.'
      ) +

      heading3('ASQA Fact Sheet &ndash; Recognition of Prior Learning &#128218;') +
      paragraph(
        'As part of our commitment to transparency and compliance, we have attached the ASQA Fact Sheet for Students &ndash; ' +
        'Recognition of Prior Learning (Version 1.0 April 2025).'
      ) +
      paragraph('This document explains:') +
      bulletList([
        'What quality RPL assessment looks like',
        'The importance of evidence mapping',
        'Student rights and responsibilities',
        'Risks of inadequate or misleading RPL practices',
      ]) +
      paragraph(
        'We encourage you to review this carefully so you understand how your experience will be formally assessed.'
      ) +
      paragraph(
        'We are committed to ensuring your assessment is conducted properly, ethically and in accordance with national standards.'
      ) +
      paragraph(
        'If you have any questions about the process, please contact our support team.'
      ) +
      signOff();

    const html = buildEmail(
      body,
      'Your registration is complete — here is everything you need to get certified.'
    );

    return await sendEmail({
      to: student.email,
      subject: `🎉 Congratulations ${student.firstName}! You're Just a Few Steps Away from Getting Certified`,
      html,
      attachments: [ASQA_FACT_SHEET],
    });
  } catch (err) {
    console.error('[applicationEmailService] sendWelcomeEmail error:', err.message);
    return { success: false };
  }
};

// ---------------------------------------------------------------------------
// 2. sendAgentWelcomeEmail
// ---------------------------------------------------------------------------

/**
 * Sent to a student when an agent registers them.
 * @param {{ firstName: string, email: string }} student
 * @param {{ applicationId: string, qualificationName?: string, price?: number }} application
 * @param {{ firstName: string, lastName: string }} agent
 */
const sendAgentWelcomeEmail = async (student, application, agent) => {
  try {
    const loginUrl = `${BASE_URL}/login`;

    const body =
      greeting(student.firstName) +
      heading2('Welcome to Certified Australia') +
      paragraph(
        `Your RPL application has been created by your agent, ` +
        `<strong>${agent.firstName} ${agent.lastName}</strong>. ` +
        'We look forward to helping you achieve your qualification through Recognised Prior Learning.'
      ) +
      detailsTable('Application Details', [
        { label: 'Application ID', value: application.applicationId },
        {
          label: 'Qualification',
          value: application.qualificationName || '—',
        },
        {
          label: 'Total Price',
          value: application.price != null ? formatAUD(application.price) : '—',
        },
      ]) +
      paragraph(
        'To access your student portal, click the button below and log in with the credentials provided by your agent. ' +
        'From there you can track your application progress, complete your intake form, and upload your documents.'
      ) +
      buttonGroup({ text: 'Login to Portal', url: loginUrl }) +
      infoCard('What Happens Next?', [
        'Log in and complete your Student Intake Form.',
        'Upload your supporting documents and evidence.',
        'Make your payment to progress to assessment.',
        'Your agent will keep you updated throughout the process.',
      ]) +
      signOff();

    const html = buildEmail(
      body,
      'Your RPL application has been created — log in to get started.'
    );

    return await sendEmail({
      to: student.email,
      subject: 'Welcome to Certified Australia',
      html,
    });
  } catch (err) {
    console.error('[applicationEmailService] sendAgentWelcomeEmail error:', err.message);
    return { success: false };
  }
};

// ---------------------------------------------------------------------------
// 3. sendAdminNewRegistrationEmail
// ---------------------------------------------------------------------------

/**
 * Notifies admin / CEO whenever a new application is created.
 * @param {{ firstName: string, lastName: string, email: string, phone?: string }} student
 * @param {{ applicationId: string, qualificationName?: string, industryName?: string }} application
 * @param {{ firstName: string, lastName: string } | 'self'} registeredBy - Agent object or 'self'
 */
const sendAdminNewRegistrationEmail = async (student, application, registeredBy) => {
  try {
    const viewUrl = `${BASE_URL}/admin/applications/${application.applicationId}`;

    const registeredByText =
      registeredBy === 'self'
        ? 'Self-registered via portal'
        : typeof registeredBy === 'object'
        ? `${registeredBy.firstName} ${registeredBy.lastName} (Agent)`
        : String(registeredBy);

    const body =
      heading2('New User Registration') +
      paragraph(
        `A new student has registered and an application has been created. ` +
        `Please review and assign an agent if required.`
      ) +
      detailsTable('Registration Details', [
        { label: 'Application ID', value: application.applicationId },
        {
          label: 'Student Name',
          value: `${student.firstName} ${student.lastName}`,
        },
        { label: 'Email', value: student.email },
        { label: 'Phone', value: student.phone || '—' },
        {
          label: 'Qualification',
          value: application.qualificationName || '—',
        },
        { label: 'Industry', value: application.industryName || '—' },
        { label: 'Registered By', value: registeredByText },
        { label: 'Date', value: formatDateTime(new Date()) },
      ]) +
      buttonGroup({ text: 'View Application', url: viewUrl }) +
      signOff();

    const html = buildEmail(
      body,
      `New registration: ${student.firstName} ${student.lastName} — ${application.applicationId}`
    );

    return await sendEmail({
      to: [ADMIN_EMAIL, CEO_EMAIL],
      subject: `New User Registration - ${application.applicationId}`,
      html,
    });
  } catch (err) {
    console.error('[applicationEmailService] sendAdminNewRegistrationEmail error:', err.message);
    return { success: false };
  }
};

// ---------------------------------------------------------------------------
// 4. sendPaymentReceivedEmail
// ---------------------------------------------------------------------------

/**
 * Sent to student after any successful payment (upfront / plan / manual).
 * Internally calls checkAndSendCompletionEmail after sending.
 * @param {{ firstName: string, email: string }} student
 * @param {{ applicationId: string }} application
 * @param {{ amount: number, paymentMethod: string, squareTransactionId?: string, manualPaymentReference?: string, createdAt?: Date }} payment
 */
const sendPaymentReceivedEmail = async (student, application, payment) => {
  try {
    const paymentsUrl = `${BASE_URL}/student/payments`;

    const txId =
      payment.squareTransactionId ||
      payment.manualPaymentReference ||
      payment.squarePaymentId ||
      '—';

    const methodLabel =
      payment.paymentMethod === 'square'
        ? 'Card (Square)'
        : payment.paymentMethod === 'directDebit'
        ? 'Direct Debit'
        : payment.paymentMethod === 'manual'
        ? 'Manual / Bank Transfer'
        : cap(payment.paymentMethod);

    const body =
      greeting(student.firstName) +
      successCard(
        'Payment Received',
        `We have received your payment of <strong>${formatAUD(payment.amount)}</strong>. Thank you!`
      ) +
      detailsTable('Payment Details', [
        { label: 'Application ID', value: application.applicationId },
        { label: 'Amount Paid', value: formatAUD(payment.amount) },
        { label: 'Payment Method', value: methodLabel },
        { label: 'Transaction ID', value: txId },
        { label: 'Date', value: formatDateTime(payment.createdAt || new Date()) },
      ]) +
      paragraph(
        'Please keep this email as your payment receipt. ' +
        'You can view your full payment history inside the student portal.'
      ) +
      buttonGroup({ text: 'View Payments', url: paymentsUrl }) +
      signOff();

    const html = buildEmail(
      body,
      `Payment of ${formatAUD(payment.amount)} received for ${application.applicationId}.`
    );

    const result = await sendEmail({
      to: student.email,
      subject: `Payment Confirmation - ${application.applicationId}`,
      html,
    });

    // Non-blocking completion check
    checkAndSendCompletionEmail(application).catch((e) =>
      console.error('[applicationEmailService] checkAndSendCompletionEmail error:', e.message)
    );

    return result;
  } catch (err) {
    console.error('[applicationEmailService] sendPaymentReceivedEmail error:', err.message);
    return { success: false };
  }
};

// ---------------------------------------------------------------------------
// 5. sendAdminPaymentNotification
// ---------------------------------------------------------------------------

/**
 * Notifies admin/CEO of a received payment.
 * @param {{ firstName: string, lastName: string, email: string }} student
 * @param {{ applicationId: string }} application
 * @param {{ amount: number, paymentMethod: string, type: string, createdAt?: Date }} payment
 * @param {boolean} isFullPayment
 */
const sendAdminPaymentNotification = async (
  student,
  application,
  payment,
  isFullPayment
) => {
  try {
    const viewUrl = `${BASE_URL}/admin/applications/${application.applicationId}`;
    const label = isFullPayment ? 'Full' : 'Partial';

    const methodLabel =
      payment.paymentMethod === 'square'
        ? 'Card (Square)'
        : payment.paymentMethod === 'directDebit'
        ? 'Direct Debit'
        : 'Manual / Bank Transfer';

    const rows = [
      { label: 'Application ID', value: application.applicationId },
      {
        label: 'Student',
        value: `${student.firstName} ${student.lastName}`,
      },
      { label: 'Email', value: student.email },
      { label: 'Amount Received', value: formatAUD(payment.amount) },
      { label: 'Payment Type', value: cap(payment.type) },
      { label: 'Method', value: methodLabel },
      { label: 'Date', value: formatDateTime(payment.createdAt || new Date()) },
    ];

    if (!isFullPayment && payment.remainingBalance != null) {
      rows.push({ label: 'Remaining Balance', value: formatAUD(payment.remainingBalance) });
    }

    const body =
      heading2(`${label} Payment Received`) +
      paragraph(
        `A ${label.toLowerCase()} payment has been received for application ` +
        `<strong>${application.applicationId}</strong>.`
      ) +
      detailsTable('Payment Details', rows) +
      buttonGroup({ text: 'View Application', url: viewUrl }) +
      signOff();

    const html = buildEmail(
      body,
      `${label} payment of ${formatAUD(payment.amount)} received.`
    );

    return await sendEmail({
      to: [ADMIN_EMAIL, CEO_EMAIL],
      subject: `${label} Payment Received - ${application.applicationId}`,
      html,
    });
  } catch (err) {
    console.error('[applicationEmailService] sendAdminPaymentNotification error:', err.message);
    return { success: false };
  }
};

// ---------------------------------------------------------------------------
// 6. sendPaymentPlanCreatedEmail
// ---------------------------------------------------------------------------

/**
 * Sent to student when admin creates a payment plan.
 * @param {{ firstName: string, email: string }} student
 * @param {{ applicationId: string }} application
 * @param {{ totalAmount: number, installments: Array, status: string }} plan
 */
const sendPaymentPlanCreatedEmail = async (student, application, plan) => {
  try {
    const paymentsUrl = `${BASE_URL}/student/payments`;
    const installments = plan.installments || [];
    const count = installments.length;
    const firstInstallment = installments[0] || {};

    // Determine frequency from first two installments (if available)
    let frequency = 'Flexible';
    if (installments.length >= 2) {
      const diffMs =
        new Date(installments[1].dueDate) - new Date(installments[0].dueDate);
      const diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24));
      if (diffDays <= 8) frequency = 'Weekly';
      else if (diffDays <= 17) frequency = 'Fortnightly';
      else frequency = 'Monthly';
    }

    const body =
      greeting(student.firstName) +
      heading2('Payment Plan Created') +
      paragraph(
        'Great news! A payment plan has been set up for your application. ' +
        'You can view your instalment schedule and make payments anytime from the portal.'
      ) +
      detailsTable('Payment Plan Details', [
        { label: 'Application ID', value: application.applicationId },
        { label: 'Total Amount', value: formatAUD(plan.totalAmount) },
        { label: 'Instalments', value: String(count) },
        { label: 'Frequency', value: frequency },
        {
          label: 'First Instalment',
          value: formatAUD(firstInstallment.amount),
        },
        {
          label: 'First Due Date',
          value: formatDate(firstInstallment.dueDate),
        },
      ]) +
      infoCard('What You Need to Do', [
        'Log in to your student portal to view your full instalment schedule.',
        'Ensure your payment method is up to date.',
        'Make each payment on or before the due date to avoid overdue fees.',
        'Contact us immediately if you are unable to make a payment.',
      ]) +
      buttonGroup({ text: 'View Payment Plan', url: paymentsUrl }) +
      signOff();

    const html = buildEmail(
      body,
      `Your payment plan is ready — ${count} instalments of ${formatAUD(firstInstallment.amount)}.`
    );

    return await sendEmail({
      to: student.email,
      subject: `Payment Plan Created - ${application.applicationId}`,
      html,
    });
  } catch (err) {
    console.error('[applicationEmailService] sendPaymentPlanCreatedEmail error:', err.message);
    return { success: false };
  }
};

// ---------------------------------------------------------------------------
// 7. sendDiscountAppliedEmail
// ---------------------------------------------------------------------------

/**
 * Sent to student when a discount is applied to their application.
 * @param {{ firstName: string, email: string }} student
 * @param {{ applicationId: string }} application
 * @param {number} originalPrice
 * @param {number} discount
 * @param {number} newPrice
 */
const sendDiscountAppliedEmail = async (
  student,
  application,
  originalPrice,
  discount,
  newPrice
) => {
  try {
    const viewUrl = `${BASE_URL}/student/dashboard`;

    const body =
      greeting(student.firstName) +
      successCard(
        'Discount Applied',
        `A discount of <strong>${formatAUD(discount)}</strong> has been applied to your application. ` +
        'Your updated balance is shown below.'
      ) +
      detailsTable('Pricing Summary', [
        { label: 'Application ID', value: application.applicationId },
        { label: 'Original Price', value: formatAUD(originalPrice) },
        { label: 'Discount', value: `− ${formatAUD(discount)}` },
        { label: 'New Price', value: formatAUD(newPrice) },
      ]) +
      paragraph(
        'Please log in to your portal to view your updated payment details.'
      ) +
      buttonGroup({ text: 'View Application', url: viewUrl }) +
      signOff();

    const html = buildEmail(
      body,
      `A discount of ${formatAUD(discount)} has been applied to your application.`
    );

    return await sendEmail({
      to: student.email,
      subject: `Discount Applied - ${application.applicationId}`,
      html,
    });
  } catch (err) {
    console.error('[applicationEmailService] sendDiscountAppliedEmail error:', err.message);
    return { success: false };
  }
};

// ---------------------------------------------------------------------------
// 8. sendPaymentPlanStatusEmail
// ---------------------------------------------------------------------------

/**
 * Sent when a payment plan is paused, resumed, or cancelled.
 * @param {{ firstName: string, email: string }} student
 * @param {{ applicationId: string }} application
 * @param {{ totalAmount: number, installments: Array, status: string }} plan
 * @param {'paused'|'resumed'|'cancelled'} statusChange
 * @param {string} [reason]
 */
const sendPaymentPlanStatusEmail = async (
  student,
  application,
  plan,
  statusChange,
  reason
) => {
  try {
    const paymentsUrl = `${BASE_URL}/student/payments`;
    const installments = plan.installments || [];
    const paidCount = installments.filter((i) => i.status === 'paid').length;
    const remaining = installments.length - paidCount;

    const statusLabels = {
      paused: 'Paused',
      resumed: 'Resumed',
      cancelled: 'Cancelled',
    };
    const label = statusLabels[statusChange] || cap(statusChange);

    const cardFn =
      statusChange === 'cancelled'
        ? dangerCard
        : statusChange === 'paused'
        ? warningCard
        : successCard;

    const cardMessages = {
      paused:
        'Your payment plan has been temporarily paused. No automatic debits will occur during this period. ' +
        'Please contact us if you have questions.',
      resumed:
        'Your payment plan has been resumed. Automatic debits will continue as scheduled. ' +
        'Please ensure your payment details are up to date.',
      cancelled:
        'Your payment plan has been cancelled. Please contact us to discuss alternative payment arrangements ' +
        'or if you believe this is an error.',
    };

    const rows = [
      { label: 'Application ID', value: application.applicationId },
      { label: 'Total Amount', value: formatAUD(plan.totalAmount) },
      { label: 'Instalments Paid', value: String(paidCount) },
      { label: 'Remaining Instalments', value: String(remaining) },
      { label: 'Plan Status', value: label },
    ];

    if (reason) {
      rows.push({ label: 'Reason', value: reason });
    }

    const body =
      greeting(student.firstName) +
      cardFn(`Payment Plan ${label}`, cardMessages[statusChange] || '') +
      detailsTable('Plan Details', rows) +
      buttonGroup({ text: 'View Payment Plan', url: paymentsUrl }) +
      signOff();

    const html = buildEmail(
      body,
      `Your payment plan has been ${statusChange}.`
    );

    return await sendEmail({
      to: student.email,
      subject: `Payment Plan ${label} - ${application.applicationId}`,
      html,
    });
  } catch (err) {
    console.error('[applicationEmailService] sendPaymentPlanStatusEmail error:', err.message);
    return { success: false };
  }
};

// ---------------------------------------------------------------------------
// 9. sendManualMarkPaidEmail
// ---------------------------------------------------------------------------

/**
 * Sent when admin manually marks a payment as received.
 * @param {{ firstName: string, email: string }} student
 * @param {{ applicationId: string }} application
 * @param {number} amount
 * @param {string} method - e.g. 'Bank Transfer', 'Cash', 'Cheque'
 */
const sendManualMarkPaidEmail = async (student, application, amount, method) => {
  try {
    const viewUrl = `${BASE_URL}/student/payments`;

    const body =
      greeting(student.firstName) +
      successCard(
        'Payment Confirmed',
        `Your payment of <strong>${formatAUD(amount)}</strong> has been manually confirmed by our team.`
      ) +
      detailsTable('Payment Details', [
        { label: 'Application ID', value: application.applicationId },
        { label: 'Amount', value: formatAUD(amount) },
        { label: 'Method', value: method || 'Manual' },
        { label: 'Confirmed On', value: formatDateTime(new Date()) },
      ]) +
      paragraph(
        'Please keep this email as your payment receipt. ' +
        'You can view your full payment history inside the student portal.'
      ) +
      buttonGroup({ text: 'View Payments', url: viewUrl }) +
      signOff();

    const html = buildEmail(
      body,
      `Your payment of ${formatAUD(amount)} has been confirmed.`
    );

    return await sendEmail({
      to: student.email,
      subject: `Payment Confirmation - ${application.applicationId}`,
      html,
    });
  } catch (err) {
    console.error('[applicationEmailService] sendManualMarkPaidEmail error:', err.message);
    return { success: false };
  }
};

// ---------------------------------------------------------------------------
// 10. sendApplicationCompleteEmail
// ---------------------------------------------------------------------------

/**
 * Sent to student when SIF + docs + payment are all complete.
 * @param {{ firstName: string, email: string }} student
 * @param {{ applicationId: string, intakeFormSubmitted?: boolean, documentsUploaded?: boolean, paymentCompleted?: boolean }} application
 */
const sendApplicationCompleteEmail = async (student, application) => {
  try {
    const viewUrl = `${BASE_URL}/student/dashboard`;

    const body =
      greeting(student.firstName) +
      successCard(
        'Application Complete',
        'All requirements have been met! Your application has been submitted for review by our team. ' +
        'We will be in touch with the next steps shortly.'
      ) +
      heading2('Completion Checklist') +
      statusTable(
        statusItem('Student Intake Form', 'Submitted', application.intakeFormSubmitted !== false) +
        statusItem('Supporting Documents', 'Uploaded', application.documentsUploaded !== false) +
        statusItem('Payment', 'Confirmed', application.paymentCompleted !== false)
      ) +
      paragraph(
        'Your application is now under review. Our team will assess your documentation and ' +
        'contact you if any additional information is required. This process typically takes ' +
        'up to <strong>21 business days</strong>.'
      ) +
      buttonGroup({ text: 'View Application', url: viewUrl }) +
      signOff();

    const html = buildEmail(
      body,
      'Your RPL application is complete and has been submitted for review.'
    );

    return await sendEmail({
      to: student.email,
      subject: `Application Complete - Submitted for Approval`,
      html,
    });
  } catch (err) {
    console.error('[applicationEmailService] sendApplicationCompleteEmail error:', err.message);
    return { success: false };
  }
};

// ---------------------------------------------------------------------------
// 11. sendRTOApplicationCompleteEmail
// ---------------------------------------------------------------------------

/**
 * Notifies all InternalRTO users when an application is fully complete.
 * @param {{ firstName: string, lastName: string, email: string }} student
 * @param {{ applicationId: string, qualificationName?: string }} application
 */
const sendRTOApplicationCompleteEmail = async (student, application) => {
  try {
    // Lazy-require to avoid circular deps at module load time
    const User = require('../models/User');

    const rtoUsers = await User.find({ role: 'InternalRTO', status: 'active' })
      .select('email firstName')
      .lean();

    if (!rtoUsers || rtoUsers.length === 0) {
      console.warn('[applicationEmailService] sendRTOApplicationCompleteEmail: no active RTO users found.');
      return { success: true };
    }

    const reviewUrl = `${BASE_URL}/rto/applications/${application.applicationId}`;

    const body =
      heading2('New Completed Application Ready for Review') +
      paragraph(
        `A student application has met all requirements and is ready for RTO assessment.`
      ) +
      detailsTable('Application Details', [
        { label: 'Application ID', value: application.applicationId },
        {
          label: 'Student Name',
          value: `${student.firstName} ${student.lastName}`,
        },
        { label: 'Student Email', value: student.email },
        {
          label: 'Qualification',
          value: application.qualificationName || '—',
        },
        { label: 'Submitted', value: formatDateTime(new Date()) },
      ]) +
      statusTable(
        statusItem('Student Intake Form', 'Submitted', true) +
        statusItem('Supporting Documents', 'Uploaded', true) +
        statusItem('Payment', 'Confirmed', true)
      ) +
      buttonGroup({ text: 'Review Application', url: reviewUrl }) +
      signOff();

    const html = buildEmail(
      body,
      `New completed application ready for RTO review — ${application.applicationId}.`
    );

    const rtoEmails = rtoUsers.map((u) => u.email);

    return await sendEmail({
      to: rtoEmails,
      subject: `New Completed Application Ready for Review`,
      html,
    });
  } catch (err) {
    console.error('[applicationEmailService] sendRTOApplicationCompleteEmail error:', err.message);
    return { success: false };
  }
};

// ---------------------------------------------------------------------------
// 12. sendPaymentFailureEmail
// ---------------------------------------------------------------------------

/**
 * Sent to student when an auto-debit attempt fails.
 * @param {{ firstName: string, email: string }} student
 * @param {{ applicationId: string }} application
 * @param {{ index?: number, amount: number }} installment
 * @param {string} errorMessage
 */
const sendPaymentFailureEmail = async (student, application, installment, errorMessage) => {
  try {
    const paymentsUrl = `${BASE_URL}/student/payments`;

    const body =
      greeting(student.firstName) +
      dangerCard(
        'Payment Failed',
        'We were unable to process your scheduled payment. Please update your payment method or ' +
        'contact us immediately to avoid delays to your application.'
      ) +
      detailsTable('Failed Payment Details', [
        { label: 'Application ID', value: application.applicationId },
        {
          label: 'Instalment',
          value: installment.index != null ? `#${installment.index + 1}` : '—',
        },
        { label: 'Amount', value: formatAUD(installment.amount) },
        { label: 'Failure Reason', value: errorMessage || 'Payment declined' },
        { label: 'Date', value: formatDateTime(new Date()) },
      ]) +
      paragraph(
        'Please log in to update your payment method or contact our team to make alternative payment arrangements.'
      ) +
      buttonGroup({ text: 'Update Payment Method', url: paymentsUrl }) +
      signOff();

    const html = buildEmail(
      body,
      `Your scheduled payment of ${formatAUD(installment.amount)} could not be processed.`
    );

    return await sendEmail({
      to: student.email,
      subject: `Payment Failed - ${application.applicationId}`,
      html,
    });
  } catch (err) {
    console.error('[applicationEmailService] sendPaymentFailureEmail error:', err.message);
    return { success: false };
  }
};

// ---------------------------------------------------------------------------
// 13. sendPaymentOverdueEmail
// ---------------------------------------------------------------------------

/**
 * Sent when an overdue payment is detected.
 * @param {{ firstName: string, email: string }} student
 * @param {{ applicationId: string }} application
 * @param {{ index?: number, amount: number, dueDate?: Date }} installment
 * @param {number} daysOverdue
 */
const sendPaymentOverdueEmail = async (student, application, installment, daysOverdue) => {
  try {
    const paymentsUrl = `${BASE_URL}/student/payments`;

    const body =
      greeting(student.firstName) +
      dangerCard(
        'Overdue Payment Notice',
        `You have a payment that is <strong>${daysOverdue} day${daysOverdue === 1 ? '' : 's'} overdue</strong>. ` +
        'Please make this payment as soon as possible to keep your application on track.'
      ) +
      detailsTable('Overdue Payment Details', [
        { label: 'Application ID', value: application.applicationId },
        {
          label: 'Instalment',
          value: installment.index != null ? `#${installment.index + 1}` : '—',
        },
        { label: 'Amount Due', value: formatAUD(installment.amount) },
        { label: 'Due Date', value: formatDate(installment.dueDate) },
        { label: 'Days Overdue', value: String(daysOverdue) },
      ]) +
      paragraph(
        'If you are experiencing financial difficulties, please contact our team as soon as possible ' +
        'so we can work with you on a suitable arrangement.'
      ) +
      buttonGroup({ text: 'Make Payment', url: paymentsUrl }) +
      signOff();

    const html = buildEmail(
      body,
      `You have an overdue payment of ${formatAUD(installment.amount)} for ${application.applicationId}.`
    );

    return await sendEmail({
      to: student.email,
      subject: `Payment Overdue - ${application.applicationId}`,
      html,
    });
  } catch (err) {
    console.error('[applicationEmailService] sendPaymentOverdueEmail error:', err.message);
    return { success: false };
  }
};

// ---------------------------------------------------------------------------
// 14. sendDocumentFeedbackEmail
// ---------------------------------------------------------------------------

/**
 * Sent when admin/RTO provides feedback on a document.
 * @param {{ firstName: string, email: string }} student
 * @param {{ applicationId: string }} application
 * @param {string} documentName
 * @param {string} feedback
 * @param {{ firstName: string, lastName: string }} sender
 */
const sendDocumentFeedbackEmail = async (
  student,
  application,
  documentName,
  feedback,
  sender
) => {
  try {
    const docsUrl = `${BASE_URL}/student/documents`;

    const senderName =
      sender && sender.firstName
        ? `${sender.firstName} ${sender.lastName}`
        : 'The Certified Australia Team';

    const body =
      greeting(student.firstName) +
      warningCard(
        'Document Correction Required',
        `A correction has been requested for one of your uploaded documents. ` +
        `Please review the feedback below and re-upload the corrected document.`
      ) +
      detailsTable('Document Details', [
        { label: 'Application ID', value: application.applicationId },
        { label: 'Document', value: documentName },
        { label: 'Reviewed By', value: senderName },
        { label: 'Date', value: formatDateTime(new Date()) },
      ]) +
      heading2('Feedback') +
      personalMessage(feedback, senderName) +
      paragraph(
        'Please log in to your student portal, locate the document, and upload a corrected version.'
      ) +
      buttonGroup({ text: 'View Documents', url: docsUrl }) +
      signOff();

    const html = buildEmail(
      body,
      `Action required: feedback on your document "${documentName}".`
    );

    return await sendEmail({
      to: student.email,
      subject: `Document Correction Required - ${application.applicationId}`,
      html,
    });
  } catch (err) {
    console.error('[applicationEmailService] sendDocumentFeedbackEmail error:', err.message);
    return { success: false };
  }
};

// ---------------------------------------------------------------------------
// 15. sendSupportTicketReplyEmail
// ---------------------------------------------------------------------------

/**
 * Sent to student when admin replies to their support ticket.
 * @param {{ firstName: string, email: string }} student
 * @param {{ _id: string, title?: string, subject?: string }} ticket
 */
const sendSupportTicketReplyEmail = async (student, ticket) => {
  try {
    const ticketTitle = ticket.title || ticket.subject || 'Your Ticket';
    const ticketUrl = `${BASE_URL}/student/support/${ticket._id}`;

    const body =
      greeting(student.firstName) +
      heading2('New Reply on Your Support Ticket') +
      paragraph(
        `Our support team has replied to your ticket: <strong>${ticketTitle}</strong>.`
      ) +
      infoCard('View your reply in the portal', [
        'Log in to your student portal to read the full reply.',
        'You can respond directly within the ticket thread.',
        'Our team is here to help — do not hesitate to ask follow-up questions.',
      ]) +
      buttonGroup({ text: 'View Ticket', url: ticketUrl }) +
      signOff();

    const html = buildEmail(
      body,
      `You have a new reply on your support ticket: ${ticketTitle}.`
    );

    return await sendEmail({
      to: student.email,
      subject: `New Reply on Your Support Ticket - ${ticketTitle}`,
      html,
    });
  } catch (err) {
    console.error('[applicationEmailService] sendSupportTicketReplyEmail error:', err.message);
    return { success: false };
  }
};

// ---------------------------------------------------------------------------
// 16. sendDynamicFormsEnabledEmail
// ---------------------------------------------------------------------------

/**
 * Sent to student when admin enables dynamic assessment forms.
 * @param {{ firstName: string, email: string }} student
 * @param {{ applicationId: string }} application
 * @param {Array<{ name?: string, title?: string }>} forms
 */
const sendDynamicFormsEnabledEmail = async (student, application, forms) => {
  try {
    const formsUrl = `${BASE_URL}/student/forms`;
    const formNames = (forms || []).map((f) => f.name || f.title || 'Assessment Form');

    const body =
      greeting(student.firstName) +
      heading2('Assessment Forms Are Now Available') +
      paragraph(
        'Your assessor has made assessment forms available for your application. ' +
        'Please complete these forms at your earliest convenience to progress your application.'
      ) +
      infoCard(
        `${formNames.length} Form${formNames.length === 1 ? '' : 's'} to Complete`,
        formNames.length > 0 ? formNames : ['Please log in to view available forms.']
      ) +
      paragraph(
        'Take your time with each form and answer honestly based on your genuine work experience and knowledge. ' +
        'If you are unsure about any question, use the Support section to ask for guidance.'
      ) +
      buttonGroup({ text: 'Complete Forms', url: formsUrl }) +
      signOff();

    const html = buildEmail(
      body,
      `${formNames.length} assessment form${formNames.length === 1 ? '' : 's'} available for ${application.applicationId}.`
    );

    return await sendEmail({
      to: student.email,
      subject: `Assessment Forms Available - ${application.applicationId}`,
      html,
    });
  } catch (err) {
    console.error('[applicationEmailService] sendDynamicFormsEnabledEmail error:', err.message);
    return { success: false };
  }
};

// ---------------------------------------------------------------------------
// 17. sendThirdPartySubmissionConfirmEmail
// ---------------------------------------------------------------------------

/**
 * Sent to the third party (referee/employer) after they submit a reference form.
 * @param {string} recipientEmail
 * @param {string} recipientName
 * @param {string} studentName
 * @param {string} formName
 */
const sendThirdPartySubmissionConfirmEmail = async (
  recipientEmail,
  recipientName,
  studentName,
  formName
) => {
  try {
    const body =
      greeting(recipientName) +
      successCard(
        'Thank You for Completing the Reference Form',
        `Your submission for <strong>${studentName}</strong> has been received successfully. ` +
        'No further action is required from you at this time.'
      ) +
      detailsTable('Submission Summary', [
        { label: 'Form', value: formName },
        { label: 'Submitted For', value: studentName },
        { label: 'Submitted By', value: recipientName },
        { label: 'Date & Time', value: formatDateTime(new Date()) },
      ]) +
      paragraph(
        'Your input plays an important role in supporting the RPL (Recognised Prior Learning) process. ' +
        'Thank you for taking the time to complete this form.'
      ) +
      divider() +
      smallText(
        'This email is a confirmation receipt. You do not need to take any further action. ' +
        'If you believe you received this in error, please contact info@certifiedaustralia.com.au.'
      ) +
      signOff();

    const html = buildEmail(
      body,
      `Thank you — your reference form for ${studentName} has been received.`
    );

    return await sendEmail({
      to: recipientEmail,
      subject: 'Form Submission Confirmation',
      html,
    });
  } catch (err) {
    console.error('[applicationEmailService] sendThirdPartySubmissionConfirmEmail error:', err.message);
    return { success: false };
  }
};

// ---------------------------------------------------------------------------
// 18. sendAdminThirdPartyNotification
// ---------------------------------------------------------------------------

/**
 * Notifies admin/CEO when a third party submits a reference form.
 * @param {string} studentName
 * @param {string} applicationId
 * @param {string} submitterName
 * @param {string} formName
 */
const sendAdminThirdPartyNotification = async (
  studentName,
  applicationId,
  submitterName,
  formName
) => {
  try {
    const reviewUrl = `${BASE_URL}/admin/applications/${applicationId}`;

    const body =
      heading2('Third Party Form Submitted') +
      paragraph(
        `A third party reference form has been submitted for application ` +
        `<strong>${applicationId}</strong>.`
      ) +
      detailsTable('Submission Details', [
        { label: 'Application ID', value: applicationId },
        { label: 'Student', value: studentName },
        { label: 'Form', value: formName },
        { label: 'Submitted By', value: submitterName },
        { label: 'Date & Time', value: formatDateTime(new Date()) },
      ]) +
      buttonGroup({ text: 'Review Submission', url: reviewUrl }) +
      signOff();

    const html = buildEmail(
      body,
      `Third party form submitted for ${applicationId} by ${submitterName}.`
    );

    return await sendEmail({
      to: [ADMIN_EMAIL, CEO_EMAIL],
      subject: `Third Party Form Submitted - ${applicationId}`,
      html,
    });
  } catch (err) {
    console.error('[applicationEmailService] sendAdminThirdPartyNotification error:', err.message);
    return { success: false };
  }
};

// ---------------------------------------------------------------------------
// 19. sendFollowUpScheduledEmail
// ---------------------------------------------------------------------------

/**
 * Sent to student when admin schedules a follow-up call.
 * @param {{ firstName: string, email: string }} student
 * @param {{ applicationId: string }} application
 * @param {Date|string} scheduledDate
 * @param {string} [notes]
 */
const sendFollowUpScheduledEmail = async (
  student,
  application,
  scheduledDate,
  notes
) => {
  try {
    const viewUrl = `${BASE_URL}/student/dashboard`;
    const dateObj = new Date(scheduledDate);

    const body =
      greeting(student.firstName) +
      heading2('Follow-up Call Scheduled') +
      paragraph(
        'Our team has scheduled a follow-up call with you regarding your RPL application. ' +
        'Please ensure you are available at the time shown below.'
      ) +
      detailsTable('Call Details', [
        { label: 'Application ID', value: application.applicationId },
        {
          label: 'Date',
          value: dateObj.toLocaleDateString('en-AU', {
            weekday: 'long',
            day: 'numeric',
            month: 'long',
            year: 'numeric',
          }),
        },
        {
          label: 'Time',
          value: dateObj.toLocaleTimeString('en-AU', {
            hour: '2-digit',
            minute: '2-digit',
          }),
        },
        ...(notes ? [{ label: 'Notes', value: notes }] : []),
      ]) +
      infoCard('Preparation Tips', [
        'Have your application reference number handy: ' + application.applicationId,
        'Think about any questions or concerns you would like to raise.',
        'Be in a quiet environment where you can speak freely.',
        'If you cannot make this time, please contact us as soon as possible to reschedule.',
      ]) +
      buttonGroup({ text: 'View Application', url: viewUrl }) +
      signOff();

    const html = buildEmail(
      body,
      `Follow-up call scheduled for ${formatDate(scheduledDate)}.`
    );

    return await sendEmail({
      to: student.email,
      subject: `Follow-up Call Scheduled - ${application.applicationId}`,
      html,
    });
  } catch (err) {
    console.error('[applicationEmailService] sendFollowUpScheduledEmail error:', err.message);
    return { success: false };
  }
};

// ---------------------------------------------------------------------------
// 20. sendDirectDebitSetupEmail
// ---------------------------------------------------------------------------

/**
 * Sent when a student sets up direct debit on their payment plan.
 * @param {{ firstName: string, email: string }} student
 * @param {{ applicationId: string }} application
 * @param {{ directDebitAccountDetails?: object, installments?: Array, totalAmount?: number }} plan
 */
const sendDirectDebitSetupEmail = async (student, application, plan) => {
  try {
    const paymentsUrl = `${BASE_URL}/student/payments`;
    const details = plan.directDebitAccountDetails || {};
    const installments = plan.installments || [];
    const nextPending = installments.find((i) => i.status === 'pending');

    // Determine frequency label
    let frequency = 'As Scheduled';
    if (installments.length >= 2) {
      const diffMs =
        new Date(installments[1].dueDate) - new Date(installments[0].dueDate);
      const diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24));
      if (diffDays <= 8) frequency = 'Weekly';
      else if (diffDays <= 17) frequency = 'Fortnightly';
      else frequency = 'Monthly';
    }

    const cardLabel = details.cardBrand && details.cardLast4
      ? `${details.cardBrand} ending in ${details.cardLast4}`
      : details.cardLast4
      ? `Card ending in ${details.cardLast4}`
      : 'Card on file';

    const body =
      greeting(student.firstName) +
      successCard(
        'Direct Debit Setup Confirmed',
        `Your direct debit has been successfully set up. ` +
        `Payments will be automatically charged to your card on the scheduled due dates.`
      ) +
      detailsTable('Direct Debit Details', [
        { label: 'Application ID', value: application.applicationId },
        { label: 'Payment Card', value: cardLabel },
        { label: 'Frequency', value: frequency },
        {
          label: 'Next Charge Date',
          value: nextPending ? formatDate(nextPending.dueDate) : '—',
        },
        {
          label: 'Next Charge Amount',
          value: nextPending ? formatAUD(nextPending.amount) : '—',
        },
      ]) +
      divider() +
      smallText(
        'By setting up direct debit you authorise Certified Australia to debit your nominated card ' +
        'for the amounts and dates shown in your payment schedule. You may cancel at any time by ' +
        'contacting our team. Please ensure sufficient funds are available on each due date.'
      ) +
      buttonGroup({ text: 'View Payment Plan', url: paymentsUrl }) +
      signOff();

    const html = buildEmail(
      body,
      `Direct debit confirmed for ${application.applicationId}.`
    );

    return await sendEmail({
      to: student.email,
      subject: `Direct Debit Setup Confirmed - ${application.applicationId}`,
      html,
    });
  } catch (err) {
    console.error('[applicationEmailService] sendDirectDebitSetupEmail error:', err.message);
    return { success: false };
  }
};

// ---------------------------------------------------------------------------
// 21. checkAndSendCompletionEmail  (internal helper)
// ---------------------------------------------------------------------------

/**
 * Internal helper — checks whether SIF, documents, and payment are all complete.
 * If yes, fires #10 and #11.  Returns true if complete, false otherwise.
 *
 * @param {{ _id: string, applicationId: string, intakeFormId?: string, intakeFormSubmitted?: boolean, documentsUploaded?: boolean, paymentCompleted?: boolean, documentIds?: Array, studentId?: string }} application
 * @returns {Promise<boolean>}
 */
const checkAndSendCompletionEmail = async (application) => {
  try {
    // Lazy-require models to avoid circular deps
    const Application = require('../models/Application');
    const IntakeForm   = require('../models/IntakeForm');
    const Document     = require('../models/Document');
    const Payment      = require('../models/Payment');
    const User         = require('../models/User');

    // Re-fetch a fresh copy so we get the latest flags
    const freshApp = await Application.findById(application._id).lean();
    if (!freshApp) return false;

    // --- SIF check ---
    let sifComplete = freshApp.intakeFormSubmitted === true;
    if (!sifComplete && freshApp.intakeFormId) {
      const sif = await IntakeForm.findById(freshApp.intakeFormId).select('status submitted').lean();
      sifComplete = !!(sif && (sif.submitted === true || sif.status === 'submitted'));
    }

    // --- Documents check ---
    let docsComplete = freshApp.documentsUploaded === true;
    if (!docsComplete) {
      const docCount = await Document.countDocuments({
        applicationId: freshApp._id,
        status: { $ne: 'rejected' },
      });
      docsComplete = docCount > 0;
    }

    // --- Payment check ---
    let paymentComplete = freshApp.paymentCompleted === true;
    if (!paymentComplete) {
      const completedPayment = await Payment.findOne({
        applicationId: freshApp._id,
        status: 'completed',
        type: { $in: ['upfront', 'plan', 'manualMarkPaid'] },
      }).lean();
      paymentComplete = !!completedPayment;
    }

    const allComplete = sifComplete && docsComplete && paymentComplete;
    if (!allComplete) return false;

    // Fetch student for emails
    const student = await User.findById(freshApp.studentId)
      .select('firstName lastName email')
      .lean();

    if (!student) {
      console.warn('[applicationEmailService] checkAndSendCompletionEmail: student not found for app', freshApp.applicationId);
      return false;
    }

    // Enrich app object for email templates
    const enrichedApp = {
      ...freshApp,
      intakeFormSubmitted: sifComplete,
      documentsUploaded: docsComplete,
      paymentCompleted: paymentComplete,
    };

    // Fire both emails in parallel — neither should block the other
    await Promise.allSettled([
      sendApplicationCompleteEmail(student, enrichedApp),
      sendRTOApplicationCompleteEmail(student, enrichedApp),
    ]);

    return true;
  } catch (err) {
    console.error('[applicationEmailService] checkAndSendCompletionEmail error:', err.message);
    return false;
  }
};

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  sendWelcomeEmail,
  sendAgentWelcomeEmail,
  sendAdminNewRegistrationEmail,
  sendPaymentReceivedEmail,
  sendAdminPaymentNotification,
  sendPaymentPlanCreatedEmail,
  sendDiscountAppliedEmail,
  sendPaymentPlanStatusEmail,
  sendManualMarkPaidEmail,
  sendApplicationCompleteEmail,
  sendRTOApplicationCompleteEmail,
  sendPaymentFailureEmail,
  sendPaymentOverdueEmail,
  sendDocumentFeedbackEmail,
  sendSupportTicketReplyEmail,
  sendDynamicFormsEnabledEmail,
  sendThirdPartySubmissionConfirmEmail,
  sendAdminThirdPartyNotification,
  sendFollowUpScheduledEmail,
  sendDirectDebitSetupEmail,
  checkAndSendCompletionEmail,
};
