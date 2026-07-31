/**
 * Shared pricing constants.
 *
 * Kept in one place because the signup discount is written at registration
 * (authService), reported in the welcome email (applicationEmailService) and
 * checked when an admin adds a further discount (applicationService).
 */

// Automatic discount applied to every application at registration.
const SIGNUP_DISCOUNT_AMOUNT = 500;

module.exports = {
  SIGNUP_DISCOUNT_AMOUNT,
};
