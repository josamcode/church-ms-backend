const express = require('express');
const router = express.Router();
const settingsController = require('./settings.controller');

// ═══════ عام (بدون مصادقة) ═══════

router.get('/public/site', settingsController.getPublicSite);

module.exports = router;
