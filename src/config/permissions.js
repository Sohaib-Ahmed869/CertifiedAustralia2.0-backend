/**
 * Master permission configuration.
 * Defines all granular permissions and role defaults.
 */

// All permission keys in the system
const PERMISSION_KEYS = [
  // Navigation tab permissions
  'tab_dashboard',
  'tab_ceo_dashboard',
  // CEO Dashboard sub-tabs (gated individually via RBAC)
  'tab_ceo_overview',
  'tab_ceo_scorecard',
  'tab_ceo_leads',
  'tab_ceo_marketing',
  'tab_ceo_calltracking',
  'tab_ceo_agents',
  'tab_ceo_qualifications',
  'tab_ceo_leadstatus',
  'tab_ceo_cashflow',
  'tab_ceo_liability',
  'tab_ceo_guardrails',
  'tab_students',
  // Applications page hidden — commented out per request, restore to re-enable.
  // 'tab_applications',
  'tab_archived',
  'tab_qualifications',
  'tab_tasks',
  'tab_tickets',
  'tab_email_templates',
  'tab_campaigns',
  'tab_sequences',
  'tab_mailbox_config',
  'tab_users',
  'tab_reports',
  'tab_payments',
  'tab_payment_deadlines',
  'tab_finance',
  'tab_industries',
  'tab_settings',
  'tab_inbox',
  'tab_chat',
  'tab_contacts',
  'tab_register_customer',
  'tab_customers',
  'tab_my_call_scorecard',
  'tab_call_burst',
  'tab_call_tracking',
  'tab_form_management',
  'tab_post_cert_leads',
  'tab_marketing_links',
  'tab_finance_accounts',
  'tab_forecasting',
  'tab_expenses',
  'tab_calendar',
  'tab_rto_invoices',
  'tab_batch_payments',
  'tab_finance_guide',
  'tab_settings_password',
  'tab_settings_calendar',
  'tab_settings_xero',

  // Feature-level permissions
  'feature_assign_agent',
  'feature_assign_rto',
  'feature_update_status',
  'feature_add_notes',
  'feature_manage_payments',
  'feature_create_payment_plan',
  'feature_apply_discount',
  'feature_issue_refund',
  'feature_mark_paid',
  'feature_upload_documents',
  'feature_review_documents',
  'feature_issue_certificate',
  'feature_manage_tasks',
  'feature_create_tasks',
  'feature_manage_users',
  'feature_manage_rbac',
  'feature_manage_qualifications',
  'feature_manage_industries',
  'feature_manage_email_templates',
  'feature_view_financials',
  'feature_view_reports',
  'feature_manage_tickets',
  'feature_archive_applications',
  'feature_restore_applications',
  'feature_manage_expenses',
  'feature_manage_campaigns',
  'feature_manage_rto_invoices',
];

// Default permissions per role
const ROLE_DEFAULTS = {
  Admin: (() => {
    const perms = {};
    PERMISSION_KEYS.forEach((key) => {
      perms[key] = true;
    });
    // Admin doesn't get CEO dashboard by default
    perms.tab_ceo_dashboard = false;
    // Admin doesn't need agent-specific tabs
    perms.tab_contacts = false;
    perms.tab_register_customer = false;
    perms.tab_customers = false;
    return perms;
  })(),

  CEOReportingManager: (() => {
    const perms = {};
    PERMISSION_KEYS.forEach((key) => {
      perms[key] = true;
    });
    // CEO doesn't need agent-specific tabs
    perms.tab_contacts = false;
    perms.tab_register_customer = false;
    perms.tab_customers = false;
    return perms;
  })(),

  Agent: {
    // Tabs
    tab_dashboard: true,
    tab_ceo_dashboard: false,
    tab_students: false,
    // tab_applications: true, // Applications page hidden — commented out per request, restore to re-enable.
    tab_archived: false,
    tab_qualifications: false,
    tab_tasks: true,
    tab_tickets: false,
    tab_email_templates: false,
    tab_campaigns: false,
    tab_mailbox_config: false,
    tab_users: false,
    tab_reports: false,
    tab_payments: false,
    tab_payment_deadlines: false,
    tab_finance: false,
    tab_industries: false,
    tab_settings: true,
    tab_inbox: true,
    tab_chat: true,
    tab_contacts: true,
    tab_register_customer: true,
    tab_customers: true,
    tab_my_call_scorecard: true,
    tab_call_burst: true,
    tab_call_tracking: false,
    tab_form_management: false,
    tab_post_cert_leads: false,
    tab_marketing_links: false,
    tab_finance_accounts: false,
    tab_forecasting: false,
    tab_expenses: false,
    tab_calendar: false,
    tab_rto_invoices: false,
    tab_batch_payments: false,
    tab_settings_password: true,
    tab_settings_calendar: false,
    tab_settings_xero: false,
    // Features
    feature_assign_agent: false,
    feature_assign_rto: false,
    feature_update_status: false,
    feature_add_notes: true,
    feature_manage_payments: false,
    feature_create_payment_plan: false,
    feature_apply_discount: false,
    feature_issue_refund: false,
    feature_mark_paid: false,
    feature_upload_documents: false,
    feature_review_documents: false,
    feature_issue_certificate: false,
    feature_manage_tasks: false,
    feature_create_tasks: false,
    feature_manage_users: false,
    feature_manage_rbac: false,
    feature_manage_qualifications: false,
    feature_manage_industries: false,
    feature_manage_email_templates: false,
    feature_view_financials: false,
    feature_view_reports: false,
    feature_manage_tickets: false,
    feature_archive_applications: false,
    feature_restore_applications: false,
    feature_manage_expenses: false,
    feature_manage_campaigns: false,
    feature_manage_rto_invoices: false,
  },

  InternalRTO: {
    tab_dashboard: true,
    tab_ceo_dashboard: false,
    tab_students: false,
    // tab_applications: true, // Applications page hidden — commented out per request, restore to re-enable.
    tab_archived: false,
    tab_qualifications: false,
    tab_tasks: false,
    tab_tickets: true,
    tab_email_templates: false,
    tab_campaigns: false,
    tab_mailbox_config: false,
    tab_users: false,
    tab_reports: false,
    tab_payments: false,
    tab_payment_deadlines: false,
    tab_finance: false,
    tab_industries: false,
    tab_settings: true,
    tab_inbox: true,
    tab_chat: true,
    tab_contacts: false,
    tab_register_customer: false,
    tab_customers: false,
    tab_form_management: false,
    tab_post_cert_leads: false,
    tab_marketing_links: false,
    tab_finance_accounts: false,
    tab_forecasting: false,
    tab_expenses: false,
    tab_calendar: false,
    tab_rto_invoices: false,
    tab_batch_payments: false,
    tab_settings_password: true,
    tab_settings_calendar: false,
    tab_settings_xero: false,
    feature_assign_agent: false,
    feature_assign_rto: false,
    feature_update_status: true,
    feature_add_notes: true,
    feature_manage_payments: false,
    feature_create_payment_plan: false,
    feature_apply_discount: false,
    feature_issue_refund: false,
    feature_mark_paid: false,
    feature_upload_documents: false,
    feature_review_documents: true,
    feature_issue_certificate: false,
    feature_manage_tasks: false,
    feature_create_tasks: false,
    feature_manage_users: false,
    feature_manage_rbac: false,
    feature_manage_qualifications: false,
    feature_manage_industries: false,
    feature_manage_email_templates: false,
    feature_view_financials: false,
    feature_view_reports: false,
    feature_manage_tickets: false,
    feature_archive_applications: false,
    feature_restore_applications: false,
    feature_manage_expenses: false,
    feature_manage_campaigns: false,
    feature_manage_rto_invoices: false,
  },

  Support: {
    tab_dashboard: true,
    tab_ceo_dashboard: false,
    tab_students: false,
    // tab_applications: false, // Applications page hidden — commented out per request, restore to re-enable.
    tab_archived: false,
    tab_qualifications: false,
    tab_tasks: false,
    tab_tickets: true,
    tab_email_templates: false,
    tab_campaigns: false,
    tab_mailbox_config: false,
    tab_users: false,
    tab_reports: false,
    tab_payments: false,
    tab_payment_deadlines: false,
    tab_finance: false,
    tab_industries: false,
    tab_settings: true,
    tab_inbox: true,
    tab_chat: true,
    tab_contacts: false,
    tab_register_customer: false,
    tab_customers: false,
    tab_form_management: false,
    tab_post_cert_leads: false,
    tab_marketing_links: false,
    tab_finance_accounts: false,
    tab_forecasting: false,
    tab_expenses: false,
    tab_calendar: false,
    tab_rto_invoices: false,
    tab_batch_payments: false,
    tab_settings_password: true,
    tab_settings_calendar: false,
    tab_settings_xero: false,
    feature_assign_agent: false,
    feature_assign_rto: false,
    feature_update_status: false,
    feature_add_notes: false,
    feature_manage_payments: false,
    feature_create_payment_plan: false,
    feature_apply_discount: false,
    feature_issue_refund: false,
    feature_mark_paid: false,
    feature_upload_documents: false,
    feature_review_documents: false,
    feature_issue_certificate: false,
    feature_manage_tasks: false,
    feature_create_tasks: false,
    feature_manage_users: false,
    feature_manage_rbac: false,
    feature_manage_qualifications: false,
    feature_manage_industries: false,
    feature_manage_email_templates: false,
    feature_view_financials: false,
    feature_view_reports: false,
    feature_manage_tickets: true,
    feature_archive_applications: false,
    feature_restore_applications: false,
    feature_manage_expenses: false,
    feature_manage_campaigns: false,
    feature_manage_rto_invoices: false,
  },

  Marketing: {
    tab_dashboard: true,
    tab_marketing_links: true,
    tab_ceo_dashboard: false,
    // Marketing can reach the CEO dashboard's marketing-relevant sub-tabs
    tab_ceo_overview: true,
    tab_ceo_leads: true,
    tab_ceo_marketing: true,
    // tab_applications: false, // Applications page hidden — commented out per request, restore to re-enable.
    tab_students: false,
    tab_users: false,
    tab_inbox: true,
    tab_chat: true,
    tab_settings: true,
    tab_settings_password: true,
    // NOTE: keep every key here inside PERMISSION_KEYS above. `getDefaults` ships
    // this object straight to the Add User wizard, and the PATCH endpoint rejects
    // the entire payload if it contains a key the list doesn't know.
  },

  Student: {
    // Students don't go through RBAC — their portal is always fully accessible
  },

  ExternalRTO: {
    // External RTOs don't log into the portal
  },
};

/**
 * Returns the effective permissions for a user.
 * Merges role defaults with any per-user overrides.
 */
// Tabs that come with operating as a sales agent, regardless of the user's base
// role. Granted on top of role defaults when `user.isSalesAgent` is true, so a
// higher-role staffer (Admin/CEO) who also sells still gets the agent workspace
// (call scorecard, call burst, customers, contacts, register customer). Explicit
// per-user overrides still win, so any of these can be individually revoked.
const AGENT_CAPABILITY_PERMISSIONS = [
  'tab_my_call_scorecard',
  'tab_call_burst',
  'tab_customers',
  'tab_register_customer',
  'tab_contacts',
];

const getEffectivePermissions = (user) => {
  const roleDefaults = ROLE_DEFAULTS[user.role] || {};
  const agentGrants = user.isSalesAgent
    ? Object.fromEntries(AGENT_CAPABILITY_PERMISSIONS.map((key) => [key, true]))
    : {};
  const overrides = user.permissions instanceof Map
    ? Object.fromEntries(user.permissions)
    : (user.permissions || {});

  return { ...roleDefaults, ...agentGrants, ...overrides };
};

/**
 * Validates that all keys in a permissions object are valid.
 */
const validatePermissionKeys = (permissions) => {
  const invalid = Object.keys(permissions).filter(
    (key) => !PERMISSION_KEYS.includes(key)
  );
  return invalid;
};

module.exports = {
  PERMISSION_KEYS,
  ROLE_DEFAULTS,
  getEffectivePermissions,
  validatePermissionKeys,
};
