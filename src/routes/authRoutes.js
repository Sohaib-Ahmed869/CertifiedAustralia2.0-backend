const express = require('express');
const authController = require('../controllers/authController');
const { protect } = require('../middleware/auth');

const router = express.Router();

// Public
router.post('/register', authController.register);
router.post('/login', authController.login);
router.post('/verify-mfa', authController.verifyMfa);
router.post('/forgot-password', authController.forgotPassword);
router.post('/reset-password', authController.resetPassword);

// Protected
router.get('/me', protect, authController.getMe);
router.patch('/change-password', protect, authController.changePassword);
router.post('/mfa/setup', protect, authController.setupMfa);
router.post('/mfa/confirm', protect, authController.confirmMfa);
router.post('/mfa/disable', protect, authController.disableMfa);

module.exports = router;
