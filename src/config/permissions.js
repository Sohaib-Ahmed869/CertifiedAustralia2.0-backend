/**
 * Master permission configuration.
 * Defines all granular permissions and role defaults.
 */

// All permission keys in the system
const PERMISSION_KEYS = [
  // Navigation tab permissions
  'tab_dashboard',
  'tab_ceo_dashboard',
  'tab_students',
  'tab_applications',
  'tab_archived',
  'tab_qualifications',
  'tab_tasks',
  'tab_tickets',
  'tab_email_templates',
  'tab_users',
  'tab_reports',
  'tab_payments',
  'tab_payment_deadlines',
  'tab_finance',
  'tab_industries',
  'tab_settings',
  'tab_inbox',
  'tab_contacts',
  'tab_register_customer',
  'tab_customers',

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
    tab_applications: true,
    tab_archived: false,
    tab_qualifications: false,
    tab_tasks: true,
    tab_tickets: false,
    tab_email_templates: false,
    tab_users: false,
    tab_reports: false,
    tab_payments: false,
    tab_payment_deadlines: false,
    tab_finance: false,
    tab_industries: false,
    tab_settings: true,
    tab_inbox: true,
    tab_contacts: true,
    tab_register_customer: true,
    tab_customers: true,
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
  },

  InternalRTO: {
    tab_dashboard: true,
    tab_ceo_dashboard: false,
    tab_students: false,
    tab_applications: true,
    tab_archived: false,
    tab_qualifications: false,
    tab_tasks: false,
    tab_tickets: true,
    tab_email_templates: false,
    tab_users: false,
    tab_reports: false,
    tab_payments: false,
    tab_payment_deadlines: false,
    tab_finance: false,
    tab_industries: false,
    tab_settings: true,
    tab_inbox: true,
    tab_contacts: false,
    tab_register_customer: false,
    tab_customers: false,
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
  },

  Support: {
    tab_dashboard: true,
    tab_ceo_dashboard: false,
    tab_students: false,
    tab_applications: false,
    tab_archived: false,
    tab_qualifications: false,
    tab_tasks: false,
    tab_tickets: true,
    tab_email_templates: false,
    tab_users: false,
    tab_reports: false,
    tab_payments: false,
    tab_payment_deadlines: false,
    tab_finance: false,
    tab_industries: false,
    tab_settings: true,
    tab_inbox: true,
    tab_contacts: false,
    tab_register_customer: false,
    tab_customers: false,
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
const getEffectivePermissions = (user) => {
  const roleDefaults = ROLE_DEFAULTS[user.role] || {};
  const overrides = user.permissions instanceof Map
    ? Object.fromEntries(user.permissions)
    : (user.permissions || {});

  return { ...roleDefaults, ...overrides };
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
