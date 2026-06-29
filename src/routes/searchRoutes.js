const express = require('express');
const controller = require('../controllers/searchController');
const { protect } = require('../middleware/auth');

const router = express.Router();

router.use(protect);

router.get('/', controller.globalSearch);

module.exports = router;
